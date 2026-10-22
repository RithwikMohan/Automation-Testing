import assert from 'node:assert/strict'
import test from 'node:test'
import { phase1ErrorDetails } from './apiErrors.mjs'

test('database failures return a safe service error without connection details', () => {
  const error = new Error('password authentication failed for postgresql://admin:secret@db.example/private')
  error.code = '28P01'
  assert.deepEqual(phase1ErrorDetails(error), { status: 503, error: 'Database request failed. Please retry.' })
})

test('constraint errors have appropriate safe status codes', () => {
  const missingReference = Object.assign(new Error('foreign key failure'), { code: '23503' })
  const conflict = Object.assign(new Error('duplicate key'), { code: '23505' })
  assert.equal(phase1ErrorDetails(missingReference).status, 422)
  assert.equal(phase1ErrorDetails(conflict).status, 409)
})

test('configuration errors are sanitized for the API', () => {
  assert.deepEqual(phase1ErrorDetails(new Error('DATABASE_URL is not configured.')), { status: 503, error: 'Database request failed. Please retry.' })
})
