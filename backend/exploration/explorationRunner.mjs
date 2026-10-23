import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import { chromium } from 'playwright'
import { createSecurityProxy, normalizeAllowedOrigin } from './networkSecurity.mjs'
import { validateExplorationPayload } from './explorationValidation.mjs'
import { extractPageData, sanitizeExplorationUrl } from './explorationExtraction.mjs'
import {
  getApplicationById,
  persistExplorationResult,
} from '../database.mjs'

/** Maps browser navigation errors to fail-closed exploration statuses. */
export function classifyNavigationError(error) {
  const lower = String(error?.message || error || '').toLowerCase()
  if (lower.includes('blockedbyclient') || lower.includes('err_blocked_by_client')) return 'SECURITY_BLOCKED'
  if (lower.includes('err_tunnel_connection_failed') || lower.includes('err_proxy_connection_failed')) return 'FAILED'
  if (/\b403\b/.test(lower)) return 'FAILED'
  if (lower.includes('timeout') || lower.includes('timed out')) return 'TIMEOUT'
  return null
}

export function classifyNetworkFailure(error, phase = 'navigation') {
  if (phase === 'proxy-startup') return 'PROXY_FAILURE'
  const message = String(error?.message || error || '').toLowerCase()
  if (message.includes('err_cert') || message.includes('certificate')) return 'TLS_VALIDATION_FAILED'
  if (message.includes('proxy') || message.includes('tunnel')) return 'PROXY_FAILURE'
  if (message.includes('enotfound') || message.includes('eai_again') || message.includes('dns')) return 'DNS_VALIDATION_FAILED'
  if (message.includes('connection refused') || message.includes('econnrefused') || message.includes('econnreset') || message.includes('socket hang up')) return 'PROXY_FAILURE'
  return 'DNS_VALIDATION_FAILED'
}

function diagnosticDetails(outcome, stage, category, topLevelNavigation, explanation, hostname = null, port = null) {
  const reasonCode = outcome
  const recommendedAction = outcome === 'OUT_OF_SCOPE' || outcome === 'REDIRECT_BLOCKED'
    ? 'Review this application’s navigation and resource origin approvals; approve only origins required by the application.'
    : outcome === 'PRIVATE_IP_BLOCKED'
      ? 'Use a public destination; private and reserved address ranges are intentionally denied.'
      : outcome === 'DNS_VALIDATION_FAILED'
        ? 'Check the hostname DNS records and retry after DNS is healthy.'
        : outcome === 'TLS_VALIDATION_FAILED'
          ? 'Check the destination certificate chain and hostname; certificate validation remains enabled.'
          : outcome === 'PORT_BLOCKED'
            ? 'Use HTTP port 80 or HTTPS port 443.'
            : outcome === 'PROXY_FAILURE'
              ? 'Check outbound connectivity from the Chronos host to the validated destination.'
              : outcome === 'REMOTE_HTTP_ERROR'
                ? 'Check whether the destination permits read-only requests from this network and user agent.'
              : 'Review the read-only request policy and the recorded request category.'
  return { stage, reasonCode, hostname, port, category, topLevelNavigation, explanation, recommendedAction }
}

/**
 * Runs a bounded, strictly read-only exploration of a registered application's web interface
 * through an enforced outbound network security boundary.
 *
 * @param {object} params
 * @param {string} params.applicationId - ID of registered application.
 * @param {string} [params.targetUrl] - Starting URL (optional, defaults to application base_url).
 * @param {number} [params.timeoutMs=15000] - Exploration timeout.
 * @param {object} [options]
 * @param {function} [options.dnsLookup] - Injected DNS lookup for security tests.
 * @param {boolean} [options.persist=true] - Whether to save result to database.
 * @returns {Promise<object>} Structured exploration result.
 */
