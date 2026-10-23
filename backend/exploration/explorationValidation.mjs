import { URL } from 'node:url'
import { normalizeAllowedOrigin } from './networkSecurity.mjs'

/**
 * Validates an exploration target URL against the registered application's base URL and scope.
 */
export function validateExplorationUrl(targetUrl, applicationBaseUrl, applicationNavigationOrigins = []) {
  if (typeof targetUrl !== 'string' || !targetUrl.trim()) {
    throw new Error('Exploration target URL is required.')
  }

  const trimmed = targetUrl.trim()
  let parsedTarget
  try {
    parsedTarget = new URL(trimmed)
  } catch {
    throw new Error('Exploration target URL is malformed or invalid.')
  }

  if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
    throw new Error(`Exploration URL must use http or https protocol. Unsupported scheme: ${parsedTarget.protocol}`)
  }

  if (parsedTarget.username || parsedTarget.password) {
    throw new Error('Exploration URL must not contain embedded credentials (username/password).')
  }

  for (const key of parsedTarget.searchParams.keys()) {
    if (/^(password|passwd|pwd|token|access_token|refresh_token|session|sessionid|sid|cookie)$/i.test(key)) {
      throw new Error('Exploration URL must not contain credential or session query parameters.')
    }
  }

  let parsedBase
  try {
    parsedBase = new URL(applicationBaseUrl)
  } catch {
    throw new Error('Application base URL is invalid or malformed.')
  }

  const permittedNavigationOrigins = new Set([normalizeAllowedOrigin(parsedBase.origin), ...applicationNavigationOrigins.map(normalizeAllowedOrigin)])
  if (!permittedNavigationOrigins.has(normalizeAllowedOrigin(parsedTarget.origin))) {
    throw new Error(`Exploration target origin "${parsedTarget.origin}" is not an approved navigation origin.`)
  }

  // Normalize target URL
  let normalized = parsedTarget.origin + parsedTarget.pathname.replace(/\/+$/, '')
  if (parsedTarget.pathname === '/' || !parsedTarget.pathname) normalized = parsedTarget.origin
  if (parsedTarget.search) normalized += parsedTarget.search

  return {
    normalizedUrl: normalized,
    origin: parsedTarget.origin,
    hostname: parsedTarget.hostname,
    protocol: parsedTarget.protocol,
    pathname: parsedTarget.pathname,
    baseHost: parsedBase.hostname,
  }
}

/**
 * Validates the payload for an exploration request.
 */
export function validateExplorationPayload(payload, application) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Exploration request payload must be an object.')
  }

  if (!application) {
    throw new Error('Registered application not found.')
  }

  if (application.status === 'Archived') {
    throw new Error('Cannot explore an archived application.')
  }

  const rawTargetUrl = payload.targetUrl || application.base_url
  const validatedUrl = validateExplorationUrl(rawTargetUrl, application.base_url, application.approved_navigation_origins || [])

  let timeoutMs = 15000
  if (payload.timeoutMs !== undefined) {
    const num = Number(payload.timeoutMs)
    if (!Number.isFinite(num) || num < 2000 || num > 30000) {
      throw new Error('Timeout must be between 2,000ms and 30,000ms.')
    }
    timeoutMs = num
  }

  return {
    applicationId: application.id,
    targetUrl: validatedUrl.normalizedUrl,
    hostname: validatedUrl.hostname,
    baseHost: validatedUrl.baseHost,
    primaryOrigin: new URL(application.base_url).origin,
    resourceOrigins: application.approved_resource_origins || [],
    navigationOrigins: application.approved_navigation_origins || [],
    timeoutMs,
  }
}
