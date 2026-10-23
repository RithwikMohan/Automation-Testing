import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import { chromium } from 'playwright'
import { createSecurityProxy, isApprovedWritePostAllowed, isManualLoginPostAllowed, normalizeAllowedOrigin } from '../exploration/networkSecurity.mjs'
import {
  getBrowserTestCaseById,
  persistBrowserTestArtifact,
  persistBrowserTestStepResult,
  updateBrowserTestExecution,
} from '../database.mjs'

const resumeControls = new Map()
const cancellationControls = new Map()
const MAX_EXECUTION_MS = 120_000

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
    if (typeof item === 'string' && item.length >= 4) result = result.split(item).join('[redacted]')
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
  throw new BrowserTestError('UNSUPPORTED_LOCATOR', 'The saved plan contains an unsupported locator.', 'BLOCKED')
}

async function uniqueLocator(page, spec) {
  const locator = buildLocator(page, spec)
  const count = await locator.count()
  if (count !== 1) throw new BrowserTestError(count === 0 ? 'ELEMENT_NOT_FOUND' : 'AMBIGUOUS_LOCATOR', count === 0 ? 'The locator did not match a visible element.' : 'The locator matched more than one element.')
  return locator
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
  let activeWriteAuthorization = null
  let policyBlock = null
  let stepNumber = 0
  let videoPath
  let videoPersisted = false
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
    if (topLevelNavigation || code === 'READ_ONLY_METHOD_BLOCKED') policyBlock = { code, hostname: hostname || null }
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
    if (!plan || plan.version !== '1.0' || !Array.isArray(plan.actions) || plan.actions.length > 50) throw new BrowserTestError('INVALID_PLAN', 'The saved action plan is invalid or unsupported.', 'BLOCKED')
    if (plan.actions.some((action) => ['create', 'update', 'delete'].includes(action.action) && (action.requiresApproval !== true || action.requiresWriteApproval !== true))) {
      throw new BrowserTestError('INVALID_PLAN', 'Every saved write action must carry explicit interactive and write approval requirements.', 'BLOCKED')
    }
    if (plan.actions.some((action) => action.requiresApproval) && !executionId.approvedInteractions) throw new BrowserTestError('APPROVAL_REQUIRED', 'This plan contains interactive actions and needs explicit run approval.', 'BLOCKED')

    const appUrl = new URL(app.application_base_url)
    const loginUrl = app.application_login_url || app.application_base_url
    const loginOrigin = normalizeAllowedOrigin(new URL(loginUrl).origin)
    const navOrigins = new Set([normalizeAllowedOrigin(appUrl.origin), ...(app.approved_navigation_origins || []).map(normalizeAllowedOrigin)])
    if (!navOrigins.has(loginOrigin)) throw new BrowserTestError('LOGIN_ORIGIN_BLOCKED', 'The registered login URL origin is not an approved navigation origin.', 'BLOCKED')
    const resourceOrigins = new Set([normalizeAllowedOrigin(appUrl.origin), ...(app.approved_resource_origins || []).map(normalizeAllowedOrigin)])

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
      manualAuthOrigin: loginOrigin,
      manualAuthPaths,
      isManualAuthActive: () => manualAuthActive,
      isApprovedWriteRequest: (request) => isApprovedWritePostAllowed({ ...request, authorization: activeWriteAuthorization }),
      dnsLookup: options.dnsLookup,
      testTargetIp: options.testTargetIp,
      testTargetPort: options.testTargetPort,
      connectTimeoutMs: 8000,
      onSecurityViolation: (event) => {
        const host = String(event.hostname || '').toLowerCase().replace(/\.$/, '')
        const isMainHost = host === appUrl.hostname.toLowerCase().replace(/\.$/, '')
        recordPolicyWarning(event.type || 'SECURITY_POLICY_BLOCKED', host, 'network', isMainHost)
      },
    })
    throwIfCancelled()
    browser = await chromium.launch({
      headless: app.application_auth_method === 'manual' ? false : process.env.HEADLESS !== 'false',
      timeout: 20_000,
      proxy: { server: proxy.proxyUrl, bypass: '<-loopback>' },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-quic', '--dns-prefetch-disable', '--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-bypass-list=<-loopback>', '--proxy-server=' + proxy.proxyUrl],
    })
    const containsInputData = plan.actions.some((action) => ['fill', 'select', 'check', 'uncheck'].includes(action.action))
    const safeRecording = options.recordArtifacts !== false && app.application_auth_method !== 'manual' && !containsInputData
    context = await browser.newContext({
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
      ...(safeRecording ? { recordVideo: { dir: outputDirectory } } : {}),
    })
    page = await context.newPage()
    control.page = page
    throwIfCancelled()
    await context.route('**/*', async (route) => {
      const request = route.request()
      let parsed
      try { parsed = new URL(request.url()) } catch {
        policyBlock = { code: 'INVALID_REQUEST_URL' }
        return route.abort('blockedbyclient')
      }
      if (traceStarted && [...parsed.searchParams.keys()].some((key) => /password|passwd|pwd|token|session|cookie|authorization|secret/i.test(key))) traceSensitive = true
      if (traceStarted) {
        const headers = await request.allHeaders().catch(() => ({}))
        if (headers.cookie || headers.authorization || headers['proxy-authorization']) traceSensitive = true
      }
      const isMainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame()
      let origin
      try { origin = normalizeAllowedOrigin(parsed.origin) } catch {
        policyBlock = { code: 'INVALID_DESTINATION' }
        return route.abort('blockedbyclient')
      }
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      if (port !== 80 && port !== 443) {
        recordPolicyWarning('PORT_BLOCKED', parsed.hostname, request.resourceType(), isMainNavigation)
        return route.abort('blockedbyclient')
      }
      if (isMainNavigation ? !navOrigins.has(origin) : !resourceOrigins.has(origin)) {
        recordPolicyWarning(isMainNavigation ? 'NAVIGATION_ORIGIN_BLOCKED' : 'RESOURCE_ORIGIN_BLOCKED', parsed.hostname, request.resourceType(), isMainNavigation)
        return route.abort('blockedbyclient')
      }
      const method = request.method()
      const contentType = method === 'POST' ? await request.headerValue('content-type').catch(() => null) : null
      const isManualLoginPost = isManualLoginPostAllowed({
        method,
        targetUrl: parsed,
        contentType,
        manualAuthOrigin: loginOrigin,
        manualAuthPaths,
        isManualAuthActive: () => manualAuthActive,
      })
      const isApprovedWritePost = isApprovedWritePostAllowed({ method, targetUrl: parsed, contentType, authorization: activeWriteAuthorization })
      if (method !== 'GET' && method !== 'HEAD' && !isManualLoginPost && !isApprovedWritePost) {
        recordPolicyWarning('READ_ONLY_METHOD_BLOCKED', parsed.hostname, request.resourceType(), isMainNavigation)
        recordDiagnostic({ type: 'request_blocked', method, ...safeDiagnosticUrl(request.url()), resourceType: request.resourceType(), reason: 'READ_ONLY_METHOD_BLOCKED' })
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    page.on('response', (response) => {
      const request = response.request()
      if (traceStarted && response.headers()['set-cookie']) traceSensitive = true
      if (response.status() >= 400) recordDiagnostic({ type: 'http_response', method: request.method(), ...safeDiagnosticUrl(response.url()), status: response.status(), resourceType: request.resourceType() })
      if (response.status() >= 400 && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        remoteHttpError = { status: response.status(), hostname: (() => { try { return new URL(response.url()).hostname } catch { return null } })() }
      }
    })
    page.on('console', (message) => {
      if (message.type() === 'error') recordDiagnostic({ type: 'console_error', message: safeText(message.text(), testData) })
    })
    page.on('pageerror', (error) => recordDiagnostic({ type: 'page_error', name: error.name, message: safeText(error.message, testData) }))
    page.on('requestfailed', (request) => recordDiagnostic({
      type: 'request_failed', method: request.method(), ...safeDiagnosticUrl(request.url()),
      resourceType: request.resourceType(), error: safeText(request.failure()?.errorText || 'Request failed.', testData),
    }))

    throwIfCancelled()
    await updateBrowserTestExecution(runId, { status: 'RUNNING', startedAt })
    const initialResponse = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    if (initialResponse && initialResponse.status() >= 400) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + initialResponse.status() + '.', 'FAILED')
    if (app.application_auth_method === 'manual') {
      const formPaths = await page.locator('form').evaluateAll((forms) => forms
        .filter((form) => form.method.toUpperCase() === 'POST')
        .map((form) => {
          try {
            const action = new URL(form.action, location.href)
            return action.origin === location.origin ? action.pathname : null
          } catch { return null }
        })
        .filter(Boolean))
      for (const path of formPaths) manualAuthPaths.add(path)
      manualAuthActive = true
      await updateBrowserTestExecution(runId, { actualOutcome: 'Waiting for user to complete manual login and resume the test.' })
      await waitForManualLogin(runId, 300_000)
      manualAuthActive = false
      const currentOrigin = normalizeAllowedOrigin(new URL(page.url()).origin)
      if (!navOrigins.has(currentOrigin)) throw new BrowserTestError('LOGIN_ORIGIN_BLOCKED', 'After manual login, the browser was outside approved application navigation origins.', 'BLOCKED')
      const stillHasPasswordField = await page.locator('input[type="password"]').count().catch(() => 0)
      if (stillHasPasswordField && new URL(page.url()).pathname === new URL(loginUrl).pathname) throw new BrowserTestError('AUTHENTICATION_NOT_CONFIRMED', 'The login page is still active after manual confirmation.', 'BLOCKED')
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
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
          if (!navOrigins.has(normalizeAllowedOrigin(target.origin))) throw new BrowserTestError('NAVIGATION_ORIGIN_BLOCKED', 'Navigation is outside approved application origins.', 'BLOCKED')
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
          if (remoteHttpError) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + remoteHttpError.status + '.', 'FAILED')
          actual = { url: safePageUrl(page) }
          expected = { url: action.url }
        } else if (action.action === 'click') {
          const locator = await uniqueLocator(page, action.locator)
          await locator.click({ timeout: 10000 })
          actual = 'Element clicked.'
          expected = locatorDescription(action.locator)
        } else if (['create', 'update', 'delete'].includes(action.action)) {
          const locator = await uniqueLocator(page, action.locator)
          const form = await locator.evaluate((element) => {
            const owner = element.form || element.closest('form')
            if (!owner || owner.method.toUpperCase() !== 'POST') return null
            try {
              const target = new URL(owner.action, location.href)
              return { origin: target.origin, path: target.pathname }
            } catch { return null }
          })
          if (!form || form.origin !== appUrl.origin) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The approved write control must submit a POST form to the registered application origin.', 'BLOCKED')
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
            await locator.click({ timeout: 10000 })
            writeResponse = await responseWait
          } finally {
            activeWriteAuthorization = null
          }
          if (!writeResponse) throw new BrowserTestError('WRITE_RESPONSE_UNCONFIRMED', 'The approved form did not return a matching response. The outcome is uncertain; no retry was attempted.', 'FAILED')
          if (writeResponse.status() >= 400) throw new BrowserTestError('APPLICATION_WRITE_REJECTED', 'The application returned HTTP ' + writeResponse.status() + ' for the approved form submission.', 'FAILED')
          actual = 'Approved ' + action.action + ' form returned HTTP ' + writeResponse.status() + '; the application result still requires assertion.'
          expected = { operation: action.action, formPath: form.path, verifiedByFollowingAssertion: true }
        } else if (action.action === 'fill') {
          const locator = await uniqueLocator(page, action.locator)
          await locator.fill(String(testCase.test_data[action.dataKey]), { timeout: 10000 })
          actual = 'Field filled; submitted data is not recorded.'
          expected = { locator: locatorDescription(action.locator), value: '[test data reference]' }
        } else if (action.action === 'select') {
          const locator = await uniqueLocator(page, action.locator)
          await locator.selectOption(String(testCase.test_data[action.dataKey]), { timeout: 10000 })
          actual = 'Option selected; submitted data is not recorded.'
          expected = { locator: locatorDescription(action.locator), value: '[test data reference]' }
        } else if (action.action === 'check' || action.action === 'uncheck') {
          const locator = await uniqueLocator(page, action.locator)
          await locator[action.action]({ timeout: 10000 })
          actual = action.action === 'check' ? 'Checkbox checked.' : 'Checkbox unchecked.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'wait_visible') {
          const locator = await uniqueLocator(page, action.locator)
          await locator.waitFor({ state: 'visible', timeout: action.timeoutMs })
          actual = 'Element became visible.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'read_text') {
          const locator = await uniqueLocator(page, action.locator)
          await locator.waitFor({ state: 'visible', timeout: 10000 })
          actual = safeText(await locator.innerText({ timeout: 10000 }), testCase.test_data)
          expected = { resultKey: action.resultKey }
        } else if (action.action === 'assert_visible') {
          const locator = await uniqueLocator(page, action.locator)
          await locator.waitFor({ state: 'visible', timeout: 10000 })
          actual = 'Element is visible.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'assert_text') {
          const locator = await uniqueLocator(page, action.locator)
          await locator.waitFor({ state: 'visible', timeout: 10000 })
          const observed = safeText(await locator.innerText({ timeout: 10000 }), testCase.test_data)
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
          const locator = await uniqueLocator(page, action.locator)
          await locator.waitFor({ state: 'visible', timeout: 10000 })
          const observedValue = await locator.inputValue({ timeout: 10000 }).catch(() => locator.innerText({ timeout: 10000 }))
          const expectedValue = String(testCase.test_data[action.dataKey])
          if (observedValue !== expectedValue) throw new BrowserTestError('ASSERTION_FAILED', 'Field value did not match the expected test data value.')
          actual = 'Field value matches.'
          expected = { dataKey: action.dataKey }
        } else if (action.action === 'assert_count_gt') {
          const locator = buildLocator(page, action.locator)
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
        if (options.recordArtifacts !== false && page && app.application_auth_method !== 'manual') {
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
      }
    }
    if (tracePath) await persistBrowserTestArtifact({ id: 'bta-' + randomUUID(), executionId: runId, kind: 'trace', relativePath: relative(artifactBase, tracePath).split(sep).join('/'), contentType: 'application/zip', sizeBytes: (await stat(tracePath)).size })
    await updateBrowserTestExecution(runId, { status: 'PASSED', actualOutcome: 'All browser observations and assertions passed.', policyWarnings, diagnostics, completedAt: new Date(), durationMs: Date.now() - startedMs, errorCode: null, errorDetails: null })
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
      completedAt: new Date(),
      durationMs: Date.now() - startedMs,
    }).catch(() => {})
  } finally {
    if (page) await page.close().catch(() => {})
    if (context) await context.close().catch(() => {})
    if (!videoPersisted && page?.video() && outputDirectory) videoPath = await page.video().path().catch(() => null)
    if (browser) await browser.close().catch(() => {})
    if (videoPath && !videoPersisted && outputDirectory) {
      await saveArtifact({ executionId: executionId.id, kind: 'video', sourcePath: videoPath, contentType: 'video/webm', outputDirectory, artifactBase }).catch(() => {})
    }
    if (proxy) await proxy.close().catch(() => {})
    cancellationControls.delete(runId)
  }
}

export async function startBrowserTestExecution(execution) {
  const task = { id: execution.id, caseId: execution.case_id, approvedInteractions: execution.approved_interactions }
  const control = { cancelled: false, page: null }
  cancellationControls.set(execution.id, control)
  setImmediate(() => { executeBrowserTest(task, { control }).catch(() => {}) })
}

export async function waitForBrowserTestLogin(executionId) {
  return resumeBrowserTestAfterLogin(executionId)
}
