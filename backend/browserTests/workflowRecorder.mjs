import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createSecurityProxy, isManualLoginPostAllowed, isOracleHcmReadPostAllowed, normalizeAllowedOrigin } from '../exploration/networkSecurity.mjs'
import { getApplicationById, getApplicationWorkflowTemplate, saveApplicationWorkflowTemplate } from '../database.mjs'
import { rememberApprovedBrowserSession } from './execution.mjs'
import { detectWorkflowVariable } from '../workflows/variableDetection.mjs'
import { generateWorkflowCsvTemplate } from '../workflows/csvTemplate.mjs'
import { validateWorkflowDefinition } from '../workflows/workflowDefinition.mjs'

const captures = new Map()
const captureTtlMs = 30 * 60_000
const reservedCsvKeys = new Set(['test_case_id', 'name', 'preconditions', 'steps', 'test_data', 'expected_result', 'priority', 'tags'])

function locatorText(locator) {
  if (locator.kind === 'role') return `role=${locator.role}[name="${locator.name}"]`
  if (locator.kind === 'css') return `css=${locator.value}`
  return `${locator.kind}="${locator.value}"`
}

function capturedCandidates(payload) {
  const candidates = Array.isArray(payload?.locatorCandidates) ? payload.locatorCandidates : [payload?.locator]
  const normalized = []
  for (const item of candidates) {
    const candidate = actionLocator(item)
    if (!candidate) continue
    const normalizedCandidate = candidate.kind === 'css' ? { kind: 'id', value: candidate.value.slice(1) } : candidate
    if (!normalized.some((entry) => JSON.stringify(entry) === JSON.stringify(normalizedCandidate))) normalized.push(normalizedCandidate)
    if (normalized.length >= 8) break
  }
  return normalized
}

function inferWriteOperation(label, method, locatorCandidates = []) {
  const text = String(label || '').toLowerCase()
  const identifiers = Array.isArray(locatorCandidates)
    ? locatorCandidates.filter((candidate) => ['id', 'name', 'testid'].includes(candidate?.kind)).map((candidate) => String(candidate.value || '').toLowerCase())
    : []
  if (identifiers.some((value) => /^t_button_navcontrol$/.test(value)) || /^(t_button_navcontrol|this_week|last_week|next_week|this week|last week|next week)$/.test(text)) return null
  if (/^(search|find|filter|sort|refresh|view|open|expand|collapse|next|previous|back|home|menu)(?:\b|\s|:)/.test(text)) return null
  if (/\b(delete|remove|terminate)\b/.test(text) || method === 'DELETE') return 'delete'
  if (/\b(update|edit|save|modify)\b/.test(text) || ['PUT', 'PATCH'].includes(method)) return 'update'
  return 'create'
}

function instructionFor(action) {
  if (action.action === 'navigate') return `navigate: ${action.url}`
  const locator = locatorText(action.locator)
  if (['create', 'update', 'delete'].includes(action.action)) return `${action.action} ${locator}`
  if (action.action === 'fill') return `fill ${locator} <- \${test_data.${action.dataKey}}`
  if (action.action === 'select') return `select ${locator} <- \${test_data.${action.dataKey}}`
  if (action.action === 'check' || action.action === 'uncheck') return `${action.action} ${locator}`
  return `click ${locator}`
}

function makeCsvTemplate(workflowName, fields, stepsText, version) {
  return generateWorkflowCsvTemplate({
    name: workflowName,
    variables: fields,
    actions: String(stepsText || '').split(/\r?\n/).filter(Boolean).map((ruleText) => ({ ruleText })),
  }, version)
}

