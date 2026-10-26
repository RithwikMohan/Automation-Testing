import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import { validateActionPlan } from './actionRegistry.mjs'
import { resolveWorkflowLocator } from '../workflows/locatorResolution.mjs'
import { resolveContextualCell } from '../workflows/contextualTarget.mjs'
import { chromium } from 'playwright'
import { createSecurityProxy, isApprovedWritePostAllowed, isApprovedWorkflowPostbackAllowed, isManualLoginPostAllowed, normalizeAllowedOrigin } from '../exploration/networkSecurity.mjs'
import {
  getBrowserTestCaseById,
  persistBrowserTestArtifact,
  persistBrowserTestStepResult,
  updateBrowserTestExecution,
} from '../database.mjs'

const resumeControls = new Map()
const cancellationControls = new Map()
// Authenticated state is held only in worker memory, never in PostgreSQL or logs.
// The user must explicitly opt in before a later execution can reuse it.
const approvedSessionStates = new Map()
const MAX_EXECUTION_MS = 120_000
const AUTH_STATE_TTL_MS = 15 * 60_000

export function rememberApprovedBrowserSession(applicationId, state) {
  if (typeof applicationId !== 'string' || !state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) return false
  for (const [key, entry] of approvedSessionStates) if (entry.expiresAt <= Date.now()) approvedSessionStates.delete(key)
  approvedSessionStates.set(applicationId, { state, expiresAt: Date.now() + AUTH_STATE_TTL_MS })
  return true
}

export class BrowserTestError extends Error {
  constructor(code, message, status = 'FAILED') {
    super(message)
    this.name = 'BrowserTestError'
    this.code = code
    this.status = status
  }
}

function safeText(value, testData = {}) {
  let result = String(value ?? '').slice(0, 2000)
  for (const item of Object.values(testData)) {
    if (typeof item === 'string' && item.length > 0) result = result.split(item).join('[redacted]')
  }
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted-token]')
    .replace(/\b(?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;&]+/gi, '[redacted-sensitive-value]')
    .replace(/([?&](?:password|passwd|pwd|token|access_token|refresh_token|session|sessionid|sid|cookie)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"']+/gi, (raw) => {
      try { const url = new URL(raw); return url.origin + url.pathname.replace(/\/(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{40,})(?=\/|$)/g, '/[redacted]') } catch { return '[redacted-url]' }
    })
}

function buildLocator(page, spec) {
  if (spec.kind === 'role') return page.getByRole(spec.role, { name: spec.name, exact: true })
  if (spec.kind === 'text') return page.getByText(spec.value, { exact: true })
  if (spec.kind === 'label') return page.getByLabel(spec.value, { exact: true })
  if (spec.kind === 'placeholder') return page.getByPlaceholder(spec.value, { exact: true })
  if (spec.kind === 'testid') return page.getByTestId(spec.value)
  if (spec.kind === 'css') return page.locator(spec.value)
  if (spec.kind === 'xpath') return page.locator(`xpath=${spec.value}`)
  if (spec.kind === 'id') return page.locator(`#${String(spec.value).replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`)
  if (spec.kind === 'name') return page.locator(`[name="${String(spec.value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`)
  throw new BrowserTestError('UNSUPPORTED_LOCATOR', 'The saved plan contains an unsupported locator.', 'BLOCKED')
}

async function uniqueLocator(page, spec) {
  const locator = buildLocator(page, spec)
  const count = await locator.count()
  if (count !== 1) throw new BrowserTestError(count === 0 ? 'LOCATOR_NOT_FOUND' : 'AMBIGUOUS_LOCATOR', count === 0 ? 'The locator did not match a visible element.' : 'The locator matched more than one element.')
  return locator
}

async function retryLocatorResolutionDuringNavigation(page, resolve, timeoutMs) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 100)
  let attempt = 0
  while (true) {
    try { return await resolve() }
    catch (error) {
      const transientNavigation = /execution context was destroyed|most likely because of a navigation|frame was detached|cannot find context with specified id/i.test(String(error?.message || error))
      if (!transientNavigation || attempt >= 2 || Date.now() >= deadline || page.isClosed()) throw error
      attempt += 1
      const remaining = Math.max(100, deadline - Date.now())
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(remaining, 3000) }).catch(() => {})
      await page.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now()))).catch(() => {})
    }
  }
}

async function uniqueActionLocator(page, action, timeoutMs = 0, testData = {}) {
  if (action.contextualTarget) {
    try { return (await retryLocatorResolutionDuringNavigation(page, () => resolveContextualCell(page, action.contextualTarget, testData), timeoutMs)).locator }
    catch (error) { throw new BrowserTestError(error.code || 'CONTEXT_TARGET_NOT_FOUND', error.message || 'The configured contextual target could not be resolved.') }
  }
  if (Array.isArray(action.locatorCandidates) && action.locatorCandidates.length) {
    try { return (await retryLocatorResolutionDuringNavigation(page, () => resolveWorkflowLocator(page, action, { timeoutMs }), timeoutMs)).locator }
    catch (error) {
      const currentPage = safePageUrl(page)
      const capturedPage = action.pageUrl ? safePageUrl({ url: () => action.pageUrl }) : ''
      const pageContext = capturedPage && currentPage
        ? capturedPage === currentPage ? ` Captured page: ${capturedPage}.` : ` Captured page: ${capturedPage}; current page: ${currentPage}.`
        : currentPage ? ` Current page: ${currentPage}.` : ''
      throw new BrowserTestError(error.code || 'LOCATOR_NOT_FOUND', (error.message || 'No captured locator matched the target element.') + pageContext)
    }
  }
  return uniqueLocator(page, action.locator)
}

