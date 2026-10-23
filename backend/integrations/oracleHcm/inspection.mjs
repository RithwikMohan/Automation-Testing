import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createSecurityProxy, isManualLoginPostAllowed, normalizeAllowedOrigin } from '../../exploration/networkSecurity.mjs'

const sessions = new Map()
const SESSION_TTL_MS = 10 * 60_000
const MAX_INSPECTION_SESSIONS = 1

function safePath(raw) {
  try { return new URL(raw).pathname.replace(/\/(?:\d{4,}|[A-Fa-f0-9]{24,}|[A-Za-z0-9_-]{24,})(?=\/|$)/g, '/[redacted]') } catch { return '/' }
}

function failureCategory(error) {
  const name = String(error?.name || '')
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  if (/timeout/i.test(name) || /timeout|timed out/.test(message)) return 'timeout'
  if (/tls|cert|ssl/.test(message) || /^ERR_CERT/.test(code)) return 'tls'
  if (/proxy/.test(message) || /PROXY/.test(code)) return 'proxy'
  if (/net::|navigation|goto/.test(message) || /^ERR_/.test(code)) return 'navigation_or_network'
  if (/form/.test(message)) return 'login_form_not_found'
  return 'startup_failure'
}

function logLifecycle(control, event, detail = {}) {
  const entry = { component: 'oracle-hcm-inspection', event, sessionId: control.id, ...detail }
  try { control.onLifecycle?.(entry) } catch { /* diagnostics must not change session behavior */ }
  if (!control.onLifecycle) console.info('[oracle-hcm-inspection]', JSON.stringify(entry))
}

function scrubText(raw) {
  return String(raw || '').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\+?\d[\d ().-]{7,}\d/g, '[redacted number]')
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted token]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted token]')
    .replace(/\s+/g, ' ').trim().slice(0, 180)
}

function safeWizardHeading(raw) {
  const text = scrubText(raw)
  return /^(?:hire (?:an? )?employee|info to include|when and why|personal details|communication info|position(?: override)?|assignment(?: and submission)?|review(?: employee)?|summary)$/i.test(text)
}

function safeWizardButton(raw) {
  const text = scrubText(raw)
  return /^(?:next|continue|back|previous|cancel|close|save|submit|review|create|hire|done|finish|add)(?: (?:employee|phone|email|details|another|new|more))?$/i.test(text)
}

/** Extract only visible wizard structure. Never read input values or capture media. */
export async function extractHcmWizardSnapshot(page) {
  const data = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible)
    const wizardHeading = headings.find((heading) => /\b(hire|hiring|new employee|new person)\b/i.test(heading.innerText || heading.getAttribute('aria-label') || ''))
    if (!wizardHeading) return { ready: false }
    const root = wizardHeading.closest('[role="dialog"],form,main') || wizardHeading.parentElement
    if (!root) return { ready: false }
    const hasEnteredData = [...root.querySelectorAll('input,textarea,[contenteditable="true"]')].some((element) => {
      if (element instanceof HTMLInputElement && ['password', 'hidden'].includes(element.type)) return false
      return Boolean(element.value || (element instanceof HTMLElement && element.isContentEditable && element.innerText.trim()))
    })
    if (hasEnteredData) return { ready: false, withheld: true }
    const textOf = (element) => (element.getAttribute('aria-label') || element.innerText || element.textContent || '').trim()
    const labelsFor = (element) => {
      const id = element.id
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null
      const wrap = element.closest('label')
      return [label && textOf(label), wrap && textOf(wrap), element.getAttribute('aria-label')].filter(Boolean)[0] || ''
    }
    const fields = [...root.querySelectorAll('input,textarea,select,[role="combobox"]')].filter(visible).map((element) => {
      const isPassword = element instanceof HTMLInputElement && element.type === 'password'
      const label = labelsFor(element)
      const tag = element.tagName.toLowerCase()
      const kind = isPassword ? 'password' : tag === 'select' || element.getAttribute('role') === 'combobox' ? 'combobox' : tag
      const required = element.hasAttribute('required') || element.getAttribute('aria-required') === 'true'
      let options = []
      let optionsRedacted = false
      if (tag === 'select' && /legal employer|\baction\b|reason|business unit|\bposition\b|phone type|email type/i.test(label)) {
        const rawOptions = [...element.options].map((option) => option.textContent?.trim() || '').filter(Boolean)
        optionsRedacted = rawOptions.some((value) => /@|\+?\d[\d ().-]{7,}\d|\b[A-Z]{2,}\d{5,}\b/i.test(value))
        options = optionsRedacted ? [] : rawOptions.slice(0, 100)
      }
      return { label: isPassword ? 'Password field (label omitted)' : label, kind, required, optionCount: tag === 'select' ? element.options.length : undefined, options, optionsRedacted }
    }).filter((field) => field.kind !== 'password')
    const buttons = [...root.querySelectorAll('button,[role="button"]')].filter(visible).map(textOf).filter(Boolean).map((name) => name.slice(0, 100)).slice(0, 40)
    const messages = [...root.querySelectorAll('[role="alert"],[aria-live="assertive"],[aria-live="polite"]')].filter(visible)
      .map(textOf).filter((message) => /required|invalid|must|select|enter|date|format|available|not found|cannot|error|warning|success/i.test(message)).slice(0, 20)
    return {
      ready: true,
      title: textOf(wizardHeading).slice(0, 120),
      headings: headings.filter((heading) => root.contains(heading)).map(textOf).filter(Boolean).map((text) => text.slice(0, 120)).slice(0, 20),
      fields,
      buttons,
      validationMessages: messages,
    }
  })
  if (!data.ready) return { ready: false, message: data.withheld
    ? 'The wizard contains entered data; the snapshot was withheld to protect personal information.'
    : 'No visible employee hiring wizard heading was identified; page text was not captured.' }
  return {
    ready: true,
    title: 'Employee hiring wizard',
    headings: data.headings.filter(safeWizardHeading).map(scrubText),
    fields: data.fields.map((field) => ({
      label: scrubText(field.label),
      kind: field.kind,
      required: field.required,
      ...(field.optionCount !== undefined ? { optionCount: field.optionCount } : {}),
      options: field.options.map(scrubText),
      ...(field.optionsRedacted ? { optionsRedacted: true } : {}),
    })),
    buttons: data.buttons.filter(safeWizardButton).map(scrubText),
    validationMessages: data.validationMessages.map(scrubText),
  }
}

