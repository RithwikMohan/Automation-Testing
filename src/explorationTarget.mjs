/** Resolve the registered Base URL from either the database/API or form spelling. */
export function getRegisteredBaseUrl(app) {
  return app.base_url?.trim() || app.baseUrl?.trim() || ''
}

export const MISSING_BASE_URL_MESSAGE = 'This registered application has no Base URL. Edit the application and add a valid Base URL before inspecting it.'