function locatorDescription(spec) {
  return spec.kind + (spec.name ? ':' + spec.name : spec.value ? ':' + spec.value : '')
}

function safePageUrl(page) {
  try {
    const url = new URL(page.url())
    const path = url.pathname.replace(/\/(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{40,})(?=\/|$)/g, '/[redacted]')
    return url.origin + path
  } catch { return '' }
}

function safeDiagnosticUrl(raw) {
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{24,})(?=\/|$)/g, '/[redacted]')
    return { origin: url.origin, path }
  } catch { return { origin: null, path: null } }
}

function isMainFrameNavigation(request, page) {
  try { return request.isNavigationRequest() && request.frame() === page.mainFrame() } catch { return false }
}

async function maskInputsForScreenshot(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.value) element.value = '••••••'
      } else if (element instanceof HTMLElement && element.innerText) {
        element.innerText = '••••••'
      }
    }
  }).catch(() => {})
}

async function saveArtifact({ executionId, kind, sourcePath, bytes, contentType, outputDirectory, artifactBase }) {
  const extension = kind === 'screenshot' ? '.png' : kind === 'video' ? '.webm' : kind === 'trace' ? '.zip' : '.json'
  const fileName = kind + '-' + randomUUID() + extension
  const destination = resolve(outputDirectory, fileName)
  if (sourcePath) await rename(sourcePath, destination)
  else await writeFile(destination, bytes)
  const fileInfo = await stat(destination)
  const relativePath = relative(artifactBase, destination).split(sep).join('/')
  const row = await persistBrowserTestArtifact({
    id: 'bta-' + randomUUID(),
    executionId,
    kind,
    relativePath,
    contentType,
    sizeBytes: fileInfo.size,
  })
  return row
}

async function waitForManualLogin(executionId, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      resumeControls.delete(executionId)
      reject(new BrowserTestError('MANUAL_LOGIN_TIMEOUT', 'Manual login was not resumed before the five-minute limit.', 'BLOCKED'))
    }, timeoutMs)
    resumeControls.set(executionId, () => {
      clearTimeout(timer)
      resumeControls.delete(executionId)
      resolvePromise()
    })
  })
}

export function resumeBrowserTestAfterLogin(executionId) {
  const resume = resumeControls.get(executionId)
  if (!resume) return false
  resume()
  return true
}

export function cancelBrowserTestExecution(executionId) {
  const control = cancellationControls.get(executionId)
  if (!control) return false
  control.cancelled = true
  control.page?.close().catch(() => {})
  resumeControls.get(executionId)?.()
  return true
}