export function isCapturedFormWrite(session, method, targetUrl, contentType) {
  if (!session.captureActive || Date.now() - session.lastInteractionAt > 5000) return false
  if (session.manualAuthActive) return false
  const targetOrigin = normalizeAllowedOrigin(targetUrl.origin)
  if (!(session.navOrigins instanceof Set) || !session.navOrigins.has(targetOrigin)) return false
  if (method !== 'POST' || !/^application\/(?:x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(String(contentType || ''))) return false
  const action = session.actions[session.lastActionIndex]
  if (action?.manualLoginSubmit === true) return false
  const auth = action?.writeAuthorization
  const postback = action?.postbackAuthorization
  const authorization = auth || postback
  return Boolean(authorization && authorization.method === method && authorization.origin === targetUrl.origin && authorization.path === targetUrl.pathname)
}

function isCapturedOracleReadPostback(session, method, targetUrl, contentType) {
  if (!session.captureActive || session.manualAuthActive || session.application.auth_method !== 'manual' || method !== 'POST') return false
  let origin
  try { origin = normalizeAllowedOrigin(targetUrl.origin) } catch { return false }
  if (origin !== session.appOrigin) return false
  if (targetUrl.pathname === '/fscmUI/faces/AtkHomePageWelcome') return true
  return isOracleHcmReadPostAllowed({ method, targetUrl, contentType, applicationOrigin: session.appOrigin })
}

export function validateCaptureNavigationUrl(value) {
  let target
  try { target = new URL(String(value || '').trim()) } catch { throw new Error('Enter a complete HTTP or HTTPS URL.') }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Capture navigation supports credential-free HTTP or HTTPS URLs only.')
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  if (port !== 80 && port !== 443) throw new Error('Capture navigation only supports standard web ports 80 and 443.')
  normalizeAllowedOrigin(target.origin)
  return target.href
}

function actionLocator(target) {
  if (!target || typeof target !== 'object') return null
  const allowedRoles = new Set(['button', 'link', 'heading', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'searchbox', 'switch', 'spinbutton'])
  if (target.kind === 'role' && allowedRoles.has(target.role) && typeof target.name === 'string' && target.name.length > 0 && target.name.length <= 120 && !/["\r\n]/.test(target.name)) return { kind: 'role', role: target.role, name: target.name }
  if (['label', 'placeholder', 'text', 'testid', 'id', 'name'].includes(target.kind) && typeof target.value === 'string' && target.value.length > 0 && target.value.length <= 160 && !/["\r\n]/.test(target.value)) return { kind: target.kind, value: target.value }
  if (target.kind === 'css' && typeof target.value === 'string' && /^#[A-Za-z][\w-]{0,100}$/.test(target.value)) return { kind: 'css', value: target.value }
  return null
}

function buildPageCaptureScript() {
  return () => {
    const safeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    const roleFor = (element) => {
      const explicit = element.getAttribute('role')
      if (explicit) return explicit
      const tag = element.tagName.toLowerCase()
      if (tag === 'button' || tag === 'summary') return 'button'
      if (tag === 'a') return 'link'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'select') return 'combobox'
      if (tag === 'input') {
        if (element.type === 'checkbox') return 'checkbox'
        if (element.type === 'radio') return 'radio'
        if (element.type === 'search') return 'searchbox'
        if (['button', 'submit', 'reset'].includes(element.type)) return 'button'
        return 'textbox'
      }
      return null
    }
    const labelFor = (element) => {
      const labelledBy = safeText((element.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '))
      return safeText(element.getAttribute('aria-label') || labelledBy || [...(element.labels || [])].map((label) => label.innerText).join(' ') || element.getAttribute('placeholder') || element.getAttribute('data-testid') || element.id.replace(/[_-]+/g, ' ') || element.getAttribute('name')?.replace(/[_-]+/g, ''))
    }
    const locatorFor = (element) => {
      const tag = element.tagName.toLowerCase()
      const label = labelFor(element)
      if (['input', 'textarea', 'select'].includes(tag)) {
        const placeholder = safeText(element.getAttribute('placeholder'))
        if (label) return { kind: 'label', value: label }
        if (placeholder) return { kind: 'placeholder', value: placeholder }
      }
      const role = roleFor(element)
      const accessibleName = safeText(element.getAttribute('aria-label') || element.innerText || element.value || element.title)
      if (role && accessibleName) return { kind: 'role', role, name: accessibleName }
      if (element.id && /^[A-Za-z][\w-]{0,100}$/.test(element.id)) return { kind: 'css', value: '#' + element.id }
      const testId = safeText(element.getAttribute('data-testid'))
      if (testId) return { kind: 'testid', value: testId }
      if (label) return { kind: 'text', value: label }
      return null
    }
    const candidatesFor = (element) => {
      const candidates = []
      const tag = element.tagName.toLowerCase()
      const label = labelFor(element)
      const role = roleFor(element)
      const accessibleName = safeText(element.getAttribute('aria-label') || element.innerText || element.title)
      if (['input', 'textarea', 'select'].includes(tag) && label) candidates.push({ kind: 'label', value: label })
      if (element.id && /^[A-Za-z][\w-]{0,100}$/.test(element.id)) candidates.push({ kind: 'id', value: element.id })
      if (element.name && /^[A-Za-z][\w-]{0,100}$/.test(element.name)) candidates.push({ kind: 'name', value: element.name })
      const placeholder = safeText(element.getAttribute('placeholder'))
      if (placeholder) candidates.push({ kind: 'placeholder', value: placeholder })
      if (role && accessibleName) candidates.push({ kind: 'role', role, name: accessibleName })
      const testId = safeText(element.getAttribute('data-testid'))
      if (testId) candidates.push({ kind: 'testid', value: testId })
      if (!['input', 'textarea', 'select'].includes(tag) && label) candidates.push({ kind: 'text', value: label })
      return candidates.slice(0, 8)
    }
    const secretField = (element, label) => element.type === 'password' || element.type === 'hidden' || /password|passwd|passcode|token|secret|credential|authorization|cookie|api[_ -]?key/i.test(`${label} ${element.name || ''} ${element.autocomplete || ''}`)
    const loginForm = (element) => Boolean(element.form?.querySelector('input[type="password"]'))
    const send = (payload) => window.__chronosRecordAction?.(payload).catch(() => {})
    let pendingSelect = null
    let lastSelect = null
    const selectControlFor = (element) => element?.closest?.('select, [role="combobox"], oj-select-single, oj-combobox-one, oj-select-many') || null
    const selectControlPayload = (control) => {
      if (!control) return null
      const locator = locatorFor(control)
      const locatorCandidates = candidatesFor(control)
      if (!locator) return null
      if (!locatorCandidates.length) locatorCandidates.push(locator)
      const label = labelFor(control) || safeText(control.getAttribute('aria-label') || control.getAttribute('name') || control.id || 'Selection')
      return {
        locator,
        locatorCandidates,
        label,
        metadata: {
          label,
          name: control.getAttribute('name') || '',
          id: control.id || '',
          placeholder: control.getAttribute('placeholder') || '',
          type: 'select',
        },
      }
    }
    const recordSelect = (control) => {
      if (lastSelect?.control === control && Date.now() - lastSelect.at < 500) {
        pendingSelect = null
        return
      }
      const payload = selectControlPayload(control)
      if (payload) {
        send({ type: 'select', ...payload })
        lastSelect = { control, at: Date.now() }
      }
      pendingSelect = null
    }
    const controlFromOpenList = () => document.querySelector('select[aria-expanded="true"], [role="combobox"][aria-expanded="true"], oj-select-single[aria-expanded="true"], oj-combobox-one[aria-expanded="true"], oj-select-many[aria-expanded="true"]')
    const reportNavigation = () => send({ type: 'navigate', url: location.href })
    addEventListener('popstate', reportNavigation)
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method].bind(history)
      history[method] = (...args) => { const result = original(...args); queueMicrotask(reportNavigation); return result }
    }
    document.addEventListener('click', (event) => {
      const element = event.target instanceof Element ? event.target.closest('button,a,input[type="button"],input[type="submit"],select,[role="combobox"],oj-select-single,oj-combobox-one,oj-select-many,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"]') : null
      if (!element || element.closest('[data-chronos-recorder-ui]')) return
      if (element.matches('[role="option"]')) {
        const control = pendingSelect?.control || controlFromOpenList()
        if (control) recordSelect(control)
        return
      }
      const selectControl = selectControlFor(element)
      if (selectControl) {
        pendingSelect = { control: selectControl }
        return
      }
      pendingSelect = null
      const locator = locatorFor(element)
      if (!locator) return
      const label = safeText(element.getAttribute('aria-label') || element.innerText || element.value || element.title)
      const loginSubmit = loginForm(element)
      let write = null
      const form = element.form || element.closest('form')
      if (!loginSubmit && form && form.method.toUpperCase() === 'POST') {
        try {
          const url = new URL(form.action || location.href, location.href)
          if (url.origin === location.origin) write = { method: form.method.toUpperCase(), path: url.pathname }
        } catch {}
      }
      send({ type: 'click', locator, locatorCandidates: candidatesFor(element), label, write, loginSubmit })
    }, true)
    document.addEventListener('change', (event) => {
      const element = event.target
      const selectControl = selectControlFor(element)
      if (selectControl && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
        recordSelect(selectControl)
        return
      }
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return
      const label = labelFor(element)
      const passwordCredential = element instanceof HTMLInputElement && element.type === 'password'
      const loginUsername = loginForm(element) && !passwordCredential && /user[\s_-]*name|email|login/i.test(`${label} ${element.name || ''} ${element.id || ''}`)
      if (secretField(element, label) && !passwordCredential || loginForm(element) && !passwordCredential && !loginUsername) return
      const locator = locatorFor(element)
      if (!locator) return
      const metadata = { label, name: element.name, id: element.id, placeholder: element.getAttribute('placeholder'), type: element.type || element.tagName.toLowerCase() }
      if (element instanceof HTMLInputElement && element.type === 'checkbox') send({ type: element.checked ? 'check' : 'uncheck', locator, locatorCandidates: candidatesFor(element), metadata, label })
      else if (element instanceof HTMLInputElement && element.type === 'radio') send({ type: 'check', locator, locatorCandidates: candidatesFor(element), metadata, label })
      else if (element instanceof HTMLSelectElement) send({ type: 'select', locator, locatorCandidates: candidatesFor(element), metadata, label })
      else send({ type: 'fill', locator, locatorCandidates: candidatesFor(element), metadata, label })
    }, true)
    for (const eventName of ['valueChanged', 'ojValueAction']) {
      document.addEventListener(eventName, (event) => {
        const selectControl = selectControlFor(event.target)
        if (selectControl) recordSelect(selectControl)
      }, true)
    }
  }
}

function safeCurrentUrl(page) {
  try { const url = new URL(page.url()); return url.origin + url.pathname } catch { return '' }
}

function safeDiagnosticUrl(raw) {
  try {
    const url = new URL(raw)
    const segments = url.pathname.split('/').filter(Boolean)
    const opaqueMultiSegment = !url.pathname.toLowerCase().startsWith('/ords/') && segments.length >= 6
    const path = opaqueMultiSegment ? '/[redacted-path]' : url.pathname.replace(/\/(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{32,})(?=\/|$)/g, '/[redacted]')
    return url.origin + path
  } catch { return '[unavailable-url]' }
}

export async function startWorkflowCapture(application, options = {}) {
  if (!application || application.status !== 'Active') throw new Error('Select an active registered application.')
  if (application.auth_method === 'credential_reference') throw new Error('Credential-reference login is unavailable because no credential vault is configured. Use manual login for workflow recording.')
  const id = randomUUID()
  const baseUrl = new URL(application.base_url)
  const loginUrl = application.login_url || application.base_url
  const navOrigins = new Set([normalizeAllowedOrigin(baseUrl.origin), ...(application.approved_navigation_origins || []).map(normalizeAllowedOrigin)])
  if (!navOrigins.has(normalizeAllowedOrigin(new URL(loginUrl).origin))) throw new Error('The registered login origin is not approved for navigation.')
  const internalOrigins = [baseUrl.origin, ...(application.approved_navigation_origins || []), ...(application.approved_resource_origins || [])]
  const manualAuthOrigins = new Set([normalizeAllowedOrigin(new URL(loginUrl).origin)])
  const approvedResourceOrigins = new Set([normalizeAllowedOrigin(baseUrl.origin), ...(application.approved_resource_origins || []).map(normalizeAllowedOrigin)])
  const manualAuthPaths = new Set()
  const session = { id, application, appOrigin: normalizeAllowedOrigin(baseUrl.origin), loginUrl, navOrigins, manualAuthOrigins, manualAuthPaths, credentialOrigin: null, manualAuthActive: application.auth_method === 'manual', captureActive: true, paused: false, reviewRequired: false, diagnostics: [], nextSequence: 1, lastInteractionAt: 0, lastActionIndex: -1, actions: [], fields: new Map(), expiresAt: Date.now() + captureTtlMs }
  session.proxy = await createSecurityProxy({
    allowedHost: baseUrl.hostname, primaryOrigin: baseUrl.origin,
    navigationOrigins: [...navOrigins].filter((origin) => origin !== normalizeAllowedOrigin(baseUrl.origin)),
    resourceOrigins: [...approvedResourceOrigins].filter((origin) => origin !== normalizeAllowedOrigin(baseUrl.origin)),
    internalOrigins, allowPublicOrigins: true, manualAuthOrigin: normalizeAllowedOrigin(new URL(loginUrl).origin),
    manualAuthOrigins, manualAuthPaths, isManualAuthActive: () => session.manualAuthActive,
    // Manual capture is explicitly user-attended; pass through its app requests so
    // framework APIs and form submissions can run. The proxy still enforces safe
    // destination resolution, standard ports, and private-network authorization.
    manualCaptureRequestAllowed: () => session.captureActive,
    dnsLookup: options.dnsLookup,
    testTargetIp: options.testTargetIp,
    testTargetPort: options.testTargetPort,
    connectTimeoutMs: 8000,
  })
  try {
    const browserType = options.browserType || chromium
    const launchOptions = {
      headless: typeof options.headless === 'boolean' ? options.headless : false, timeout: 20000,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      proxy: { server: session.proxy.proxyUrl, bypass: '<-loopback>' },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-quic', '--dns-prefetch-disable', '--disable-background-networking', '--start-maximized', '--proxy-bypass-list=<-loopback>', '--proxy-server=' + session.proxy.proxyUrl],
    }
    // On Windows, use the user's installed Chrome when available to match the
    // browser behavior they use for Oracle HCM. Keep the bundled Chromium fallback
    // for machines without Chrome and for deterministic injected browser types.
    if (!options.browserType && !options.executablePath && process.platform === 'win32') {
      try {
        session.browser = await browserType.launch({ ...launchOptions, channel: 'chrome' })
      } catch (error) {
        if (!/chrome.*(?:not found|not installed)|executable doesn't exist/i.test(String(error?.message || error))) throw error
        session.diagnostics.push('Google Chrome was not found; using the bundled Chromium browser for capture.')
      }
    }
    if (!session.browser) session.browser = await browserType.launch(launchOptions)
    session.browser.on?.('disconnected', () => {
      session.captureActive = false
      session.paused = false
      session.browserClosed = true
      session.diagnostics.push('The capture browser disconnected. Captured actions can still be reviewed and saved.')
    })
    // Match the visible headed browser window so fixed footers remain on-screen
    // even when desktop chrome and the taskbar reduce the available page height.
    session.context = await session.browser.newContext({ ignoreHTTPSErrors: false, viewport: null })
    session.page = await session.context.newPage()
    await session.context.exposeBinding('__chronosRecordAction', (_source, payload) => {
      if (!session.captureActive || session.actions.length >= 50) return
      if (payload?.type === 'navigate') {
        let target
        try { target = new URL(validateCaptureNavigationUrl(payload.url)) } catch { return }
        const origin = normalizeAllowedOrigin(target.origin)
        if (!session.navOrigins.has(origin)) return
        const safeUrl = target.origin + target.pathname
        const previous = session.actions.at(-1)
        if (previous?.action === 'navigate' && previous.url === safeUrl) return
        if (previous && ['click', 'create', 'update', 'delete'].includes(previous.action) && Date.now() - session.lastInteractionAt < 3000) previous.pageUrlAfter = safeUrl
        else session.actions.push({ action: 'navigate', url: safeUrl, sequence: session.nextSequence++, capturedAt: new Date().toISOString() })
        session.lastActionIndex = session.actions.length - 1
        return
      }
      const locatorCandidates = capturedCandidates(payload)
      const locator = locatorCandidates[0] || actionLocator(payload?.locator)
      if (!locator || !locatorCandidates.length) return
      const type = ['click', 'fill', 'select', 'check', 'uncheck'].includes(payload.type) ? payload.type : null
      if (!type) return
      session.lastInteractionAt = Date.now()
      const label = String(payload.label || (locator.name || locator.value || 'Field')).slice(0, 160)
      const pageUrl = safeCurrentUrl(_source?.page)
      const metadata = payload.metadata && typeof payload.metadata === 'object' ? {
        tag: String(payload.metadata.tag || '').slice(0, 20),
        name: String(payload.metadata.name || '').slice(0, 120),
        id: String(payload.metadata.id || '').slice(0, 120),
        placeholder: String(payload.metadata.placeholder || '').slice(0, 160),
        inputType: String(payload.metadata.type || '').slice(0, 40),
      } : undefined
      const captureMeta = { sequence: session.nextSequence++, capturedAt: new Date().toISOString(), pageUrl, ...(metadata ? { element: metadata } : {}) }
      if (['fill', 'select'].includes(type)) {
        const metadataValue = payload.metadata || { label, type: type === 'select' ? 'select' : 'text' }
        const variable = detectWorkflowVariable(metadataValue, session.fields.size, new Set(session.fields.keys()), { allowPasswordCredential: session.application.auth_method === 'manual' && session.manualAuthActive && metadataValue.type === 'password' })
        if (variable.sensitive && !variable.credential) return
        const key = variable.key
        session.fields.set(key, { key, label: variable.label, type: variable.type, required: variable.required, variable: variable.variable, credential: variable.credential, sensitive: variable.sensitive })
        const action = { action: type, locator, locatorCandidates, dataKey: key, variableKey: key, ...(variable.credential ? { credentialInput: true } : {}), requiresApproval: true, ...captureMeta }
        if (variable.credential) {
          try { session.credentialOrigin = normalizeAllowedOrigin(new URL(pageUrl).origin) } catch {}
        }
        const previous = session.actions.at(-1)
        if (previous?.action === type && JSON.stringify(previous.locator) === JSON.stringify(locator)) session.actions[session.actions.length - 1] = action
        else { session.lastActionIndex = session.actions.length; session.actions.push(action) }
      } else if (type === 'click') {
        let action = { action: 'click', locator, locatorCandidates, ...(payload.loginSubmit === true && session.manualAuthActive ? { manualLoginSubmit: true } : {}), requiresApproval: true, ...captureMeta }
        const write = payload.write
        let pageOrigin = ''
        try { pageOrigin = new URL(pageUrl).origin } catch {}
        if (write && write.method && write.path && write.path.startsWith('/') && write.path.length <= 500 && session.navOrigins.has(normalizeAllowedOrigin(pageOrigin))) {
          const operation = inferWriteOperation(label, write.method, locatorCandidates)
          if (operation) action = { ...action, action: operation, requiresWriteApproval: true, writeAuthorization: { captured: true, operation, method: write.method, origin: pageOrigin, path: write.path } }
          else if (write.method === 'POST') action = { ...action, postbackAuthorization: { captured: true, method: 'POST', origin: pageOrigin, path: write.path } }
        }
        session.lastActionIndex = session.actions.length
        session.actions.push(action)
      } else {
        session.actions.push({ action: type, locator, locatorCandidates, requiresApproval: true, ...captureMeta })
        session.lastActionIndex = session.actions.length - 1
      }
    })
    await session.context.addInitScript(buildPageCaptureScript())
    await session.context.route('**/*', async (route) => {
      const request = route.request()
      const blocked = (reason) => {
        if (session.diagnostics.length < 100) session.diagnostics.push(`Blocked ${request.isNavigationRequest() ? 'navigation' : request.resourceType()} request (${request.method()}): ${safeDiagnosticUrl(request.url())} · ${reason}`)
        return route.abort('blockedbyclient')
      }
      let url
      try { url = new URL(request.url()) } catch { return blocked('malformed request URL') }
      try { normalizeAllowedOrigin(url.origin) } catch { return blocked('prohibited hostname or local address') }
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      if (!['http:', 'https:'].includes(url.protocol) || (port !== 80 && port !== 443)) return blocked('only standard HTTP/HTTPS ports are permitted')
      const origin = normalizeAllowedOrigin(url.origin)
      // Workflow capture is a user-attended session. Permit public origins reached by
      // the user while retaining DNS/IP validation in the mandatory outbound proxy.
      // Private/internal destinations still require explicit application approval.
      if (request.isNavigationRequest()) {
        session.navOrigins.add(origin)
        // Only a completed read navigation establishes a manual-auth origin; don't
        // let the POST being evaluated add its own destination to the auth allowlist.
        if (session.manualAuthActive && ['GET', 'HEAD'].includes(request.method())) session.manualAuthOrigins.add(origin)
      }
      const contentType = request.method() === 'POST' ? await request.headerValue('content-type').catch(() => null) : null
      const accessControlRequestMethod = request.method() === 'OPTIONS' ? await request.headerValue('access-control-request-method').catch(() => null) : null
      const loginPost = isManualLoginPostAllowed({ method: request.method(), targetUrl: url, contentType, accessControlRequestMethod, isDocumentNavigation: request.isNavigationRequest() && request.resourceType() === 'document', manualAuthOrigin: normalizeAllowedOrigin(new URL(loginUrl).origin), manualAuthOrigins, manualAuthPaths, isManualAuthActive: () => session.manualAuthActive })
      const captureWrite = isCapturedFormWrite(session, request.method(), url, contentType)
      const oracleReadPostback = isCapturedOracleReadPostback(session, request.method(), url, contentType)
      if (!['GET', 'HEAD'].includes(request.method()) && !loginPost && !captureWrite && !oracleReadPostback) return blocked('request method is not allowed by the active manual-login or reviewed-form policy')
      if (captureWrite && !oracleReadPostback && session.lastActionIndex >= 0) {
        const action = session.actions[session.lastActionIndex]
        if (action && ['click', 'create', 'update', 'delete'].includes(action.action) && !action.writeAuthorization && session.navOrigins.has(normalizeAllowedOrigin(url.origin))) {
          const operation = inferWriteOperation(action.locator.name || action.locator.value, request.method(), action.locatorCandidates)
          if (operation) {
            action.action = operation
            action.requiresWriteApproval = true
            action.writeAuthorization = { captured: true, operation, method: request.method(), origin: url.origin, path: url.pathname }
          } else {
            action.postbackAuthorization = { captured: true, method: 'POST', origin: url.origin, path: url.pathname }
          }
        }
      }
      return route.continue()
    })
    const watchedPages = new WeakSet()
    const lastPageUrls = new WeakMap()
    let skipInitialNavigation = true
    session.context.on('requestfailed', (request) => {
      if (session.diagnostics.length >= 100) return
      const failure = request.failure()?.errorText || 'request failed'
      session.diagnostics.push(`${request.isNavigationRequest() ? 'Navigation' : request.resourceType()} request failed (${request.method()}): ${safeDiagnosticUrl(request.url())} · ${String(failure).slice(0, 160)}`)
    })
    session.context.on('response', (response) => {
      if (response.status() < 400 || session.diagnostics.length >= 100) return
      const request = response.request()
      session.diagnostics.push(`HTTP ${response.status()} (${request.isNavigationRequest() ? 'navigation' : request.resourceType()}): ${safeDiagnosticUrl(response.url())}`)
    })
    const watchPage = (page) => {
      if (watchedPages.has(page)) return
      watchedPages.add(page)
      page.on('close', () => {
        if (page === session.page && session.captureActive) {
          session.captureActive = false
          session.browserClosed = true
          session.diagnostics.push('The capture browser tab was closed. Captured actions can still be reviewed and saved.')
        }
      })
      page.on('crash', () => { session.diagnostics.push('The capture browser tab crashed; captured actions remain available for review.') })
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return
        let target
        try { target = new URL(frame.url()) } catch { return }
        let origin
        try { origin = normalizeAllowedOrigin(target.origin) } catch { return }
        const safeUrl = target.origin + target.pathname
        const previous = lastPageUrls.get(page)
        lastPageUrls.set(page, safeUrl)
        if (skipInitialNavigation) { skipInitialNavigation = false; return }
        if (!session.captureActive || !session.navOrigins.has(origin) || previous === safeUrl) return
        const capturedPageUrl = safeUrl
        setTimeout(() => {
          if (!session.captureActive || session.actions.length >= 50) return
          const last = session.actions.at(-1)
          const transitionMeta = { sequence: session.nextSequence++, capturedAt: new Date().toISOString(), pageUrl: capturedPageUrl }
          if (last && ['click', 'create', 'update', 'delete'].includes(last.action) && Date.now() - session.lastInteractionAt < 3000) {
            last.pageUrlAfter = capturedPageUrl
          } else {
            session.actions.push({ action: 'navigate', url: capturedPageUrl, ...transitionMeta })
            session.lastActionIndex = session.actions.length - 1
          }
        }, 100)
      })
      page.on('domcontentloaded', async () => {
      if (!session.manualAuthActive || page.isClosed()) return
      try {
        const pageUrl = new URL(page.url())
        const origin = normalizeAllowedOrigin(pageUrl.origin)
        session.manualAuthOrigins.add(origin)
        // Identity providers often submit credentials back to the currently rendered
        // endpoint through script-driven forms. Keep that exact observed path in scope
        // even when the form isn't exposed as a conventional <form> element.
        session.manualAuthPaths.add(origin + pageUrl.pathname)
        const paths = await page.locator('form').evaluateAll((forms) => forms.filter((form) => form.method.toUpperCase() === 'POST').map((form) => { try { const target = new URL(form.action, location.href); return target.origin === location.origin ? target.pathname : null } catch { return null } }).filter(Boolean))
        for (const path of paths) session.manualAuthPaths.add(origin + path)
      } catch {}
      })
    }
    watchPage(session.page)
    session.context.on('page', watchPage)
    captures.set(id, session)
    session.expiryTimer = setTimeout(() => {
      captures.delete(id)
      session.captureActive = false
      closeSession(session).catch(() => {})
    }, captureTtlMs)
    session.expiryTimer.unref?.()
    await session.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    if (typeof options.onPageReady === 'function') await options.onPageReady(session.page)
    return { id, state: session.manualAuthActive ? 'WAITING_FOR_MANUAL_LOGIN' : 'CAPTURING', message: session.manualAuthActive ? 'Sign in in the browser, then choose Start capture in Chronos.' : 'Capture is active. Complete one representative workflow in the browser.' }
  } catch (error) {
    captures.delete(id)
    await closeSession(session)
    throw error
  }
}

async function closeSession(session) {
  clearTimeout(session.expiryTimer)
  if (session.page) await session.page.close().catch(() => {})
  if (session.context) await session.context.close().catch(() => {})
  if (session.browser) await session.browser.close().catch(() => {})
  if (session.proxy) await session.proxy.close().catch(() => {})
}

function getSession(id) {
  const session = captures.get(id)
  if (!session || session.expiresAt < Date.now()) return null
  return session
}

export function workflowCaptureSnapshot(id) {
  const session = getSession(id)
  if (!session) return null
  return { id, state: session.reviewRequired ? 'REVIEW_REQUIRED' : session.browserClosed ? 'BROWSER_CLOSED' : session.paused ? 'PAUSED' : session.manualAuthActive ? 'WAITING_FOR_MANUAL_LOGIN' : session.captureActive ? 'CAPTURING' : 'READY', currentUrl: safeCurrentUrl(session.page), workflowName: session.workflowName || `${session.application.name} recorded workflow`, actions: session.actions.map(({ action, url, locator, locatorCandidates, dataKey, credentialInput, manualLoginSubmit, requiresWriteApproval, writeAuthorization, postbackAuthorization, sequence, capturedAt, pageUrl, pageUrlAfter, element }) => ({ action, url, locator, locatorCandidates, dataKey, credentialInput, manualLoginSubmit, requiresWriteApproval, ...(writeAuthorization ? { writeAuthorization } : {}), ...(postbackAuthorization ? { postbackAuthorization } : {}), sequence, capturedAt, pageUrl, pageUrlAfter, element })), fields: [...session.fields.values()], diagnostics: session.diagnostics.slice(-20) }
}

function isManualLoginSubmitAction(session, action) {
  if (action.manualLoginSubmit === true) return true
  if (action.action !== 'click' || !session.fields.size) return false
  const hasPasswordFill = session.actions.some((item) => item.credentialInput === true && item.sequence < action.sequence)
  if (!hasPasswordFill) return false
  let origin
  try { origin = normalizeAllowedOrigin(new URL(action.pageUrl).origin) } catch { return false }
  if (session.credentialOrigin && origin !== session.credentialOrigin) return false
  if (!session.manualAuthOrigins.has(origin)) return false
  const labels = [action.locator?.name, action.locator?.value, ...(action.locatorCandidates || []).map((item) => item.name || item.value)]
    .filter(Boolean).map((label) => String(label).trim().toLowerCase())
  return labels.some((label) => /^(next|continue|submit|sign in|sign-in|log in|login)$/.test(label))
}

export async function beginWorkflowCapture(id) {
  const session = getSession(id)
  if (!session || !session.page || session.page.isClosed()) return false
  let origin
  try { origin = normalizeAllowedOrigin(new URL(session.page.url()).origin) } catch { return false }
  if (!session.navOrigins.has(origin)) return false
  try { if (await session.page.locator('input[type="password"]').isVisible()) return false } catch {}
  session.manualAuthActive = false
  session.paused = false
  session.captureActive = true
  session.lastInteractionAt = Date.now()
  const currentUrl = safeCurrentUrl(session.page)
  if (currentUrl && session.actions.length === 0) {
    const target = new URL(currentUrl)
    session.actions.push({ action: 'navigate', url: target.origin + target.pathname, sequence: session.nextSequence++, capturedAt: new Date().toISOString() })
    session.lastActionIndex = session.actions.length - 1
  }
  return true
}

export async function navigateWorkflowCapture(id, rawUrl) {
  const session = getSession(id)
  if (!session || !session.page || session.page.isClosed() || session.reviewRequired) throw new Error('Workflow capture is no longer active.')
  const targetUrl = validateCaptureNavigationUrl(rawUrl)
  await session.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  return workflowCaptureSnapshot(id)
}

export function pauseWorkflowCapture(id) {
  const session = getSession(id)
  if (!session || !session.captureActive) return false
  session.captureActive = false
  session.paused = true
  return true
}

export function resumeWorkflowCapture(id) {
  const session = getSession(id)
  if (!session || !session.paused || !session.page || session.page.isClosed()) return false
  session.paused = false
  session.captureActive = true
  return true
}

export async function finishWorkflowCapture(id, { reuseAuthenticatedSession = false } = {}) {
  const session = getSession(id)
  if (!session) return null
  session.captureActive = false
  session.paused = false
  if (!session.actions.length) { session.captureActive = true; throw new Error('No supported workflow actions were captured. Complete at least one field or control interaction and retry.') }
  const writes = session.actions.filter((action) => action.writeAuthorization)
  for (const action of writes) {
    const auth = action.writeAuthorization
    if (!['create', 'update', 'delete'].includes(auth.operation) || !session.navOrigins.has(normalizeAllowedOrigin(auth.origin)) || !auth.path.startsWith('/') || /[?#]/.test(auth.path)) {
      session.captureActive = true
      throw new Error('A captured write was outside the registered application scope and was not saved.')
    }
  }
  session.workflowName = `${session.application.name} recorded workflow`.slice(0, 120)
  session.reviewRequired = true
  if (reuseAuthenticatedSession && session.application.auth_method === 'manual' && !session.manualAuthActive) session.pendingAuthState = await session.context.storageState()
  await closeSession(session)
  session.page = null
  session.context = null
  session.browser = null
  session.proxy = null
  return { ...workflowCaptureSnapshot(id), state: 'REVIEW_REQUIRED', message: 'Review the captured actions and variables, then save the workflow.' }
}

export async function saveReviewedWorkflowCapture(id, review = {}) {
  const session = getSession(id)
  if (!session || !session.reviewRequired) throw new Error('Finish an active capture before saving its workflow.')
  const name = typeof review.name === 'string' ? review.name.trim() : session.workflowName
  if (!name || name.length > 120) throw new Error('Workflow name is required and must be at most 120 characters.')
  const defaultVariables = [...session.fields.values()].map((field) => ({ captureKey: field.key, key: field.key, label: field.label, required: field.required !== false, include: true, credential: field.credential === true }))
  const variablesInput = Array.isArray(review.variables) ? review.variables : defaultVariables
  const variables = []
  const renameMap = new Map()
  for (const input of variablesInput) {
    const original = session.fields.get(input?.captureKey)
    if (!original) throw new Error('Workflow review references an unknown captured variable.')
    if (input.include === false) continue
    const key = String(input.key || '').trim().toLowerCase()
    if (original.credential && key !== 'password') throw new Error('The password credential column must keep the name "password".')
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || reservedCsvKeys.has(key) || renameMap.has(original.key) || variables.some((field) => field.key === key)) throw new Error('Variable names must be unique, non-reserved lowercase identifiers.')
    const label = String(input.label || original.label).trim().slice(0, 160)
    if (!label) throw new Error('Variable labels cannot be empty.')
    renameMap.set(original.key, key)
    if (original.sensitive && !(original.credential === true && input.credential === true && input.key === 'password')) throw new Error('Only the explicitly detected password input may be included as a credential CSV column.')
    variables.push({ key, label, required: input.required !== false, variable: true, ...(original.credential ? { credential: true, sensitive: true } : {}) })
  }
  const selectedActions = []
  const actionInputs = Array.isArray(review.actions) ? review.actions : session.actions.map((_, captureIndex) => ({ captureIndex, include: true, locatorCandidateIndex: 0 }))
  const seenIndexes = new Set()
  for (const input of actionInputs) {
    const index = Number(input?.captureIndex)
    if (!Number.isInteger(index) || index < 0 || index >= session.actions.length || seenIndexes.has(index)) throw new Error('Workflow review contains an invalid or duplicated action reference.')
    seenIndexes.add(index)
    if (input.include === false) continue
    const captured = session.actions[index]
    const candidates = captured.locatorCandidates || (captured.locator ? [captured.locator] : [])
    let action = { ...captured }
    if (captured.action !== 'navigate') {
      const candidateIndex = Number(input.locatorCandidateIndex ?? 0)
      if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= candidates.length) throw new Error(`Action ${index + 1} has an invalid locator selection.`)
      action = { ...action, locator: candidates[candidateIndex], locatorCandidates: candidates }
      if (captured.credentialInput === true) { action.credentialInput = true; action.variableKey = action.dataKey }
      if (isManualLoginSubmitAction(session, captured)) action.manualLoginSubmit = true
    }
    if (captured.dataKey) {
      const mapped = renameMap.get(captured.dataKey)
      if (!mapped) throw new Error(`Action ${index + 1} needs its variable included to replay the recorded field.`)
      action.dataKey = mapped
      action.variableKey = mapped
    }
    selectedActions.push(action)
  }
  if (seenIndexes.size !== session.actions.length) throw new Error('Workflow review must explicitly include or exclude every captured action.')
  if (!selectedActions.length) throw new Error('At least one captured action must remain in the workflow.')
  const definition = validateWorkflowDefinition({ applicationId: session.application.id, name, actions: selectedActions, variables }, { applicationId: session.application.id, registeredOrigins: [...session.navOrigins] })
  const stepsText = selectedActions.map(instructionFor).join('\n')
  const fieldsForCsv = definition.variables.map((variable) => ({ ...variable, variable: true }))
  const saved = await saveApplicationWorkflowTemplate({
    applicationId: session.application.id, workflowName: name, actionPlan: definition.actions, dataFields: definition.variables, stepsText,
    csvTemplateForVersion: (version) => makeCsvTemplate(name, fieldsForCsv, stepsText, version),
  })
  if (session.pendingAuthState) rememberApprovedBrowserSession(session.application.id, session.pendingAuthState)
  delete session.pendingAuthState
  captures.delete(id)
  clearTimeout(session.expiryTimer)
  return { ...saved, state: 'SAVED', action_count: definition.actions.length, fields: definition.variables }
}

export async function cancelWorkflowCapture(id) {
  const session = captures.get(id)
  if (!session) return false
  captures.delete(id)
  session.captureActive = false
  await closeSession(session)
  return true
}

export async function getWorkflowTemplateForApplication(applicationId) {
  return getApplicationWorkflowTemplate(applicationId)
}

export async function startWorkflowCaptureForApplication(applicationId) {
  const application = await getApplicationById(applicationId)
  if (!application) throw new Error('Registered application not found.')
  return startWorkflowCapture(application)
}

export function getWorkflowCapture(id) { return workflowCaptureSnapshot(id) }
