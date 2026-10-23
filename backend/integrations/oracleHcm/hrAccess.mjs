import { timingSafeEqual } from 'node:crypto'

/** Fail closed when the HR feature token is not configured. */
export function isAuthorizedHrRequest(providedToken, configuredToken) {
  if (typeof providedToken !== 'string' || typeof configuredToken !== 'string' || configuredToken.length < 32) return false
  const provided = Buffer.from(providedToken)
  const configured = Buffer.from(configuredToken)
  return provided.length === configured.length && timingSafeEqual(provided, configured)
}

export function isRegisteredHcmApp(application) {
  if (!application || application.status !== 'Active' || application.auth_method !== 'manual') return false
  try {
    const url = new URL(application.base_url)
    return url.protocol === 'https:' && url.hostname === 'fa-erzp-dev26-saasfademo1.ds-fa.oraclepdemos.com'
  } catch {
    return false
  }
}
