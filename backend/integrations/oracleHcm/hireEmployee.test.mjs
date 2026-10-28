import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertHiringApproval,
  classifyExpectedValidation,
  classifyHiringSubmission,
  parseHiringCsv,
  toHiringPreviewRow,
  validateHiringRows,
} from './hireEmployee.mjs'

const header = 'employee_id,first_name,last_name,legal_employer,action_reason,business_unit,position,email,phone,expected_outcome'
const valid = 'test-001,Alex,Example,Example Inc,New position,Example BU,QA Analyst,alex@example.test,,success'

test('parses schema v1 and preserves optional blank communication fields in memory', () => {
  const parsed = parseHiringCsv(`${header}\n${valid}`)
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].phone, '')
  assert.equal(parsed.rows[0].hireDate, '')
  assert.equal(parsed.rows[0].action, '')
  assert.equal(parsed.rows[0].expectedOutcome, 'success')
})

test('does not accept Hire Date or Hire Action CSV columns because Oracle supplies defaults', () => {
  const parsed = parseHiringCsv(`${header},hire_date,action\n${valid},2026-11-02,HIRE`)
  assert.match(parsed.errors.join(' '), /unsupported columns.*hire_date.*action/)
})

test('rejects unknown and duplicate headers without echoing personal row values', () => {
  const parsed = parseHiringCsv(`${header},password\n${valid},secret-value`)
  assert.match(parsed.errors.join(' '), /unsupported columns/)
  assert.doesNotMatch(parsed.errors.join(' '), /secret-value/)
  assert.match(parseHiringCsv(`${header},first_name\n${valid},Other`).errors.join(' '), /duplicate column headers/)
})

test('validates required fields, emails, and live dropdown values', () => {
  const parsed = parseHiringCsv(`${header}\n${valid}\ntest-002,Pat,Sample,Missing Inc,New position,Example BU,QA Analyst,bad-email,,success`)
  const results = validateHiringRows(parsed.rows, { dropdownOptions: {
    legalEmployer: ['Example Inc'], action: ['HIRE'], actionReason: ['New position'], businessUnit: ['Example BU'], position: ['QA Analyst'],
  } })
  assert.equal(results[0].status, 'READY')
  assert.equal(results[1].status, 'INVALID')
  assert.ok(results[1].errors.some((error) => error.includes('available application option')))
  assert.ok(results[1].errors.some((error) => error.includes('email')))
})

test('marks every row sharing a duplicate ID and identifiers found in application evidence', () => {
  const parsed = parseHiringCsv(`${header}\n${valid}\n${valid.replace('Alex', 'Morgan')}`)
  const results = validateHiringRows(parsed.rows)
  assert.deepEqual(results.map((result) => result.status), ['DUPLICATE', 'DUPLICATE'])
  const existing = validateHiringRows(parsed.rows.slice(0, 1), { existingEmployeeIds: ['TEST-001'] })
  assert.equal(existing[0].status, 'DUPLICATE')
})

test('does not expose PII in preview-safe row and handles deliberate expected validation failure', () => {
  const negative = valid.replace('test-001', 'test-003').replace('success', 'validation_failure').replace(',Example Inc,', ',,')
  const row = parseHiringCsv(`${header}\n${negative}`).rows[0]
  const [result] = validateHiringRows([row])
  assert.equal(result.status, 'EXPECTED_VALIDATION_FAILURE')
  const preview = toHiringPreviewRow(result)
  assert.equal(preview.rowNumber, 2)
  assert.equal('data' in preview, false)
  assert.equal('employeeId' in preview, false)
  assert.equal(JSON.stringify(preview).includes('Example'), false)
  assert.throws(() => assertHiringApproval({ approved: true, rowStatus: result.status, expectedOutcome: 'validation_failure' }), { code: 'ROW_NOT_SUBMITTABLE' })
})

test('requires explicit approval and marks unconfirmed writes uncertain without retries', () => {
  assert.throws(() => assertHiringApproval({ approved: false, rowStatus: 'READY', expectedOutcome: 'success' }), { code: 'APPROVAL_REQUIRED' })
  assert.deepEqual(classifyHiringSubmission({ response: null, confirmed: false }), { status: 'UNCERTAIN', retryAllowed: false })
  assert.deepEqual(classifyHiringSubmission({ response: { status: 200 }, confirmed: true, verification: { conclusive: true, personNumber: 'P-1' } }), {
    status: 'SUCCESS', retryAllowed: false, personNumber: 'P-1',
  })
  assert.equal(classifyHiringSubmission({ response: { status: 200 }, confirmed: true, verification: { conclusive: false } }).status, 'NEEDS_VERIFICATION')
  assert.deepEqual(classifyExpectedValidation({ expectedOutcome: 'validation_failure', validationMessageVisible: true, employeeCreated: false }), { status: 'VALIDATION_FAILED', retryAllowed: false })
  assert.equal(classifyExpectedValidation({ expectedOutcome: 'validation_failure', validationMessageVisible: false, employeeCreated: false }).status, 'UNEXPECTED_ERROR')
})
