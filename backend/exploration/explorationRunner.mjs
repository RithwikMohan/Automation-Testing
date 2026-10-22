import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import { chromium } from 'playwright'
import { createSecurityProxy, isHostInScope } from './networkSecurity.mjs'
import { validateExplorationPayload } from './explorationValidation.mjs'
import { extractPageData } from './explorationExtraction.mjs'
import {
  getApplicationById,
  persistExplorationResult,
} from '../database.mjs'

/** Maps browser navigation errors to fail-closed exploration statuses. */
export function classifyNavigationError(error) {
  const lower = String(error?.message || error || '').toLowerCase()
  if (
    lower.includes('err_tunnel_connection_failed') ||
    lower.includes('err_proxy_connection_failed') ||
    lower.includes('403') ||
    lower.includes('blockedbyclient') ||
    lower.includes('err_blocked_by_client')
  ) return 'SECURITY_BLOCKED'
  if (lower.includes('timeout') || lower.includes('timed out')) return 'TIMEOUT'
  return null
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
  const warnings = []

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
      connectTimeoutMs: Math.min(timeoutMs, 8000),
      dnsLookup: options.dnsLookup,
      testTargetIp: options.testTargetIp,
      testTargetPort: options.testTargetPort,
      onSecurityViolation: (violation) => {
        warnings.push(`Network security boundary blocked access: ${violation.type} (${violation.host || violation.targetHost || violation.url || violation.error || ''})`)
      },
    })

    // 4. Launch Chromium configured with proxy
    browser = await chromium.launch({
      timeout: timeoutMs,
      headless: true,
      proxy: {
        server: proxy.proxyUrl,
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--proxy-server=${proxy.proxyUrl}`,
      ],
    })

    // 5. Create isolated browser context with TLS certificate validation enabled
    context = await browser.newContext({
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Chronos-Security-Audit/2.1 (Read-Only Exploration Engine)',
    })

    page = await context.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)

    // 6. Network request interception for secondary defense and redirect detection
    await page.route('**', async (route) => {
      const request = route.request()
      const reqUrlStr = request.url()

      let parsed
      try {
        parsed = new URL(reqUrlStr)
      } catch {
        warnings.push(`Blocked request with invalid URL: ${reqUrlStr.slice(0, 80)}`)
        return route.abort('blockedbyclient')
      }

      // Protocol enforcement
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        warnings.push(`Blocked request with unsupported protocol: ${parsed.protocol}`)
        return route.abort('blockedbyclient')
      }

      // Check destination scope: main frame navigation must be within registered scope
      if (request.isNavigationRequest() && !isHostInScope(parsed.hostname, allowedHost)) {
        warnings.push(`Blocked out-of-scope navigation to: ${parsed.hostname}`)
        return route.abort('blockedbyclient')
      }

      // Continue through proxy
      return route.continue()
    })

    // Monitor redirects on main navigation
    let finalUrl = targetUrl
    page.on('response', (response) => {
      const status = response.status()
      if (status >= 300 && status < 400 && response.request().isNavigationRequest()) {
        const location = response.headers()['location']
        if (location) {
          try {
            const redirectUrl = new URL(location, response.url())
            if (!isHostInScope(redirectUrl.hostname, allowedHost)) {
              warnings.push(`Redirect to out-of-scope host "${redirectUrl.hostname}" was detected and prevented.`)
            }
          } catch {}
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
          targetUrl,
          status: 'SECURITY_BLOCKED',
          title: 'Blocked by Security Policy',
          metaDescription: null,
          headings: [],
          links: [],
          forms: [],
          interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
          authDetected: false,
          warnings: [...warnings, 'Destination connection was terminated by outbound security boundary.'],
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
          targetUrl,
          status: 'TIMEOUT',
          title: 'Navigation Timeout',
          metaDescription: null,
          headings: [],
          links: [],
          forms: [],
          interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
          authDetected: false,
          warnings: [...warnings, 'Navigation exceeded allowed time limit.'],
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
      const isSecurityBlocked = warnings.some((w) => w.includes('security boundary') || w.includes('Blocked')) || navResponse.status() === 403
      if (isSecurityBlocked) {
        const result = {
          id: explorationId,
          applicationId: application.id,
          targetUrl,
          status: 'SECURITY_BLOCKED',
          title: 'Blocked by Security Policy',
          metaDescription: null,
          headings: [],
          links: [],
          forms: [],
          interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
          authDetected: false,
          warnings: [...warnings, 'Destination connection was rejected by outbound security boundary.'],
          durationMs: Date.now() - startTime,
          createdAt: new Date().toISOString(),
        }
        if (options.persist !== false) {
          await persistExplorationResult(result).catch(() => {})
        }
        return result
      }
    }

    // Brief stabilization delay
    await page.waitForLoadState('load', { timeout: 2000 }).catch(() => {})

    // 8. Extract safe, bounded, structured page information
    const extracted = await extractPageData(page, finalUrl)

    const result = {
      id: explorationId,
      applicationId: application.id,
      targetUrl: finalUrl,
      status: extracted.status,
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      headings: extracted.headings,
      links: extracted.links,
      forms: extracted.forms,
      interactiveElements: extracted.interactiveElements,
      authDetected: extracted.authDetected,
      warnings,
      durationMs: Date.now() - startTime,
      createdAt: new Date().toISOString(),
    }

    // 9. Persist result
    if (options.persist !== false) {
      await persistExplorationResult(result).catch((err) => {
        warnings.push(`Result persistence error: ${err.message}`)
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

    const result = {
      id: explorationId,
      applicationId: application.id,
      targetUrl,
      status: isSecurityError ? 'SECURITY_BLOCKED' : failureStatus === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED',
      title: isSecurityError ? 'Blocked by Security Policy' : 'Exploration Failed',
      metaDescription: null,
      headings: [],
      links: [],
      forms: [],
      interactiveElements: { buttonCount: 0, linkCount: 0, inputCount: 0, selectCount: 0 },
      authDetected: false,
      warnings: [...warnings, isSecurityError ? err.message : 'Exploration encountered an error.'],
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
