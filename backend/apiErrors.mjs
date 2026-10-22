export function phase1ErrorDetails(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const missingDatabaseConfig = error instanceof Error && error.message === 'DATABASE_URL is not configured.'
  if (code === '23503') return { status: 422, error: 'The selected application reference is invalid.' }
  if (code === '23505') return { status: 409, error: 'The record conflicts with an existing record.' }
  if (code || missingDatabaseConfig) return { status: 503, error: 'Database request failed. Please retry.' }

  const message = error instanceof Error ? error.message : 'Request could not be processed.'
  return {
    status: 400,
    error: message
      .replace(/password|passwd|pwd/gi, '[redacted-field]')
      .replace(/https?:\/\/\S+/gi, '[redacted-url]')
      .slice(0, 500),
  }
}