export async function startHcmInspection(application, options = {}) {
  if (sessions.size >= MAX_INSPECTION_SESSIONS) throw new Error('An Oracle HCM inspection session is already active.')
  if (!application || application.status !== 'Active' || application.auth_method !== 'manual') throw new Error('An active application registered for manual authentication is required.')
  const base = new URL(application.base_url)
  const loginUrl = application.login_url || application.base_url
  const loginOrigin = normalizeAllowedOrigin(new URL(loginUrl).origin)
  const navOrigins = new Set([normalizeAllowedOrigin(base.origin), ...(application.approved_navigation_origins || []).map(normalizeAllowedOrigin)])
  const resourceOrigins = new Set([normalizeAllowedOrigin(base.origin), ...(application.approved_resource_origins || []).map(normalizeAllowedOrigin)])
  if (!navOrigins.has(loginOrigin)) throw new Error('The registered login origin is not approved for navigation.')

  const id = randomUUID()
  const formPaths = new Set()
  const control = {
    id, page: null, browser: null, context: null, proxy: null, state: 'STARTING',
    manualAuthActive: false, timer: null, registeredOrigin: normalizeAllowedOrigin(base.origin),
    navigationOrigins: navOrigins, loginPath: new URL(loginUrl).pathname,
    stage: 'proxy_start', onLifecycle: options.onLifecycle, cleanupPromise: null,
  }
  sessions.set(id, control)
  logLifecycle(control, 'session_created', { state: control.state, headless: options.headless === true, ttlMs: SESSION_TTL_MS })
  const record = (event) => { if (options.onSecurityEvent) options.onSecurityEvent(event) }
  try {
    control.proxy = await createSecurityProxy({
      allowedHost: base.hostname,
      primaryOrigin: base.origin,
      navigationOrigins: [...navOrigins].filter((origin) => origin !== normalizeAllowedOrigin(base.origin)),
      resourceOrigins: [...resourceOrigins].filter((origin) => origin !== normalizeAllowedOrigin(base.origin)),
      manualAuthOrigin: loginOrigin,
      manualAuthPaths: formPaths,
      isManualAuthActive: () => control.manualAuthActive,
      dnsLookup: options.dnsLookup,
      testTargetIp: options.testTargetIp,
      testTargetPort: options.testTargetPort,
      onSecurityViolation: record,
    })
    control.stage = 'browser_launch'
    control.browser = await chromium.launch({
      headless: options.headless === true,
      timeout: 20_000,
      proxy: { server: control.proxy.proxyUrl, bypass: '<-loopback>' },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-quic', '--dns-prefetch-disable', '--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-bypass-list=<-loopback>', '--proxy-server=' + control.proxy.proxyUrl],
    })
    control.browser.on('disconnected', () => {
      logLifecycle(control, 'browser_disconnected', { state: control.state })
      if (!['CLOSING', 'CLOSED', 'EXPIRED', 'FAILED'].includes(control.state)) void closeControl(control, 'browser_failure')
    })
    options.onBrowserReady?.(control.browser)
    logLifecycle(control, 'browser_started', { headless: options.headless === true })
    control.stage = 'context_create'
    control.context = await control.browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: 'block' })
    control.stage = 'page_create'
    control.page = await control.context.newPage()
    control.page.on('close', () => {
      logLifecycle(control, 'page_closed', { state: control.state })
      if (!['CLOSING', 'CLOSED', 'EXPIRED', 'FAILED'].includes(control.state)) void closeControl(control, 'browser_failure')
    })
    await control.context.route('**/*', async (route) => {
      const request = route.request()
      let target
      try { target = new URL(request.url()) } catch { return route.abort('blockedbyclient') }
      let origin
      try { origin = normalizeAllowedOrigin(target.origin) } catch { return route.abort('blockedbyclient') }
      const isNavigation = request.isNavigationRequest() && request.frame() === control.page.mainFrame()
      if (isNavigation ? !navOrigins.has(origin) : !resourceOrigins.has(origin)) return route.abort('blockedbyclient')
      const method = request.method()
      const contentType = method === 'POST' ? await request.headerValue('content-type').catch(() => null) : null
      if (isManualLoginPostAllowed({ method, targetUrl: target, contentType, manualAuthOrigin: loginOrigin, manualAuthPaths: formPaths, isManualAuthActive: () => control.manualAuthActive })) return route.continue()
      if (method !== 'GET' && method !== 'HEAD') return route.abort('blockedbyclient')
      return route.continue()
    })
    control.stage = 'navigation'
    await control.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    control.loginPath = new URL(control.page.url()).pathname
    control.stage = 'login_form_discovery'
    const paths = await control.page.locator('form').evaluateAll((forms) => forms
      .filter((form) => form.method.toUpperCase() === 'POST' && form.querySelector('input[type="password"]'))
      .map((form) => { try { const target = new URL(form.action, location.href); return target.origin === location.origin ? target.pathname : null } catch { return null } })
      .filter(Boolean))
    for (const path of paths) formPaths.add(path)
    if (!formPaths.size) throw new Error('No same-origin manual login form was found; authentication remains closed.')
    await options.onPageReady?.(control.page)
    if (control.page.isClosed() || !control.browser.isConnected()) throw new Error('Browser closed before inspection session became ready.')
    control.manualAuthActive = true
    control.state = 'WAITING_FOR_MANUAL_LOGIN'
    control.stage = 'session_ready'
    logLifecycle(control, 'session_ready', { state: control.state, pagePath: safePath(control.page.url()) })
    const ttlMs = Number.isSafeInteger(options.sessionTtlMs) && options.sessionTtlMs > 0
      ? Math.min(options.sessionTtlMs, SESSION_TTL_MS)
      : SESSION_TTL_MS
    control.timer = setTimeout(() => closeHcmInspection(id, 'expired'), ttlMs)
    control.timer.unref?.()
    return { id, state: control.state, pagePath: safePath(control.page.url()), expiresInMs: ttlMs }
  } catch (error) {
    logLifecycle(control, 'session_start_failed', { stage: control.stage, errorName: String(error?.name || 'Error').slice(0, 40), failureCategory: failureCategory(error) })
    await closeControl(control, 'creation_failed')
    throw error
  }
}

