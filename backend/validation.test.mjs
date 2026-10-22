import assert from 'node:assert/strict'
import test from 'node:test'
import { validateApplicationPayload, validateAutomationDefinitionPayload } from './validation.mjs'

const application = { name: 'Portal', baseUrl: 'https://portal.example.test', environment: 'Development', authMethod: 'none' }

test('application validation accepts HTTP(S) and rejects unsupported schemes and credentials', () => {
  assert.equal(validateApplicationPayload(application).baseUrl, application.baseUrl)
  assert.throws(() => validateApplicationPayload({ ...application, baseUrl: 'file:///etc/passwd' }), /http or https/)
  assert.throws(() => validateApplicationPayload({ ...application, baseUrl: 'https://user:secret@example.test' }), /embedded credentials/)
  assert.throws(() => validateApplicationPayload({ ...application, baseUrl: 'https://portal.example.test/?access_token=secret' }), /credential or session/)
})

test('application validation rejects invalid types and oversized optional fields', () => {
  assert.throws(() => validateApplicationPayload({ ...application, description: 42 }), /Description must be a string/)
  assert.throws(() => validateApplicationPayload({ ...application, notes: 'n'.repeat(1001) }), /1,000 characters/)
  assert.throws(() => validateApplicationPayload({ ...application, credentialRef: 'password=plaintext' }), /must identify a secret in a vault/)
})

test('automation safety defaults are consistently conservative', () => {
  const result = validateAutomationDefinitionPayload({ applicationId: 'app-1', name: 'Task', taskCategory: 'Search', taskInstruction: 'Find a record' })
  assert.deepEqual(result.safetySettings, { read_only_preferred: true, require_approval: true, stop_on_ambiguity: true, max_actions: 25 })
})

test('automation validation rejects malformed constraints and safety values', () => {
  const base = { applicationId: 'app-1', name: 'Task', taskCategory: 'Search', taskInstruction: 'Find a record' }
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, taskInstruction: 'x'.repeat(5001) }), /5,000/)
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, taskCategory: 'Unknown' }), /Task category/)
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, preconditions: Array(21).fill('x') }), /20 items/)
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, expectedResults: ['x'.repeat(301)] }), /300 characters/)
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, safetySettings: { require_approval: 'yes' } }), /must be a boolean/)
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, safetySettings: { max_actions: '25' } }), /integer between 1 and 100/)
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, safetySettings: [] }), /Safety settings must be an object/)
  assert.throws(() => validateAutomationDefinitionPayload({ ...base, preconditions: [{ id: 12, text: 'ready' }] }), /IDs must be strings/)
})