export async function executeBrowserTest(executionId, options = {}) {
  const startedAt = new Date()
  const startedMs = Date.now()
  const runId = executionId.id
  const actionTimeoutMs = Math.min(60_000, Math.max(1_000, Number(options.defaultTimeoutMs) || 10_000))
  const navigationTimeoutMs = actionTimeoutMs
  const recordVideoRequested = options.recordVideo !== false && options.recordArtifacts !== false
  const recordingPolicy = options.recordingPolicy === 'disabled' ? 'disabled' : 'mask-form-values'
  const reuseAuthenticatedSession = options.reuseAuthenticatedSession === true
  const control = options.control || { cancelled: false, page: null }
  cancellationControls.set(runId, control)
  const throwIfCancelled = () => {
    if (control.cancelled) throw new BrowserTestError('USER_CANCELLED', 'Execution was cancelled by the user.', 'CANCELLED')
  }
  let browser
  let context
  let page
  let proxy
  let traceStarted = false
  let traceSensitive = false
  let manualAuthActive = false
  const manualAuthPaths = new Set()
  const manualAuthOrigins = new Set()
  let activeWriteAuthorization = null
  let activeWorkflowPostback = null
  let policyBlock = null
  let stepNumber = 0
  let videoPath
  let videoPersisted = false
  let safeRecording = recordVideoRequested && recordingPolicy !== 'disabled'
  let videoStatus = safeRecording ? 'PENDING' : 'NOT_REQUESTED'
  let videoError = safeRecording ? null : recordVideoRequested ? 'Recording was disabled for this test by its recording policy.' : 'Recording was disabled for this test.'
  let tracePath
  let outputDirectory
  let artifactBase
  let testData = {}
  const policyWarnings = []
  const diagnostics = []
  const recordDiagnostic = (item) => { if (diagnostics.length < 100) diagnostics.push(item) }
  let remoteHttpError = null
  const recordPolicyWarning = (code, hostname, category, topLevelNavigation) => {
    policyWarnings.push({ reasonCode: code, hostname: hostname || null, category, topLevelNavigation: Boolean(topLevelNavigation) })
    if (topLevelNavigation) policyBlock = { code, hostname: hostname || null }
  }
  const stepResults = []

  try {
    throwIfCancelled()
    const testCase = await getBrowserTestCaseById(executionId.caseId || executionId)
    if (!testCase) throw new BrowserTestError('CASE_NOT_FOUND', 'The registered browser test case no longer exists.', 'BLOCKED')
    const app = testCase
    testData = testCase.test_data || {}
    if (app.application_auth_method === 'credential_reference') throw new BrowserTestError('CREDENTIAL_PROVIDER_UNAVAILABLE', 'This application uses a credential reference, but no vault provider is configured for browser tests.', 'BLOCKED')
    if (app.application_status !== 'Active') throw new BrowserTestError('APPLICATION_ARCHIVED', 'The registered application is not active.', 'BLOCKED')
    const plan = testCase.plan
    try { validateActionPlan(plan, testData) } catch (error) { throw new BrowserTestError(error.code || 'INVALID_PLAN', error.message, 'BLOCKED') }
    const planHasCsvCredentials = plan.actions.some((action) => action.credentialInput === true)
    if (planHasCsvCredentials && app.application_auth_method !== 'manual') throw new BrowserTestError('INVALID_PLAN', 'CSV credential login steps require the application to use manual authentication.', 'BLOCKED')
    if (plan.actions.some((action) => ['create', 'update', 'delete'].includes(action.action) && (action.requiresApproval !== true || action.requiresWriteApproval !== true))) {
      throw new BrowserTestError('INVALID_PLAN', 'Every saved write action must carry explicit interactive and write approval requirements.', 'BLOCKED')
    }
    if (plan.actions.some((action) => action.requiresApproval) && !executionId.approvedInteractions) throw new BrowserTestError('APPROVAL_REQUIRED', 'This plan contains interactive actions and needs explicit run approval.', 'BLOCKED')
    if (plan.actions.some((action) => ['create', 'update', 'delete'].includes(action.action)) && options.allowWrites !== true) {
      throw new BrowserTestError('WRITE_MODE_REQUIRED', 'This test contains write actions. Enable writes and approve the reviewed form actions for this run.', 'BLOCKED')
    }

    const appUrl = new URL(app.application_base_url)
    const loginUrl = app.application_login_url || app.application_base_url
    const loginOrigin = normalizeAllowedOrigin(new URL(loginUrl).origin)
    manualAuthOrigins.add(loginOrigin)
    const navOrigins = new Set([normalizeAllowedOrigin(appUrl.origin), ...(app.approved_navigation_origins || []).map(normalizeAllowedOrigin)])
    if (!navOrigins.has(loginOrigin)) throw new BrowserTestError('LOGIN_ORIGIN_BLOCKED', 'The registered login URL origin is not an approved navigation origin.', 'BLOCKED')
    const resourceOrigins = new Set([normalizeAllowedOrigin(appUrl.origin), ...(app.approved_resource_origins || []).map(normalizeAllowedOrigin)])
    const internalOrigins = [appUrl.origin, ...(app.approved_navigation_origins || []), ...(app.approved_resource_origins || [])]

    const configuredArtifact = resolve(options.artifactRoot || process.env.ARTIFACT_DIR || 'backend/artifacts')
    artifactBase = resolve(configuredArtifact, 'browser-tests')
    outputDirectory = resolve(artifactBase, runId)
    await mkdir(outputDirectory, { recursive: true })

    throwIfCancelled()
    proxy = await createSecurityProxy({
      allowedHost: appUrl.hostname,
      primaryOrigin: appUrl.origin,
      navigationOrigins: [...navOrigins].filter((origin) => origin !== normalizeAllowedOrigin(appUrl.origin)),
      resourceOrigins: [...resourceOrigins].filter((origin) => origin !== normalizeAllowedOrigin(appUrl.origin)),
      allowPublicOrigins: true,
      internalOrigins,
      manualAuthOrigin: loginOrigin,
      manualAuthOrigins,
      manualAuthPaths,
      isManualAuthActive: () => manualAuthActive,
      isApprovedWriteRequest: (request) => isApprovedWritePostAllowed({ ...request, authorization: activeWriteAuthorization }),
      isApprovedWorkflowPostback: (request) => isApprovedWorkflowPostbackAllowed({ ...request, authorization: activeWorkflowPostback }),
      dnsLookup: options.dnsLookup,
      testTargetIp: options.testTargetIp,
      testTargetPort: options.testTargetPort,
      connectTimeoutMs: 8000,
      onSecurityViolation: (event) => {
        const host = String(event.hostname || '').toLowerCase().replace(/\.$/, '')
        const isMainHost = host === appUrl.hostname.toLowerCase().replace(/\.$/, '')
        recordPolicyWarning(event.type || 'SECURITY_POLICY_BLOCKED', host, 'network', isMainHost)
        recordDiagnostic({ type: 'outbound_request_blocked', stage: event.stage || 'proxy_destination_validation', blockingComponent: 'Chronos outbound security proxy', hostname: host || null, reasonCode: event.type || 'SECURITY_POLICY_BLOCKED', reason: safeText(event.reason || 'Outbound destination was rejected by network policy.', testData) })
      },
    })
    throwIfCancelled()
    const cachedAuth = reuseAuthenticatedSession && !planHasCsvCredentials ? approvedSessionStates.get(String(app.application_id)) : null
    const cachedStorageState = cachedAuth && cachedAuth.expiresAt > Date.now() ? cachedAuth.state : undefined
    if (cachedAuth && !cachedStorageState) approvedSessionStates.delete(String(app.application_id))
    browser = await chromium.launch({
      headless: typeof options.headless === 'boolean' ? options.headless : app.application_auth_method === 'manual' && !cachedStorageState ? false : process.env.HEADLESS !== 'false',
      timeout: 20_000,
      proxy: { server: proxy.proxyUrl, bypass: '<-loopback>' },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-quic', '--dns-prefetch-disable', '--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-bypass-list=<-loopback>', '--proxy-server=' + proxy.proxyUrl],
    })
    context = await browser.newContext({
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
      ...(cachedStorageState ? { storageState: cachedStorageState } : {}),
      ...(safeRecording ? { recordVideo: { dir: outputDirectory } } : {}),
    })
    if (safeRecording && recordingPolicy === 'mask-form-values') {
      await context.addInitScript(() => {
        const installMask = () => {
          if (!document.documentElement) return
          if (!document.getElementById('chronos-video-mask')) {
            const style = document.createElement('style')
            style.id = 'chronos-video-mask'
            style.textContent = `input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select, [contenteditable="true"] { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; text-shadow: none !important; } input::placeholder, textarea::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; }`
            document.documentElement.appendChild(style)
          }
          for (const element of document.querySelectorAll('input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select, [contenteditable="true"]')) {
            for (const [property, value] of [['color', 'transparent'], ['-webkit-text-fill-color', 'transparent'], ['caret-color', 'transparent'], ['text-shadow', 'none']]) {
              if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== 'important') element.style.setProperty(property, value, 'important')
            }
          }
        }
        installMask()
        new MutationObserver(installMask).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
      })
    }
    page = await context.newPage()
    control.page = page
    throwIfCancelled()
    await context.route('**/*', async (route) => {
      const request = route.request()
      let parsed
      try { parsed = new URL(request.url()) } catch {
        const main = isMainFrameNavigation(request, page)
        if (main) policyBlock = { code: 'INVALID_REQUEST_URL' }
        recordDiagnostic({ type: 'request_blocked', stage: main ? 'main_document' : 'subresource', blockingComponent: 'Chronos Playwright request policy', reasonCode: 'INVALID_REQUEST_URL', method: request.method(), resourceType: request.resourceType(), isMainFrameNavigation: main, reason: 'The request URL was malformed.' })
        return route.abort('blockedbyclient')
      }
      if (traceStarted && [...parsed.searchParams.keys()].some((key) => /password|passwd|pwd|token|session|cookie|authorization|secret/i.test(key))) traceSensitive = true
      if (traceStarted) {
        const headers = await request.allHeaders().catch(() => ({}))
        if (headers.cookie || headers.authorization || headers['proxy-authorization']) traceSensitive = true
      }
      const isMainNavigation = isMainFrameNavigation(request, page)
      try { normalizeAllowedOrigin(parsed.origin) } catch {
        if (isMainNavigation) policyBlock = { code: 'INVALID_DESTINATION' }
        recordDiagnostic({ type: 'request_blocked', stage: isMainNavigation ? 'main_document' : 'subresource', blockingComponent: 'Chronos Playwright request policy', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), reasonCode: 'INVALID_DESTINATION', method: request.method(), resourceType: request.resourceType(), isMainFrameNavigation: isMainNavigation, reason: 'Destination hostname is prohibited by the local-address policy.' })
        return route.abort('blockedbyclient')
      }
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      if (port !== 80 && port !== 443) {
        recordPolicyWarning('PORT_BLOCKED', parsed.hostname, request.resourceType(), isMainNavigation)
        recordDiagnostic({ type: 'request_blocked', stage: isMainNavigation ? 'main_document' : 'subresource', blockingComponent: 'Chronos Playwright request policy', reasonCode: 'PORT_BLOCKED', method: request.method(), ...safeDiagnosticUrl(request.url()), resourceType: request.resourceType(), isMainFrameNavigation: isMainNavigation, reason: 'Only standard web ports 80 and 443 are allowed.' })
        return route.abort('blockedbyclient')
      }
      const method = request.method()
      // In a credential-backed manual-auth workflow, the reviewed login steps
      // themselves perform the sign-in. Record each top-level HTTP(S) origin as
      // it is visited so an IdP redirect can submit only after its GET navigation
      // was observed during the active login sequence.
      if (manualAuthActive && ['GET', 'HEAD'].includes(method) && request.isNavigationRequest()) {
        try { manualAuthOrigins.add(normalizeAllowedOrigin(parsed.origin)) } catch {}
      }
      const contentType = method === 'POST' ? await request.headerValue('content-type').catch(() => null) : null
      const accessControlRequestMethod = method === 'OPTIONS' ? await request.headerValue('access-control-request-method').catch(() => null) : null
      const isManualLoginPost = isManualLoginPostAllowed({
        method,
        targetUrl: parsed,
        contentType,
        accessControlRequestMethod,
        manualAuthOrigin: loginOrigin,
        manualAuthOrigins,
        manualAuthPaths,
        isManualAuthActive: () => manualAuthActive,
      })
      const isApprovedWritePost = isApprovedWritePostAllowed({ method, targetUrl: parsed, contentType, authorization: activeWriteAuthorization })
      const isApprovedPostback = request.isNavigationRequest() && request.resourceType() === 'document' && isApprovedWorkflowPostbackAllowed({ method, targetUrl: parsed, contentType, authorization: activeWorkflowPostback })
      if (method !== 'GET' && method !== 'HEAD' && !isManualLoginPost && !isApprovedWritePost && !isApprovedPostback) {
        recordPolicyWarning('READ_ONLY_METHOD_BLOCKED', parsed.hostname, request.resourceType(), isMainNavigation)
        recordDiagnostic({ type: 'request_blocked', stage: isMainNavigation ? 'main_document' : 'subresource', blockingComponent: 'Chronos read-only request policy', reasonCode: 'READ_ONLY_METHOD_BLOCKED', method, ...safeDiagnosticUrl(request.url()), resourceType: request.resourceType(), isMainFrameNavigation: isMainNavigation, reason: 'Chronos blocked this non-GET/HEAD request under the read-only policy.' })
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    page.on('response', (response) => {
      const request = response.request()
      const mainNavigation = isMainFrameNavigation(request, page)
      if (traceStarted && response.headers()['set-cookie']) traceSensitive = true
      const responseUrl = safeDiagnosticUrl(response.url())
      const proxyRejected = diagnostics.some((item) => item.type === 'outbound_request_blocked' && item.hostname === responseUrl.origin?.replace(/^https?:\/\//, '').toLowerCase().replace(/:\d+$/, ''))
      if (response.status() >= 400 || mainNavigation) recordDiagnostic({ type: mainNavigation ? 'navigation_response' : 'http_response', stage: mainNavigation ? 'main_document' : 'subresource', responseSource: proxyRejected ? 'Chronos outbound security proxy' : 'remote website', method: request.method(), ...responseUrl, status: response.status(), resourceType: request.resourceType(), isMainFrameNavigation: mainNavigation })
      if (response.status() >= 400 && mainNavigation) {
        remoteHttpError = { status: response.status(), hostname: (() => { try { return new URL(response.url()).hostname } catch { return null } })() }
      }
    })
    page.on('console', (message) => {
      if (message.type() === 'error') recordDiagnostic({ type: 'console_error', message: safeText(message.text(), testData) })
    })
    page.on('pageerror', (error) => recordDiagnostic({ type: 'page_error', name: error.name, message: safeText(error.message, testData) }))
    const captureManualAuthForms = async () => {
      if (!manualAuthActive || !page || page.isClosed()) return
      let paths
      try {
        paths = await retryLocatorResolutionDuringNavigation(page, () => page.locator('form').evaluateAll((forms) => forms
          .filter((form) => form.method.toUpperCase() === 'POST')
          .map((form) => {
            try {
              const action = new URL(form.action, location.href)
              return action.origin === location.origin ? action.pathname : null
            } catch { return null }
          })
          .filter(Boolean)), 4000)
      } catch (error) {
        if (/execution context was destroyed|most likely because of a navigation|frame was detached|cannot find context with specified id/i.test(String(error?.message || error))) return
        throw error
      }
      let pageOrigin
      try {
        const currentUrl = new URL(page.url())
        if (!['http:', 'https:'].includes(currentUrl.protocol)) return
        pageOrigin = normalizeAllowedOrigin(currentUrl.origin)
      } catch {
        // Redirects can briefly expose an opaque URL while the identity page is
        // changing documents. It is not an origin to add to the auth allowlist.
        return
      }
      manualAuthOrigins.add(pageOrigin)
      for (const path of paths) manualAuthPaths.add(pageOrigin + path)
    }
    page.on('domcontentloaded', () => { captureManualAuthForms().catch(() => {}) })
    page.on('requestfailed', (request) => {
      const failure = safeText(request.failure()?.errorText || 'Request failed.', testData)
      const safeUrl = safeDiagnosticUrl(request.url())
      const chronosAborted = failure.includes('ERR_BLOCKED_BY_CLIENT') && diagnostics.some((item) => item.type === 'request_blocked' && item.method === request.method() && item.origin === safeUrl.origin && item.path === safeUrl.path)
      const networkError = /ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_(RESET|REFUSED|TIMED_OUT)|TIMED_OUT|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/i.exec(failure)?.[0] || null
      recordDiagnostic({
        type: 'request_failed', stage: isMainFrameNavigation(request, page) ? 'main_document' : 'subresource',
        failureSource: chronosAborted ? 'Chronos request policy' : networkError ? 'browser_or_network_transport' : 'browser_request',
        reasonCode: chronosAborted ? 'REQUEST_BLOCKED_BY_CHRONOS_POLICY' : networkError || (failure.includes('ERR_ABORTED') ? 'REQUEST_ABORTED' : 'REQUEST_FAILED'),
        method: request.method(), ...safeUrl, isMainFrameNavigation: isMainFrameNavigation(request, page),
        resourceType: request.resourceType(), error: failure,
      })
    })

    throwIfCancelled()
    await updateBrowserTestExecution(runId, { status: 'RUNNING', startedAt })
    // The login page may issue identity-provider requests while it loads. Enable
    // the tightly scoped manual-auth policy before navigating when the saved plan
    // contains an explicitly reviewed password CSV field.
    if (app.application_auth_method === 'manual' && planHasCsvCredentials && !cachedStorageState) manualAuthActive = true
    const initialResponse = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
    if (initialResponse && initialResponse.status() >= 400) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + initialResponse.status() + '.', 'FAILED')
    if (app.application_auth_method === 'manual' && !cachedStorageState) {
      manualAuthActive = true
      await captureManualAuthForms()
      if (!planHasCsvCredentials) {
        await updateBrowserTestExecution(runId, { actualOutcome: 'Waiting for user to complete manual login and resume the test.' })
        await waitForManualLogin(runId, 300_000)
        manualAuthActive = false
        const currentOrigin = normalizeAllowedOrigin(new URL(page.url()).origin)
        if (!navOrigins.has(currentOrigin)) throw new BrowserTestError('LOGIN_ORIGIN_BLOCKED', 'After manual login, the browser was outside approved application navigation origins.', 'BLOCKED')
        const stillHasPasswordField = await page.locator('input[type="password"]').count().catch(() => 0)
        if (stillHasPasswordField && new URL(page.url()).pathname === new URL(loginUrl).pathname) throw new BrowserTestError('AUTHENTICATION_NOT_CONFIRMED', 'The login page is still active after manual confirmation.', 'BLOCKED')
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
        if (reuseAuthenticatedSession) {
          const approvedState = await context.storageState()
          for (const [key, entry] of approvedSessionStates) if (entry.expiresAt <= Date.now()) approvedSessionStates.delete(key)
          approvedSessionStates.set(String(app.application_id), { state: approvedState, expiresAt: Date.now() + AUTH_STATE_TTL_MS })
        }
      }
    } else if (app.application_auth_method === 'manual' && cachedStorageState) {
      const currentOrigin = normalizeAllowedOrigin(new URL(page.url()).origin)
      if (!navOrigins.has(currentOrigin)) throw new BrowserTestError('AUTHENTICATED_SESSION_INVALID', 'The approved authenticated session did not reach a registered application origin.', 'BLOCKED')
      if (await page.locator('input[type="password"]').count().catch(() => 0)) {
        approvedSessionStates.delete(String(app.application_id))
        throw new BrowserTestError('AUTHENTICATED_SESSION_EXPIRED', 'The approved authenticated session has expired; complete manual login again.', 'BLOCKED')
      }
    }

    if (safeRecording) {
      await context.tracing.start({ screenshots: false, snapshots: false, sources: false })
      traceStarted = true
    }

    for (const action of plan.actions) {
      throwIfCancelled()
      if (Date.now() - startedMs > MAX_EXECUTION_MS) throw new BrowserTestError('EXECUTION_TIMEOUT', 'The browser test exceeded its two-minute execution limit.')
      stepNumber += 1
      const stepStarted = new Date()
      const stepStartedMs = Date.now()
      let actual
      let expected
      try {
        if (action.action === 'navigate') {
          const target = new URL(action.url)
          if (!['http:', 'https:'].includes(target.protocol)) throw new BrowserTestError('NAVIGATION_ORIGIN_BLOCKED', 'Navigation must use HTTP or HTTPS.', 'BLOCKED')
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
          if (remoteHttpError) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + remoteHttpError.status + '.', 'FAILED')
          actual = { url: safePageUrl(page) }
          expected = { url: action.url }
        } else if (action.action === 'click') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          if (action.postbackAuthorization) {
            const auth = action.postbackAuthorization
            if (!navOrigins.has(normalizeAllowedOrigin(auth.origin))) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The captured form postback origin is outside the selected registered application navigation scope.', 'BLOCKED')
            const form = await locator.evaluate((element) => {
              const owner = element.form || element.closest('form')
              if (!owner || owner.method.toUpperCase() !== 'POST') return null
              try { const target = new URL(owner.action, location.href); return { origin: target.origin, path: target.pathname } } catch { return null }
            })
            if (!form || form.origin !== auth.origin || form.path !== auth.path) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The captured form postback no longer matches its reviewed origin and path.', 'BLOCKED')
            activeWorkflowPostback = auth
            try { await locator.click({ timeout: actionTimeoutMs }) } finally { activeWorkflowPostback = null }
          } else {
            await locator.click({ timeout: actionTimeoutMs })
          }
          if (action.manualLoginSubmit === true) {
            await page.locator('input[type="password"]:visible').waitFor({ state: 'hidden', timeout: actionTimeoutMs }).catch(() => {})
            if (await page.locator('input[type="password"]:visible').count().catch(() => 0)) throw new BrowserTestError('AUTHENTICATION_FAILED', 'The application still shows its password prompt after the captured login submission.')
            manualAuthActive = false
          }
          actual = 'Element clicked.'
          expected = locatorDescription(action.locator)
        } else if (['create', 'update', 'delete'].includes(action.action)) {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          const form = await locator.evaluate((element) => {
            const owner = element.form || element.closest('form')
            if (!owner || owner.method.toUpperCase() !== 'POST') return null
            try {
              const target = new URL(owner.action, location.href)
              return { origin: target.origin, path: target.pathname }
            } catch { return null }
          })
          if (!form || (action.writeAuthorization ? action.writeAuthorization.origin !== form.origin : form.origin !== appUrl.origin)) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The approved write control must submit a POST form to the exact origin recorded in the selected reviewed workflow.', 'BLOCKED')
          if (action.writeAuthorization && (action.writeAuthorization.origin !== appUrl.origin || action.writeAuthorization.path !== form.path || action.writeAuthorization.operation !== action.action || action.writeAuthorization.method !== 'POST')) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The captured write form no longer matches its reviewed registered application path.', 'BLOCKED')
          activeWriteAuthorization = { operation: action.action, origin: appUrl.origin, path: form.path }
          let writeResponse
          const responseWait = page.waitForResponse((response) => {
            const request = response.request()
            try {
              const target = new URL(response.url())
              return request.method() === 'POST' && target.origin === activeWriteAuthorization?.origin && target.pathname === activeWriteAuthorization?.path
            } catch { return false }
          }, { timeout: 15000 }).catch(() => null)
          try {
            await locator.click({ timeout: actionTimeoutMs })
            writeResponse = await responseWait
          } finally {
            activeWriteAuthorization = null
          }
          if (!writeResponse) throw new BrowserTestError('WRITE_RESPONSE_UNCONFIRMED', 'The approved form did not return a matching response. The outcome is uncertain; no retry was attempted.', 'FAILED')
          if (writeResponse.status() >= 400) throw new BrowserTestError('APPLICATION_WRITE_REJECTED', 'The application returned HTTP ' + writeResponse.status() + ' for the approved form submission.', 'FAILED')
          actual = 'Approved ' + action.action + ' form returned HTTP ' + writeResponse.status() + '; the application result still requires assertion.'
          expected = { operation: action.action, formPath: form.path, verifiedByFollowingAssertion: true }
        } else if (action.action === 'fill') {
          const value = String(testCase.test_data[action.dataKey] ?? '')
          if (!value) actual = 'Optional field is blank; fill action skipped.'
          else {
            const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
            await locator.fill(value, { timeout: actionTimeoutMs })
            actual = 'Field filled; submitted data is not recorded.'
            expected = { locator: locatorDescription(action.locator), value: '[test data reference]' }
          }
        } else if (action.action === 'select') {
          const value = action.optionLabel !== undefined ? String(action.optionLabel) : String(testCase.test_data[action.dataKey] ?? '')
          if (!value) actual = 'Optional field is blank; select action skipped.'
          else {
            const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
            if (action.optionLabel) await locator.selectOption({ label: action.optionLabel }, { timeout: actionTimeoutMs })
            else await locator.selectOption(value, { timeout: actionTimeoutMs })
            actual = 'Option selected; submitted data is not recorded.'
            expected = { locator: locatorDescription(action.locator), value: '[test data reference]' }
          }
        } else if (action.action === 'check' || action.action === 'uncheck') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator[action.action]({ timeout: actionTimeoutMs })
          actual = action.action === 'check' ? 'Checkbox checked.' : 'Checkbox unchecked.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'wait_visible') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: action.timeoutMs })
          actual = 'Element became visible.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'read_text') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: actionTimeoutMs })
          actual = safeText(await locator.innerText({ timeout: actionTimeoutMs }), testCase.test_data)
          expected = { resultKey: action.resultKey }
        } else if (action.action === 'assert_visible') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: actionTimeoutMs })
          actual = 'Element is visible.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'assert_text') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: actionTimeoutMs })
          const observed = safeText(await locator.innerText({ timeout: actionTimeoutMs }), testCase.test_data)
          if (!observed.includes(action.expected)) throw new BrowserTestError('ASSERTION_FAILED', 'Visible text did not contain the expected text "' + action.expected + '".')
          actual = observed
          expected = { contains: action.expected }
        } else if (action.action === 'assert_url') {
          const observed = safePageUrl(page)
          const passed = action.operator === 'equals' ? new URL(page.url()).pathname === action.expected : new URL(page.url()).pathname.includes(action.expected)
          if (!passed) throw new BrowserTestError('ASSERTION_FAILED', 'URL ' + action.operator + ' "' + action.expected + '" — actual path was: ' + new URL(page.url()).pathname)
          actual = observed
          expected = { [action.operator]: action.expected }
        } else if (action.action === 'assert_value') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: actionTimeoutMs })
          const observedValue = await locator.inputValue({ timeout: actionTimeoutMs }).catch(() => locator.innerText({ timeout: actionTimeoutMs }))
          const expectedValue = String(testCase.test_data[action.dataKey])
          if (observedValue !== expectedValue) throw new BrowserTestError('ASSERTION_FAILED', 'Field value did not match the expected test data value.')
          actual = 'Field value matches.'
          expected = { dataKey: action.dataKey }
        } else if (action.action === 'assert_count_gt') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          const count = await locator.count()
          if (count <= action.threshold) throw new BrowserTestError('ASSERTION_FAILED', 'Element count was ' + count + ', expected greater than ' + action.threshold + '.')
          actual = 'Count: ' + count
          expected = { greaterThan: action.threshold }
        } else {
          throw new BrowserTestError('UNSUPPORTED_ACTION', 'The saved plan contains an unsupported action: "' + action.action + '".', 'BLOCKED')
        }
        if (policyBlock) throw new BrowserTestError(policyBlock.code, 'A request was stopped by the registered application security policy.', 'BLOCKED')
        if (remoteHttpError) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + remoteHttpError.status + '.', 'FAILED')
        const completedAt = new Date()
        const result = { executionId: runId, stepNumber, action: action.action, status: 'PASSED', expected, actual, startedAt: stepStarted, completedAt, durationMs: Date.now() - stepStartedMs }
        await persistBrowserTestStepResult(result)
        stepResults.push(result)
        if (action.action.startsWith('assert_') && safeRecording) {
          const screenshot = await page.screenshot({ fullPage: false })
          await saveArtifact({ executionId: runId, kind: 'screenshot', bytes: screenshot, contentType: 'image/png', outputDirectory, artifactBase })
        }
      } catch (error) {
        const status = control.cancelled ? 'SKIPPED' : error instanceof BrowserTestError ? error.status : policyBlock ? 'BLOCKED' : 'FAILED'
        const code = control.cancelled ? 'USER_CANCELLED' : error instanceof BrowserTestError ? error.code : policyBlock?.code || (String(error?.message || '').toLowerCase().includes('timeout') ? 'ACTION_TIMEOUT' : 'ACTION_FAILED')
        const details = control.cancelled ? 'Execution was cancelled by the user. The in-flight action outcome may be uncertain; no retry was attempted.' : safeText(error instanceof BrowserTestError ? error.message : 'Browser action failed: ' + (error?.message || 'Unknown error.'), testCase.test_data)
        const completedAt = new Date()
        const result = { executionId: runId, stepNumber, action: action.action, status, expected, actual, errorCode: code, errorDetails: details, startedAt: stepStarted, completedAt, durationMs: Date.now() - stepStartedMs }
        await persistBrowserTestStepResult(result).catch(() => {})
        stepResults.push(result)
        if (options.captureScreenshotsOnFailure !== false && options.recordArtifacts !== false && page && app.application_auth_method !== 'manual') {
          await maskInputsForScreenshot(page)
          const screenshot = await page.screenshot({ fullPage: false }).catch(() => null)
          if (screenshot) await saveArtifact({ executionId: runId, kind: 'screenshot', bytes: screenshot, contentType: 'image/png', outputDirectory, artifactBase }).catch(() => {})
        }
        throw new BrowserTestError(code, details, control.cancelled ? 'CANCELLED' : status)
      }
    }

    if (traceStarted) {
      if (traceSensitive) await context.tracing.stop()
      else {
        tracePath = resolve(outputDirectory, 'trace-' + randomUUID() + '.zip')
        await context.tracing.stop({ path: tracePath })
      }
      traceStarted = false
    }
    await context.close()
    context = null
    if (safeRecording && page.video()) {
      videoPath = await page.video().path().catch(() => null)
      if (videoPath) {
        await saveArtifact({ executionId: runId, kind: 'video', sourcePath: videoPath, contentType: 'video/webm', outputDirectory, artifactBase })
        videoPersisted = true
        videoStatus = 'AVAILABLE'
      }
    }
    if (tracePath) await persistBrowserTestArtifact({ id: 'bta-' + randomUUID(), executionId: runId, kind: 'trace', relativePath: relative(artifactBase, tracePath).split(sep).join('/'), contentType: 'application/zip', sizeBytes: (await stat(tracePath)).size })
      await updateBrowserTestExecution(runId, { status: 'PASSED', actualOutcome: 'All browser observations and assertions passed.', policyWarnings, diagnostics, videoStatus, videoError, completedAt: new Date(), durationMs: Date.now() - startedMs, errorCode: null, errorDetails: null })
  } catch (error) {
    const status = control.cancelled ? 'CANCELLED' : error instanceof BrowserTestError ? error.status : policyBlock ? 'BLOCKED' : 'FAILED'
    const code = control.cancelled ? 'USER_CANCELLED' : error instanceof BrowserTestError ? error.code : policyBlock?.code || 'EXECUTION_INFRASTRUCTURE_ERROR'
    const details = control.cancelled ? 'Execution was cancelled by the user. The in-flight action outcome may be uncertain; no retry was attempted.' : safeText(error instanceof BrowserTestError ? error.message : 'Browser execution failed: ' + (error?.message || 'Unknown error.'))
    if (traceStarted && context) {
      if (traceSensitive) await context.tracing.stop().catch(() => {})
      else {
        tracePath = resolve(outputDirectory, 'trace-' + randomUUID() + '.zip')
        await context.tracing.stop({ path: tracePath }).catch(() => {})
        const info = await stat(tracePath).catch(() => null)
        if (info) await persistBrowserTestArtifact({ id: 'bta-' + randomUUID(), executionId: executionId.id, kind: 'trace', relativePath: relative(artifactBase, tracePath).split(sep).join('/'), contentType: 'application/zip', sizeBytes: info.size }).catch(() => {})
      }
    }
    const fallbackStart = stepResults.length ? startedAt : null
    await updateBrowserTestExecution(executionId.id, {
      status,
      actualOutcome: status === 'CANCELLED' ? details : stepResults.length ? 'Execution stopped after ' + stepResults.length + ' completed steps.' : null,
      policyWarnings,
      diagnostics,
      errorCode: code,
      errorDetails: details,
      ...(fallbackStart ? { startedAt: fallbackStart } : {}),
      videoStatus,
      videoError,
      completedAt: new Date(),
      durationMs: Date.now() - startedMs,
    }).catch(() => {})
  } finally {
    if (page) await page.close().catch(() => {})
    if (context) await context.close().catch(() => {})
    if (!videoPersisted && page?.video() && outputDirectory) videoPath = await page.video().path().catch(() => null)
    if (browser) await browser.close().catch(() => {})
    if (videoPath && !videoPersisted && outputDirectory) {
      try {
        await saveArtifact({ executionId: executionId.id, kind: 'video', sourcePath: videoPath, contentType: 'video/webm', outputDirectory, artifactBase })
        videoPersisted = true
        videoStatus = 'AVAILABLE'
      } catch {
        videoStatus = 'FAILED'
        videoError = 'The browser video could not be finalized or saved.'
      }
    }
    if (recordVideoRequested && safeRecording && !videoPersisted && videoStatus === 'PENDING') {
      videoStatus = 'FAILED'
      videoError = 'The browser did not produce a finalized video file.'
    }
    await updateBrowserTestExecution(runId, { videoStatus, videoError }).catch(() => {})
    if (proxy) await proxy.close().catch(() => {})
    cancellationControls.delete(runId)
  }
}

export async function startBrowserTestExecution(execution) {
  const task = { id: execution.id, caseId: execution.case_id, approvedInteractions: execution.approved_interactions }
  const executionOptions = execution.execution_options && typeof execution.execution_options === 'object' ? execution.execution_options : {}
  const control = { cancelled: false, page: null }
  cancellationControls.set(execution.id, control)
  setImmediate(() => { executeBrowserTest(task, { control, ...executionOptions }).catch(() => {}) })
}

export async function waitForBrowserTestLogin(executionId) {
  return resumeBrowserTestAfterLogin(executionId)
}