export async function resumeHcmInspection(id) {
  const control = sessions.get(id)
  if (!control || control.state !== 'WAITING_FOR_MANUAL_LOGIN') return false
  let origin
  try { origin = normalizeAllowedOrigin(new URL(control.page.url()).origin) } catch { return false }
  if (!control.navigationOrigins.has(origin)) return false
  const stillHasPassword = await control.page.locator('input[type="password"]').count().catch(() => 0)
  if (stillHasPassword && new URL(control.page.url()).pathname === control.loginPath) return false
  control.manualAuthActive = false
  control.state = 'AUTHENTICATED_READ_ONLY'
  return true
}

export async function captureHcmInspection(id) {
  const control = sessions.get(id)
  if (!control || control.state !== 'AUTHENTICATED_READ_ONLY' || !control.page || control.page.isClosed()) return null
  let origin
  try { origin = normalizeAllowedOrigin(new URL(control.page.url()).origin) } catch { return null }
  if (origin !== control.registeredOrigin && !control.navigationOrigins.has(origin)) return null
  return { state: control.state, pagePath: safePath(control.page.url()), snapshot: await extractHcmWizardSnapshot(control.page) }
}

async function closeControl(control, reason = 'explicit_close') {
  if (control.cleanupPromise) return control.cleanupPromise
  control.state = 'CLOSING'
  logLifecycle(control, 'cleanup_started', { reason })
  control.cleanupPromise = (async () => {
    if (control.timer) clearTimeout(control.timer)
    sessions.delete(control.id)
    const closeStep = async (step, action) => {
      try { await action() } catch (error) {
        logLifecycle(control, 'cleanup_step_failed', { step, errorName: String(error?.name || 'Error').slice(0, 40), failureCategory: failureCategory(error) })
      }
    }
    if (control.page && !control.page.isClosed()) await closeStep('page', () => control.page.close())
    if (control.context) await closeStep('context', () => control.context.close())
    if (control.browser) await closeStep('browser', () => control.browser.close())
    if (control.proxy) await closeStep('proxy', () => control.proxy.close())
    control.state = reason === 'expired' ? 'EXPIRED' : reason === 'browser_failure' ? 'FAILED' : 'CLOSED'
    logLifecycle(control, 'cleanup_complete', { reason, state: control.state })
  })()
  return control.cleanupPromise
}

export async function closeHcmInspection(id, reason = 'explicit_close') {
  const control = sessions.get(id)
  if (!control) return false
  await closeControl(control, reason)
  return true
}

export function getHcmInspectionState(id) {
  const control = sessions.get(id)
  return control ? { id, state: control.state } : null
}
