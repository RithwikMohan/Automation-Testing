import assert from 'node:assert/strict'
import test from 'node:test'
import Papa from 'papaparse'
import { applyReviewedWorkflowLocators, validateWorkflowDefinition, workflowStepsMatch } from './workflowDefinition.mjs'
import { resolveWorkflowLocator } from './locatorResolution.mjs'
import { detectWorkflowVariable } from './variableDetection.mjs'
import { generateWorkflowCsvTemplate, serializeCsv } from './csvTemplate.mjs'
import { parseTestCaseCsv } from '../browserTests/csvImport.mjs'
import { compileTestCase } from '../browserTests/interpreter.mjs'
import { validateActionPlan } from '../browserTests/actionRegistry.mjs'

const registeredOrigins = ['https://app.example.test']
const baseAction = { action: 'click', locator: { kind: 'label', value: 'Save' }, locatorCandidates: [{ kind: 'label', value: 'Save' }] }

test('workflow definitions reject arbitrary URLs, unsupported actions, unsafe locators, and secret variables', () => {
  const valid = validateWorkflowDefinition({ applicationId: 'app-1', name: 'Review', variables: [], actions: [baseAction] }, { applicationId: 'app-1', registeredOrigins })
  assert.equal(valid.actions[0].locatorCandidates[0].value, 'Save')
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Bad', variables: [], actions: [{ action: 'execute_code', code: 'alert(1)' }] }), /unsupported/)
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Bad', variables: [], actions: [{ action: 'navigate', url: 'https://outside.example/path' }] }, { applicationId: 'app-1', registeredOrigins }), /scope/)
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Bad', variables: [], actions: [{ action: 'click', locator: { kind: 'css', value: 'body' }, locatorCandidates: [{ kind: 'css', value: 'body' }] }] }), /locator/)
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Bad', variables: [{ key: 'password', label: 'Password', sensitive: true }], actions: [baseAction] }, { applicationId: 'app-1', registeredOrigins }), /secret/)
})

test('workflow CSV rows cannot replace the reviewed step sequence with arbitrary navigation', () => {
  const saved = 'navigate: https://app.example.test/users\nclick role=button[name="Create"]'
  assert.equal(workflowStepsMatch(' navigate: https://app.example.test/users\r\n click role=button[name="Create"] ', saved), true)
  assert.equal(workflowStepsMatch('navigate: https://attacker.example/collect', saved), false)
})

test('reviewed locator candidates and registered write approval are carried into the compiled CSV plan', () => {
  const plan = { version: '1.0', actions: [{ action: 'fill', locator: { kind: 'label', value: 'First Name' }, dataKey: 'first_name' }, { action: 'create', locator: { kind: 'role', role: 'button', name: 'Create' }, requiresApproval: true, requiresWriteApproval: true }, { action: 'assert_visible', locator: { kind: 'text', value: 'Created' } }] }
  const workflow = { action_plan: [{ action: 'fill', locator: { kind: 'label', value: 'First Name' }, locatorCandidates: [{ kind: 'label', value: 'First Name' }, { kind: 'id', value: 'generated-1' }], pageUrl: 'https://app.example.test/users/new' }, { action: 'create', locator: { kind: 'role', role: 'button', name: 'Create' }, locatorCandidates: [{ kind: 'role', role: 'button', name: 'Create' }], writeAuthorization: { captured: true, operation: 'create', method: 'POST', origin: 'https://app.example.test', path: '/users' } }] }
  applyReviewedWorkflowLocators(plan, workflow)
  assert.equal(plan.actions[0].locatorCandidates.length, 2)
  assert.equal(plan.actions[0].pageUrl, 'https://app.example.test/users/new')
  assert.equal(plan.actions[1].requiresWriteApproval, true)
  assert.equal(plan.actions[2].action, 'assert_visible')
  assert.throws(() => applyReviewedWorkflowLocators({ actions: [{ action: 'click' }] }, workflow), /do not contain every action/)
})

test('reviewed form postbacks remain clicks and carry only exact registered-origin scope', () => {
  const auth = { captured: true, method: 'POST', origin: 'https://app.example.test', path: '/home' }
  const definition = validateWorkflowDefinition({ applicationId: 'app-1', name: 'Timesheet', variables: [], actions: [{ ...baseAction, postbackAuthorization: auth }] }, { applicationId: 'app-1', registeredOrigins })
  assert.equal(definition.actions[0].action, 'click')
  assert.deepEqual(definition.actions[0].postbackAuthorization, auth)
  const plan = { actions: [{ action: 'click' }] }
  applyReviewedWorkflowLocators(plan, { action_plan: definition.actions })
  assert.deepEqual(plan.actions[0].postbackAuthorization, auth)
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Bad', variables: [], actions: [{ ...baseAction, postbackAuthorization: { ...auth, origin: 'https://outside.example' } }] }, { applicationId: 'app-1', registeredOrigins }), /postback scope/)
})

test('workflow locator resolution falls through candidates but reports ambiguity instead of guessing', async () => {
  const page = {
    getByLabel(value) { return { count: async () => value === 'missing' ? 0 : 1, evaluate: async () => 'input' } },
    getByRole() { return { count: async () => 2, evaluate: async () => 'button' } },
  }
  const resolved = await resolveWorkflowLocator(page, { locatorCandidates: [{ kind: 'label', value: 'missing' }, { kind: 'label', value: 'First name' }] }, { expectedTag: 'input' })
  assert.equal(resolved.candidate.value, 'First name')
  await assert.rejects(resolveWorkflowLocator(page, { locatorCandidates: [{ kind: 'role', role: 'button', name: 'Save' }] }), (error) => error.code === 'LOCATOR_AMBIGUOUS')
})