export async function runExploration(params, options = {}) {
  const startTime = Date.now()
  const explorationId = `exp-${randomUUID()}`
  const auditEvents = []
  let allowedResourceCount = 0
  let blockedResourceCount = 0
  const getAuditEvents = () => [...new Map(auditEvents.map((event) => {
    const stage = event.stage || ({ OUT_OF_SCOPE: 'origin_policy', REDIRECT_BLOCKED: 'redirect_policy', PORT_BLOCKED: 'port_policy', PRIVATE_IP_BLOCKED: 'destination_validation', DNS_VALIDATION_FAILED: 'dns_validation', TLS_VALIDATION_FAILED: 'tls_validation', PROXY_FAILURE: 'proxy_connection' }[event.outcome] || 'request_interception')
    const explanation = event.explanation || event.reason || `Request was denied by the ${stage.replaceAll('_', ' ')}.`
    const diagnostic = { ...event, ...diagnosticDetails(event.outcome, stage, event.category || 'unknown', event.topLevelNavigation ?? null, explanation, event.hostname || null, event.port || null), reasonCode: event.reasonCode || event.outcome }
    return [`${diagnostic.outcome}|${diagnostic.hostname}|${diagnostic.port}|${diagnostic.category}|${diagnostic.topLevelNavigation}`, diagnostic]
  })).values()]
  const getAuditSummary = (mainDocumentStatus, mainDocumentInspectable) => {
    const events = getAuditEvents()
    return { mainDocumentStatus, allowedResources: allowedResourceCount, blockedResources: blockedResourceCount, blockedByReason: auditEvents.reduce((summary, event) => ({ ...summary, [event.outcome]: (summary[event.outcome] || 0) + 1 }), {}), mainDocumentInspectable, partial: mainDocumentInspectable && blockedResourceCount > 0 }
  }

  // 1. Load application from database
  const application = await getApplicationById(params.applicationId)
  if (!application) {
    throw new Error('Registered application not found.')
  }
  if (application.status === 'Archived') {
    throw new Error('Cannot explore an archived application.')
  }

  // 2. Validate payload and scope
  const validated = validateExplorationPayload(params, application)
  const targetUrl = validated.targetUrl
  const allowedHost = validated.baseHost
  const timeoutMs = validated.timeoutMs

  let proxy = null
  let browser = null
  let context = null
  let page = null

  try {
    // 3. Start dedicated outbound security proxy
    proxy = await createSecurityProxy({
      allowedHost,
      primaryOrigin: validated.primaryOrigin,
      resourceOrigins: validated.resourceOrigins,
      navigationOrigins: validated.navigationOrigins,
      connectTimeoutMs: Math.min(timeoutMs, 8000),
      dnsLookup: options.dnsLookup,
      testTargetIp: options.testTargetIp,
      testTargetPort: options.testTargetPort,
      onSecurityViolation: (violation) => {
        blockedResourceCount++
        const mainHost = (() => { try { return new URL(targetUrl).hostname.toLowerCase().replace(/\.$/, '') } catch { return null } })()
        const violationHost = String(violation.hostname || '').toLowerCase().replace(/\.$/, '')
        const isMainDocument = violation.category === 'navigation' || (!violation.category || violation.category === 'unknown') && violationHost === mainHost
        const event = { outcome: violation.type || 'OUT_OF_SCOPE', hostname: violation.hostname || null, port: violation.port || null, category: isMainDocument ? 'document' : violation.category || 'unknown', topLevelNavigation: isMainDocument, stage: violation.stage, reason: violation.reason || undefined, explanation: violation.reason || undefined, explicitResourceEntryNeeded: violation.explicitResourceEntryNeeded || false }
        if (!auditEvents.some((item) => JSON.stringify(item) === JSON.stringify(event))) auditEvents.push(event)
      },
    }).catch(() => { throw new Error('Outbound proxy startup failed.') })

    // 4. Launch Chromium configured with proxy
    browser = await chromium.launch({
      timeout: timeoutMs,
      headless: true,
      proxy: {
        server: proxy.proxyUrl,
        bypass: '<-loopback>',
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-quic',
        '--dns-prefetch-disable',
        '--disable-background-networking',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--proxy-bypass-list=<-loopback>',
        `--proxy-server=${proxy.proxyUrl}`,
      ],
    })

    // 5. Create isolated browser context with TLS certificate validation enabled
    context = await browser.newContext({
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 800 },
      userAgent: 'Chronos-Security-Audit/2.1 (Read-Only Exploration Engine)',
    })

    page = await context.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)

    // 6. Network request interception for secondary defense and redirect detection
    await context.route('**', async (route) => {
      const request = route.request()
      const reqUrlStr = request.url()

      let parsed
      try {
        parsed = new URL(reqUrlStr)
      } catch {
        blockedResourceCount++
        auditEvents.push({ outcome: 'OUT_OF_SCOPE', hostname: null, port: null, category: request.resourceType(), topLevelNavigation: request.isNavigationRequest(), reason: 'Malformed request URL.' })
        return route.abort('blockedbyclient')
      }

      // Protocol enforcement
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        blockedResourceCount++
        auditEvents.push({ outcome: 'OUT_OF_SCOPE', hostname: null, port: null, category: request.resourceType(), topLevelNavigation: request.isNavigationRequest(), reason: 'Unsupported request protocol.' })
        return route.abort('blockedbyclient')
      }

      // Check destination scope: main frame navigation must be within registered scope
      const permittedNavigationOrigins = new Set([normalizeAllowedOrigin(validated.primaryOrigin), ...validated.navigationOrigins.map(normalizeAllowedOrigin)])
      const permittedResourceOrigins = new Set([normalizeAllowedOrigin(validated.primaryOrigin), ...validated.resourceOrigins.map(normalizeAllowedOrigin)])
      const isTopNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame()
      const requestPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      if (requestPort !== 80 && requestPort !== 443) {
        blockedResourceCount++
        auditEvents.push({ outcome: 'PORT_BLOCKED', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), port: requestPort, category: request.resourceType(), topLevelNavigation: isTopNavigation, reason: 'Only standard web ports 80 and 443 are permitted.' })
        if (isTopNavigation && request.redirectedFrom()) auditEvents.push({ outcome: 'REDIRECT_BLOCKED', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), port: requestPort, category: 'document', topLevelNavigation: true, reason: 'Redirect destination uses a prohibited port.' })
        return route.abort('blockedbyclient')
      }
      let requestOrigin
      try { requestOrigin = normalizeAllowedOrigin(parsed.origin) } catch {
        blockedResourceCount++
        auditEvents.push({ outcome: 'OUT_OF_SCOPE', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), port: requestPort, category: request.resourceType(), topLevelNavigation: isTopNavigation, reason: 'Request origin is invalid or prohibited.' })
        return route.abort('blockedbyclient')
      }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        blockedResourceCount++
        auditEvents.push({ outcome: 'OUT_OF_SCOPE', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)), category: request.resourceType(), topLevelNavigation: isTopNavigation, reason: 'Read-only policy blocks non-GET/HEAD requests.' })
        return route.abort('blockedbyclient')
      }
      if (isTopNavigation && !permittedNavigationOrigins.has(requestOrigin)) {
        blockedResourceCount++
        auditEvents.push({ outcome: request.redirectedFrom() ? 'REDIRECT_BLOCKED' : 'OUT_OF_SCOPE', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), port: requestPort, category: request.resourceType(), topLevelNavigation: true, explicitResourceEntryNeeded: false, reason: 'Top-level navigation origin is not approved.' })
        return route.abort('blockedbyclient')
      }
      if (!isTopNavigation && !permittedResourceOrigins.has(requestOrigin)) {
        blockedResourceCount++
        auditEvents.push({ outcome: 'OUT_OF_SCOPE', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)), category: request.resourceType(), topLevelNavigation: false, explicitResourceEntryNeeded: true, reason: 'Resource origin is not approved.' })
        return route.abort('blockedbyclient')
      }
      allowedResourceCount++

      // Continue through proxy
      return route.continue()
    })

    // Monitor redirects on main navigation
    let finalUrl = targetUrl
    page.on('response', (response) => {
      const status = response.status()
      if (status >= 300 && status < 400 && response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) {
        const location = response.headers()['location']
        if (location) {
          try {
            const redirectUrl = new URL(location, response.url())
            const navigationOrigins = new Set([normalizeAllowedOrigin(validated.primaryOrigin), ...validated.navigationOrigins.map(normalizeAllowedOrigin)])
            let redirectAllowed = false
            try { redirectAllowed = navigationOrigins.has(normalizeAllowedOrigin(redirectUrl.origin)) } catch {}
            if (!redirectAllowed) {
              const event = { outcome: 'REDIRECT_BLOCKED', hostname: redirectUrl.hostname.toLowerCase().replace(/\.$/, ''), port: Number(redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80)), category: 'document', topLevelNavigation: true, explicitResourceEntryNeeded: false, reason: 'Redirect destination is not an approved navigation origin.' }
              if (!auditEvents.some((item) => JSON.stringify(item) === JSON.stringify(event))) auditEvents.push(event)
            }
          } catch {
            auditEvents.push({ outcome: 'REDIRECT_BLOCKED', hostname: null, port: null, category: 'document', topLevelNavigation: true, explicitResourceEntryNeeded: false, reason: 'Redirect destination could not be validated.' })
          }
        }
      }
    })

    // 7. Navigate to destination
    let navResponse = null
    try {
      navResponse = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      })
      finalUrl = page.url()
    } catch (navError) {
      const navigationFailureStatus = classifyNavigationError(navError)
      if (navigationFailureStatus === 'SECURITY_BLOCKED') {
        const result = {
          id: explorationId,
          applicationId: application.id,
          targetUrl: sanitizeExplorationUrl(targetUrl),
          status: 'SECURITY_BLOCKED',
          title: 'Blocked by Security Policy',
          metaDescription: null,
          headings: [],
          links: [],
          forms: [],
          interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
          authDetected: false,
          warnings: getAuditEvents(),
          auditSummary: getAuditSummary(null, false),
          durationMs: Date.now() - startTime,
          createdAt: new Date().toISOString(),
        }
        if (options.persist !== false) {
          await persistExplorationResult(result).catch(() => {})
        }
        return result
      }

      if (navigationFailureStatus === 'TIMEOUT') {
        const result = {
          id: explorationId,
          applicationId: application.id,
          targetUrl: sanitizeExplorationUrl(targetUrl),
          status: 'TIMEOUT',
          title: 'Navigation Timeout',
          metaDescription: null,
          headings: [],
          links: [],
          forms: [],
          interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
          authDetected: false,
          warnings: getAuditEvents(),
          auditSummary: getAuditSummary(null, false),
          durationMs: Date.now() - startTime,
          createdAt: new Date().toISOString(),
        }
        if (options.persist !== false) {
          await persistExplorationResult(result).catch(() => {})
        }
        return result
      }

      throw navError
    }

    // Check if security proxy returned 403 Forbidden
    if (navResponse && (navResponse.status() === 403 || navResponse.status() === 502)) {
      const isSecurityBlocked = auditEvents.some((event) => event.topLevelNavigation === true) || navResponse.status() === 502 && auditEvents.some((event) => event.outcome === 'PROXY_FAILURE' || event.outcome === 'DNS_VALIDATION_FAILED' || event.outcome === 'PRIVATE_IP_BLOCKED')
      if (isSecurityBlocked) {
        const result = {
          id: explorationId,
          applicationId: application.id,
          targetUrl: sanitizeExplorationUrl(targetUrl),
          status: 'SECURITY_BLOCKED',
          title: 'Blocked by Security Policy',
          metaDescription: null,
          headings: [],
          links: [],
          forms: [],
          interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
          authDetected: false,
          warnings: getAuditEvents(),
          auditSummary: getAuditSummary(navResponse?.status() ?? null, false),
          durationMs: Date.now() - startTime,
          createdAt: new Date().toISOString(),
        }
        if (options.persist !== false) {
          await persistExplorationResult(result).catch(() => {})
        }
        return result
      }
    }

    if (navResponse && navResponse.status() >= 400 && !auditEvents.some((event) => event.topLevelNavigation === true)) {
      const status = navResponse.status()
      const remotePort = (() => { try { const url = new URL(navResponse.url()); return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) } catch { return null } })()
      auditEvents.push({ outcome: 'REMOTE_HTTP_ERROR', hostname: (() => { try { return new URL(navResponse.url()).hostname.toLowerCase() } catch { return null } })(), port: remotePort, category: 'document', topLevelNavigation: true, stage: 'remote_response', reasonCode: `HTTP_${status}`, reason: `The destination returned HTTP ${status}; Chronos did not block the request.`, explanation: `The destination returned HTTP ${status}; Chronos did not block the request.` })
    }

    // Brief stabilization delay
    await page.waitForLoadState('load', { timeout: 2000 }).catch(() => {})

    // 8. Extract safe, bounded, structured page information
    const extracted = await extractPageData(page, finalUrl)

    const result = {
      id: explorationId,
      applicationId: application.id,
      targetUrl: sanitizeExplorationUrl(finalUrl),
      status: navResponse?.status() >= 400 ? 'FAILED' : blockedResourceCount > 0 && extracted.status === 'SUCCESS' ? 'PARTIAL' : extracted.status,
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      headings: extracted.headings,
      links: extracted.links,
      forms: extracted.forms,
      interactiveElements: extracted.interactiveElements,
      authDetected: extracted.authDetected,
      warnings: getAuditEvents(),
      auditSummary: getAuditSummary(navResponse?.status() ?? null, true),
      durationMs: Date.now() - startTime,
      createdAt: new Date().toISOString(),
    }

    // 9. Persist result
    if (options.persist !== false) {
      await persistExplorationResult(result).catch((err) => {
        auditEvents.push({ outcome: 'PROXY_FAILURE', hostname: null, port: null, category: 'audit', topLevelNavigation: false, reason: 'Result persistence failed.' })
        result.warnings = getAuditEvents()
        result.auditSummary = getAuditSummary(navResponse?.status() ?? null, true)
      })
    }

    return result
  } catch (err) {
    const failureStatus = classifyNavigationError(err)
    const lower = (err.message || '').toLowerCase()
    const isSecurityError = failureStatus === 'SECURITY_BLOCKED' ||
      lower.includes('prohibited') ||
      lower.includes('denied') ||
      lower.includes('out of registered scope') ||
      lower.includes('blocked host')

    if (!auditEvents.length && failureStatus !== 'TIMEOUT') {
      const outcome = classifyNetworkFailure(err, lower.includes('startup') ? 'proxy-startup' : 'navigation')
      const reason = outcome === 'PROXY_FAILURE' && lower.includes('startup') ? 'Outbound proxy startup failed.' : outcome === 'PROXY_FAILURE' ? 'Outbound proxy connection failed.' : outcome === 'TLS_VALIDATION_FAILED' ? 'TLS certificate validation failed.' : 'DNS resolution or validation failed.'
      auditEvents.push({ outcome, hostname: (() => { try { return new URL(targetUrl).hostname.toLowerCase() } catch { return null } })(), port: 443, category: 'document', topLevelNavigation: true, stage: lower.includes('startup') ? 'proxy_startup' : outcome === 'TLS_VALIDATION_FAILED' ? 'tls_validation' : outcome === 'PROXY_FAILURE' ? 'proxy_connection' : 'dns_validation', reason, explanation: reason })
    }

    const result = {
      id: explorationId,
      applicationId: application.id,
      targetUrl: sanitizeExplorationUrl(targetUrl),
      status: isSecurityError ? 'SECURITY_BLOCKED' : failureStatus === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED',
      title: isSecurityError ? 'Blocked by Security Policy' : 'Exploration Failed',
      metaDescription: null,
      headings: [],
      links: [],
      forms: [],
      interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
      authDetected: false,
      warnings: getAuditEvents(),
      auditSummary: getAuditSummary(null, false),
      durationMs: Date.now() - startTime,
      createdAt: new Date().toISOString(),
    }

    if (options.persist !== false) {
      await persistExplorationResult(result).catch(() => {})
    }

    return result
  } finally {
    // 10. Clean up all resources reliably in finally block
    if (page) await page.close().catch(() => {})
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (proxy) await proxy.close().catch(() => {})
  }
}
