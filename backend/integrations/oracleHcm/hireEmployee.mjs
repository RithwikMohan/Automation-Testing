import Papa from 'papaparse'

export const ORACLE_HCM_HIRING_SCHEMA_VERSION = '1.0'

export const HIRING_COLUMNS = Object.freeze([
  'employee_id', 'first_name', 'last_name', 'legal_employer', 'action_reason',
  'business_unit', 'position', 'email', 'phone', 'expected_outcome',
])

const REQUIRED_COLUMNS = Object.freeze([
  'employee_id', 'first_name', 'last_name', 'legal_employer', 'action_reason',
  'business_unit', 'position',
])
const OUTCOMES = new Set(['success', 'validation_failure'])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMPLOYEE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Parse schema v1 CSV. Raw personal data is returned only for in-memory execution. */
export function parseHiringCsv(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) return { rows: [], errors: ['CSV content is empty.'] }
  if (csvText.length > 2_000_000) return { rows: [], errors: ['CSV exceeds the 2 MB limit.'] }

  const parsed = Papa.parse(csvText, {
    header: false,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  })
  const headers = (parsed.data?.[0] || []).map((header) => String(header).trim().toLowerCase())
  const errors = []
  if (new Set(headers).size !== headers.length) errors.push('CSV contains duplicate column headers.')
  const unknown = headers.filter((header) => !HIRING_COLUMNS.includes(header))
  if (unknown.length) errors.push('CSV contains unsupported columns: ' + unknown.join(', ') + '.')
  const missing = REQUIRED_COLUMNS.filter((header) => !headers.includes(header))
  if (missing.length) errors.push('CSV is missing required columns: ' + missing.join(', ') + '.')
  if (parsed.errors?.length) errors.push(...parsed.errors.map((error) => `CSV row ${error.row + 1} is malformed.`))
  const records = (parsed.data || []).slice(1)
  if (records.length > 100) errors.push('A hiring batch is limited to 100 rows.')

  const rows = records.map((record, index) => {
    const values = Object.fromEntries(headers.map((header, column) => [header, String(record[column] ?? '')]))
    return {
      rowNumber: index + 2,
      employeeId: String(values.employee_id || '').trim(),
      firstName: String(values.first_name || '').trim(),
      lastName: String(values.last_name || '').trim(),
      // Hire Date and Hire Action are defaults in this Oracle workflow and
      // intentionally do not come from the CSV.
      hireDate: '',
      legalEmployer: String(values.legal_employer || '').trim(),
      action: '',
      actionReason: String(values.action_reason || '').trim(),
      businessUnit: String(values.business_unit || '').trim(),
      position: String(values.position || '').trim(),
      email: String(values.email || '').trim(),
      phone: String(values.phone || '').trim(),
      expectedOutcome: String(values.expected_outcome || 'success').trim().toLowerCase(),
    }
  })
  return { rows, errors }
}

/** Validate each row against the actual dropdown choices read from the live page. */
export function validateHiringRows(rows, { dropdownOptions = {}, existingEmployeeIds = [] } = {}) {
  const existing = new Set(existingEmployeeIds.map((id) => String(id).toLowerCase()))
  const idCounts = new Map()
  for (const row of rows) {
    const id = String(row.employeeId || '').toLowerCase()
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1)
  }
  return rows.map((row) => {
    const errors = []
    for (const key of ['employeeId', 'firstName', 'lastName', 'legalEmployer', 'actionReason', 'businessUnit', 'position']) {
      if (!row[key]) errors.push(`${key} is required.`)
    }
    if (row.employeeId && !EMPLOYEE_ID.test(row.employeeId)) errors.push('employeeId has an unsupported format.')
    if (row.email && !EMAIL.test(row.email)) errors.push('email is not a valid email address.')
    if (row.expectedOutcome && !OUTCOMES.has(row.expectedOutcome)) errors.push('expectedOutcome must be success or validation_failure.')
    for (const [field, options] of Object.entries(dropdownOptions)) {
      if (!options || row[field] === undefined || row[field] === '') continue
      if (!options.some((option) => String(option).trim().toLowerCase() === String(row[field]).trim().toLowerCase())) errors.push(`${field} is not an available application option.`)
    }
    const foldedId = row.employeeId.toLowerCase()
    const duplicate = Boolean(row.employeeId && ((idCounts.get(foldedId) || 0) > 1 || existing.has(foldedId)))
    if (duplicate) errors.push('employeeId duplicates a row in this batch or an existing employee identifier.')
    if (row.expectedOutcome === 'validation_failure' && errors.length === 0) errors.push('This row expects a validation failure but has no known invalid field.')
    const invalidExpected = row.expectedOutcome === 'validation_failure' && errors.length > 0 && !duplicate
    return {
      rowNumber: row.rowNumber,
      employeeId: row.employeeId,
      expectedOutcome: OUTCOMES.has(row.expectedOutcome) ? row.expectedOutcome : 'success',
      status: duplicate ? 'DUPLICATE' : invalidExpected ? 'EXPECTED_VALIDATION_FAILURE' : errors.length ? 'INVALID' : 'READY',
      errors,
      // PII stays in memory for the executor and is never included in the preview result.
      data: row,
    }
  })
}

/** A preview-safe representation: never returns names, email, phone, or row data. */
export function toHiringPreviewRow(result) {
  return {
    rowNumber: result.rowNumber,
    expectedOutcome: result.expectedOutcome,
    status: result.status,
    errors: [...result.errors],
  }
}

export function summarizeHiringRows(rows) {
  return rows.reduce((summary, row) => {
    summary[row.status] = (summary[row.status] || 0) + 1
    return summary
  }, {})
}

/** Enforce one-time approval immediately before a creation operation. */
export function assertHiringApproval({ approved, rowStatus, expectedOutcome, signal }) {
  if (signal?.aborted) throw Object.assign(new Error('Hiring run was cancelled.'), { code: 'CANCELLED' })
  if (approved !== true) throw Object.assign(new Error('Explicit approval is required before creating employees.'), { code: 'APPROVAL_REQUIRED' })
  if (rowStatus !== 'READY' || expectedOutcome !== 'success') throw Object.assign(new Error('Only valid rows expected to succeed can be submitted.'), { code: 'ROW_NOT_SUBMITTABLE' })
}

/** Mark an unconfirmed submit as uncertain so callers cannot blindly retry it. */
export function classifyHiringSubmission({ response, confirmed, verification }) {
  if (!response || response.status >= 400) return { status: response ? 'UNEXPECTED_ERROR' : 'UNCERTAIN', retryAllowed: false }
  if (!confirmed || verification?.conclusive !== true) return { status: 'NEEDS_VERIFICATION', retryAllowed: false, personNumber: verification?.personNumber || null }
  return { status: 'SUCCESS', retryAllowed: false, personNumber: verification.personNumber || null }
}

export function classifyExpectedValidation({ expectedOutcome, validationMessageVisible, employeeCreated }) {
  if (expectedOutcome === 'validation_failure' && validationMessageVisible === true && employeeCreated !== true) {
    return { status: 'VALIDATION_FAILED', retryAllowed: false }
  }
  return { status: 'UNEXPECTED_ERROR', retryAllowed: false }
}