test('workflow locator resolution waits briefly for asynchronously rendered fields', async () => {
  const readyAt = Date.now() + 120
  const page = {
    getByLabel() { return { count: async () => Date.now() >= readyAt ? 1 : 0, evaluate: async () => 'input' } },
  }
  const resolved = await resolveWorkflowLocator(page, { locatorCandidates: [{ kind: 'label', value: 'hours 241 4' }] }, { timeoutMs: 500, pollMs: 20 })
  assert.equal(resolved.tag, 'input')
})

test('variable detection produces stable unique keys and keeps secrets out of the variable set', () => {
  const used = new Set()
  const first = detectWorkflowVariable({ label: 'First Name', name: 'first_name', type: 'text' }, 0, used)
  const second = detectWorkflowVariable({ label: 'First Name', name: 'first_name', type: 'text' }, 1, used)
  const password = detectWorkflowVariable({ label: 'Password', name: 'password', type: 'password' }, 2, used)
  assert.equal(first.key, 'first_name')
  assert.equal(second.key, 'first_name_2')
  assert.equal(password.sensitive, true)
  assert.equal(password.variable, false)
  const approvedPassword = detectWorkflowVariable({ label: 'Password', name: 'password', type: 'password' }, 3, new Set(), { allowPasswordCredential: true })
  assert.equal(approvedPassword.key, 'password')
  assert.equal(approvedPassword.credential, true)
  assert.equal(approvedPassword.variable, true)
})

test('only explicitly marked password credential variables are allowed in reviewed workflows', () => {
  const passwordAction = { action: 'fill', locator: { kind: 'label', value: 'Password' }, locatorCandidates: [{ kind: 'label', value: 'Password' }], variableKey: 'password', credentialInput: true }
  const accepted = validateWorkflowDefinition({ applicationId: 'app-1', name: 'Login', variables: [{ key: 'password', label: 'Password', sensitive: true, credential: true }], actions: [passwordAction, { ...baseAction, manualLoginSubmit: true }] }, { applicationId: 'app-1', registeredOrigins })
  assert.equal(accepted.variables[0].credential, true)
})

test('credential workflow CSV compiles to reviewed login actions without capturing credential values', () => {
  const variables = [
    { key: 'username', label: 'Username', required: true, variable: true },
    { key: 'password', label: 'Password', required: true, variable: true, credential: true, sensitive: true },
  ]
  const steps = 'fill label="Username" <- ${test_data.username}\nfill label="Password" <- ${test_data.password}\nclick role=button[name="Sign In"]'
  const csv = 'test_case_id,name,preconditions,steps,username,password,expected_result,priority,tags\nTC1,Login,[],"' + steps.replaceAll('"', '""') + '",person,CsvPassword123!,"assert url contains ""/home""",normal,workflow-v1'
  const parsed = parseTestCaseCsv(csv, { workflowVariables: variables, workflowVersion: 1 })
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.rows[0].errors, [])
  const app = { base_url: 'https://app.example.test/login' }
  const plan = compileTestCase(parsed.rows[0], app)
  const savedActions = [
    { action: 'fill', locator: { kind: 'label', value: 'Username' }, locatorCandidates: [{ kind: 'label', value: 'Username' }] },
    { action: 'fill', locator: { kind: 'label', value: 'Password' }, locatorCandidates: [{ kind: 'label', value: 'Password' }], credentialInput: true },
    { action: 'click', locator: { kind: 'role', role: 'button', name: 'Sign In' }, locatorCandidates: [{ kind: 'role', role: 'button', name: 'Sign In' }], manualLoginSubmit: true },
  ]
  applyReviewedWorkflowLocators(plan, { action_plan: savedActions })
  validateActionPlan(plan, parsed.rows[0].testData)
  assert.equal(plan.actions[1].credentialInput, true)
  assert.equal(plan.actions[2].manualLoginSubmit, true)
  assert.equal(JSON.stringify(plan).includes('CsvPassword123!'), false)
})

test('CSV template serializes escaped values and derives one input column per reviewed variable', () => {
  const csv = generateWorkflowCsvTemplate({ name: 'Employee, creation', variables: [{ key: 'first_name', variable: true }, { key: 'password', sensitive: true, credential: true, variable: true }], actions: [{ ruleText: 'fill label="First Name" <- ${test_data.first_name}' }] }, 3)
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true })
  assert.deepEqual(parsed.meta.fields, ['test_case_id', 'name', 'preconditions', 'steps', 'first_name', 'password', 'expected_result', 'priority', 'tags'])
  assert.equal(parsed.data[0].name, 'Employee, creation case 1')
  assert.match(parsed.data[0].tags, /workflow-v3/)
  const escaped = serializeCsv([['a', 'line 1\nline 2', 'has "quotes"']])
  assert.deepEqual(Papa.parse(escaped, { skipEmptyLines: true }).data[0], ['a', 'line 1\nline 2', 'has "quotes"'])
})
