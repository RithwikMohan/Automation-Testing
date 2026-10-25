import Papa from 'papaparse'

const REQUIRED_HEADERS = ['test_case_id', 'name', 'preconditions', 'steps', 'test_data', 'expected_result', 'priority']
const SECRET_NAME = /password|passwd|passcode|pwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|authentication|authorization|credential|cookie|secret|private[_-]?key|api[_-]?key/i
const SECRET_ASSIGNMENT = /(?:password|passwd|passcode|pwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|credential|cookie|secret|private[_-]?key|api[_-]?key)\s*[:=]\s*\S+/i
const TOKEN_VALUE = /\bBearer\s+[A-Za-z0-9._~-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i

export function normalizeHeader(header) {
  return String(header || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function parseJsonField(value, fallback, label, errors) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return fallback
  try { return JSON.parse(trimmed) } catch {
    errors.push(label + ' must contain valid JSON.')
    return fallback
  }
}

export function parseTestCaseCsv(csvText, { workflowVariables, workflowVersion } = {}) {
  if (typeof csvText !== 'string' || !csvText.trim()) return { rows: [], errors: ['CSV content is empty.'] }
  if (csvText.length > 2_000_000) return { rows: [], errors: ['CSV content exceeds the 2 MB import limit.'] }
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: 'greedy', transformHeader: normalizeHeader })
  const fields = (parsed.meta.fields || []).map(normalizeHeader)
  const workflowMode = Array.isArray(workflowVariables)
  const allowedCredentialKeys = new Set(workflowMode ? workflowVariables.filter((variable) => variable.credential === true && variable.key === 'password').map((variable) => variable.key) : [])
  const requiredHeaders = workflowMode ? REQUIRED_HEADERS.filter((header) => header !== 'test_data') : REQUIRED_HEADERS
  const missing = [...requiredHeaders.filter((header) => !fields.includes(header)), ...(workflowMode ? workflowVariables.filter((variable) => variable.variable !== false && !fields.includes(variable.key)).map((variable) => variable.key) : [])]
  const errors = []
  if (new Set(fields).size !== fields.length) return { rows: [], errors: ['CSV contains duplicate column headers after normalization.'] }
  if (missing.length) return { rows: [], errors: ['Missing required CSV columns: ' + missing.join(', ') + '.'] }
  const credentialColumns = fields.filter((field) => SECRET_NAME.test(field) && !allowedCredentialKeys.has(field))
  if (credentialColumns.length) return { rows: [], errors: ['Credential-like CSV columns are not accepted: ' + credentialColumns.join(', ') + '.'] }
  if (workflowMode) {
    const fixed = new Set([...REQUIRED_HEADERS, 'test_case_id', 'name', 'preconditions', 'steps', 'expected_result', 'priority', 'tags'])
    const allowed = new Set([...fixed, ...workflowVariables.filter((variable) => variable.variable !== false).map((variable) => variable.key)])
    const unexpected = fields.filter((field) => !allowed.has(field))
    if (unexpected.length) errors.push('CSV contains columns not defined by the selected workflow: ' + unexpected.join(', ') + '.')
  }
  if ((parsed.data || []).length > 500) errors.push('CSV imports are limited to 500 test cases.')
  for (const error of parsed.errors || []) errors.push('CSV row ' + (error.row + 2) + ': ' + error.message)

  const seenIds = new Set()
  const rows = (parsed.data || []).map((raw, index) => {
    const rowErrors = []
    const rowNumber = index + 2
    const testCaseId = String(raw.test_case_id || '').trim()
    const name = String(raw.name || '').trim()
    const steps = String(raw.steps || '').trim()
    const expectedResult = String(raw.expected_result || '').trim()
    const priority = String(raw.priority || 'normal').trim().toLowerCase()
    const idKey = testCaseId.toLowerCase()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(testCaseId)) rowErrors.push('Test case ID must be 1-80 letters, numbers, dots, underscores, or hyphens.')
    if (!name || name.length > 200) rowErrors.push('Name is required and must be at most 200 characters.')
    if (!steps) rowErrors.push('Steps are required.')
    if (steps.length > 10000) rowErrors.push('Steps cannot exceed 10,000 characters.')
    if (!expectedResult) rowErrors.push('Expected result is required.')
    if (expectedResult.length > 10000) rowErrors.push('Expected result cannot exceed 10,000 characters.')
    if (!['low', 'normal', 'high', 'critical'].includes(priority)) rowErrors.push('Priority must be low, normal, high, or critical.')
    if (testCaseId && seenIds.has(idKey)) rowErrors.push('Duplicate test case ID "' + testCaseId + '" in this CSV.')
    if (testCaseId) seenIds.add(idKey)
    if (SECRET_ASSIGNMENT.test(steps) || SECRET_ASSIGNMENT.test(expectedResult) || SECRET_ASSIGNMENT.test(String(raw.preconditions || '')) || SECRET_ASSIGNMENT.test(name) || SECRET_ASSIGNMENT.test(String(raw.tags || '')) || Object.values(raw).some((value) => TOKEN_VALUE.test(String(value || '')))) {
      rowErrors.push('Credentials and tokens must not appear in test steps, preconditions, or expected results.')
    }

    const preconditions = parseJsonField(raw.preconditions, [], 'Preconditions', rowErrors)
    const testData = workflowMode && !fields.includes('test_data')
      ? Object.fromEntries(workflowVariables.filter((variable) => variable.variable !== false).map((variable) => [variable.key, String(raw[variable.key] ?? '')]))
      : parseJsonField(raw.test_data, {}, 'Test data', rowErrors)
    if (workflowMode && !fields.includes('test_data')) {
      for (const variable of workflowVariables.filter((item) => item.variable !== false && item.required !== false)) {
        if (!String(testData[variable.key] ?? '').trim()) rowErrors.push(`Required workflow field "${variable.label || variable.key}" is missing.`)
      }
    }
    if (!Array.isArray(preconditions) || preconditions.some((value) => typeof value !== 'string' || value.length > 500)) rowErrors.push('Preconditions must be a JSON array of short strings.')
    if (!testData || typeof testData !== 'object' || Array.isArray(testData)) rowErrors.push('Test data must be a JSON object.')
    else {
      if (Object.keys(testData).length > 50) rowErrors.push('Test data is limited to 50 named values.')
      if (Object.keys(testData).some((key) => SECRET_NAME.test(key) && !allowedCredentialKeys.has(key)) || Object.values(testData).some((value) => typeof value === 'string' && TOKEN_VALUE.test(value))) rowErrors.push('Test data may contain passwords, tokens, cookies, secrets, or API keys unless password is an explicitly reviewed workflow field.')
      if (Object.values(testData).some((value) => (typeof value !== 'string' && typeof value !== 'number') || typeof value === 'string' && value.length > 2000)) rowErrors.push('Test data values must be strings or numbers up to 2,000 characters.')
    }
    const tags = String(raw.tags || '').split(/[;,]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 20)
    if (workflowMode && workflowVersion) {
      const embeddedVersion = tags.map((tag) => tag.match(/^workflow-v(\d+)$/i)).find(Boolean)?.[1]
      if (embeddedVersion && Number(embeddedVersion) !== workflowVersion) rowErrors.push(`CSV workflow version ${embeddedVersion} does not match selected version ${workflowVersion}.`)
    }
    return { rowNumber, testCaseId, name, preconditions, rawSteps: steps, testData, expectedResult, priority, tags, errors: rowErrors }
  })
  return { rows, errors }
}
