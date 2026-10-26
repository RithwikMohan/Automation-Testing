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
import { chromium } from 'playwright'
import { resolveContextualCell } from './contextualTarget.mjs'
import { actionToRuleText, buildWorkflowStepText } from './workflowAuthoring.mjs'

const registeredOrigins = ['https://app.example.test']
const baseAction = { action: 'click', locator: { kind: 'label', value: 'Save' }, locatorCandidates: [{ kind: 'label', value: 'Save' }] }

test('workflow definitions reject arbitrary URLs, unsupported actions, unsafe locators, and secret variables', () => {
  const valid = validateWorkflowDefinition({ applicationId: 'app-1', name: 'Review', variables: [], actions: [baseAction] }, { applicationId: 'app-1', registeredOrigins })
  assert.equal(valid.actions[0].locatorCandidates[0].value, 'Save')
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Bad', variables: [], actions: [{ action: 'execute_code', code: 'alert(1)' }] }), /unsupported/)
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Bad', variables: [], actions: [{ action: 'navigate', url: 'https://outside.example/path' }] }, { applicationId: 'app-1', registeredOrigins }), /scope/)
  assert.equal(validateWorkflowDefinition({ applicationId: 'app-1', name: 'CSS', variables: [], actions: [{ action: 'click', locator: { kind: 'css', value: 'button.primary' }, locatorCandidates: [{ kind: 'css', value: 'button.primary' }] }] }).actions[0].locator.kind, 'css')
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
  const csv = generateWorkflowCsvTemplate({ name: 'Employee, creation', variables: [{ key: 'first_name', variable: true, defaultValue: 'Rahul' }, { key: 'password', sensitive: true, credential: true, variable: true }], actions: [{ ruleText: 'fill label="First Name" <- ${test_data.first_name}' }] }, 3)
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true })
  assert.deepEqual(parsed.meta.fields, ['test_case_id', 'name', 'preconditions', 'steps', 'first_name', 'password', 'expected_result', 'priority', 'tags'])
  assert.equal(parsed.data[0].name, 'Employee, creation case 1')
  assert.equal(parsed.data[0].first_name, 'Rahul')
  assert.match(parsed.data[0].tags, /workflow-v3/)
  const escaped = serializeCsv([['a', 'line 1\nline 2', 'has "quotes"']])
  assert.deepEqual(Papa.parse(escaped, { skipEmptyLines: true }).data[0], ['a', 'line 1\nline 2', 'has "quotes"'])
})

test('CSV imports apply variable defaults and validate configured types and patterns per row', () => {
  const csv = serializeCsv([
    ['test_case_id', 'name', 'preconditions', 'steps', 'project_name', 'work_date', 'hours', 'expected_result', 'priority', 'tags'],
    ['TC01', 'Timesheet', '[]', 'fill label="Hours" <- ${test_data.hours}', 'Project A', '2026-10-26', '8', 'assert url contains "/done"', 'normal', 'workflow-v1'],
    ['TC02', 'Timesheet', '[]', 'fill label="Hours" <- ${test_data.hours}', 'Project B', 'not-a-date', 'no', 'assert url contains "/done"', 'normal', 'workflow-v1'],
  ])
  const parsed = parseTestCaseCsv(csv, { workflowVariables: [{ key: 'project_name', label: 'Project', required: true }, { key: 'work_date', label: 'Work date', type: 'date', required: true }, { key: 'hours', label: 'Hours', type: 'number', pattern: '^\\d+$', defaultValue: '4' }], workflowVersion: 1 })
  assert.equal(parsed.rows[0].testData.hours, '8')
  assert.deepEqual(parsed.rows[0].errors, [])
  assert.ok(parsed.rows[1].errors.some((error) => error.includes('valid ISO date')))
  assert.ok(parsed.rows[1].errors.some((error) => error.includes('must be a number')))
})

test('contextual target resolves the requested date and project row intersection on a local fixture', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<table id="timesheet"><thead><tr><th>Project</th><th>Monday, October 26</th><th>Tuesday, October 27</th></tr></thead><tbody>
      <tr><th>Project A</th><td><input aria-label="A Monday"></td><td><input aria-label="A Tuesday"></td></tr>
      <tr><th>Project B</th><td><input aria-label="B Monday"></td><td><input aria-label="B Tuesday"></td></tr>
    </tbody></table>`)
    const target = { strategy: 'table_intersection', tableSelector: 'table#timesheet', rowSelector: 'tbody tr', rowLabelSelector: 'th', headerSelector: 'thead th', cellSelector: 'input', rowText: '${project}', headerText: '${work_date}' }
    const resolved = await resolveContextualCell(page, target, { project: 'Project A', work_date: 'Monday, October 26' })
    await resolved.locator.fill('8')
    assert.equal(await page.getByLabel('A Monday').inputValue(), '8')
    assert.equal(await page.getByLabel('A Tuesday').inputValue(), '')
    assert.equal(await page.getByLabel('B Monday').inputValue(), '')
    assert.equal(resolved.headerText, 'Monday, October 26')
  } finally { await browser.close() }
})

test('contextual target normalizes ISO work dates against displayed weekday headers for separate test rows', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<table id="timesheet"><thead><tr><th>Project</th><th>Monday, October 26, 2026</th><th>Tuesday, October 27, 2026</th></tr></thead><tbody>
      <tr><th>Project A</th><td><input></td><td><input></td></tr><tr><th>Project B</th><td><input></td><td><input></td></tr></tbody></table>`)
    const target = { strategy: 'table_intersection', tableSelector: '#timesheet', rowSelector: 'tbody tr', rowLabelSelector: 'th', headerSelector: 'thead th', cellSelector: 'input', rowText: '${project_name}', headerText: '${work_date}', headerMatch: 'date' }
    for (const row of [{ project_name: 'Project A', work_date: '2026-10-26', hours: '8' }, { project_name: 'Project B', work_date: '2026-10-27', hours: '6' }]) {
      const cell = await resolveContextualCell(page, target, row)
      await cell.locator.fill(row.hours)
    }
    assert.deepEqual(await page.locator('tbody input').evaluateAll((items) => items.map((item) => item.value)), ['8', '', '', '6'])
  } finally { await browser.close() }
})

test('contextual targets report missing headers and duplicate header matches without guessing', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<table id="timesheet"><thead><tr><th>Project</th><th>Monday</th><th>Monday</th></tr></thead><tbody><tr><th>Project A</th><td><input></td><td><input></td></tr></tbody></table>`)
    const target = { strategy: 'table_intersection', tableSelector: '#timesheet', rowSelector: 'tbody tr', rowLabelSelector: 'th', headerSelector: 'thead th', cellSelector: 'input', rowText: 'Project A', headerText: 'Monday' }
    await assert.rejects(resolveContextualCell(page, target), (error) => error.code === 'CONTEXT_TARGET_AMBIGUOUS')
    await assert.rejects(resolveContextualCell(page, { ...target, headerText: 'Wednesday' }), (error) => error.code === 'CONTEXT_COLUMN_NOT_FOUND')
    await assert.rejects(resolveContextualCell(page, { ...target, tableSelector: '#missing' }), (error) => error.code === 'CONTEXT_TABLE_NOT_FOUND')
    await assert.rejects(resolveContextualCell(page, { ...target, rowText: 'Missing project', headerText: 'Monday' }), (error) => error.code === 'CONTEXT_ROW_NOT_FOUND')
  } finally { await browser.close() }
})

test('workflow persistence accepts configured contextual intersections and rejects unknown context variables', () => {
  const contextualTarget = { strategy: 'table_intersection', tableSelector: '#timesheet', rowSelector: 'tbody tr', rowLabelSelector: 'th', headerSelector: 'thead th', cellSelector: 'input', rowText: '${project}', headerText: '${work_date}' }
  const action = { action: 'fill', locator: baseAction.locator, locatorCandidates: baseAction.locatorCandidates, variableKey: 'hours', contextualTarget }
  const saved = validateWorkflowDefinition({ applicationId: 'app-1', name: 'Timesheet', variables: [{ key: 'project', label: 'Project' }, { key: 'work_date', label: 'Work date' }, { key: 'hours', label: 'Hours' }], actions: [action] }, { applicationId: 'app-1', registeredOrigins })
  assert.deepEqual(saved.actions[0].contextualTarget, { ...contextualTarget, headerMatch: 'exact' })
  assert.throws(() => validateWorkflowDefinition({ applicationId: 'app-1', name: 'Timesheet', variables: [{ key: 'hours', label: 'Hours' }], actions: [{ ...action, contextualTarget: { ...contextualTarget, headerText: '${unconfigured_date}' } }] }, { applicationId: 'app-1', registeredOrigins }), /unknown variable/)
})

test('manual builder action definitions compile into the existing deterministic step format', () => {
  const actions = [
    { id: 'nav-1', action: 'navigate', url: 'https://app.example.test/form' },
    { id: 'fill-1', action: 'fill', locator: { kind: 'label', value: 'Hours' }, variableKey: 'hours' },
    { id: 'wait-1', action: 'wait_visible', locator: { kind: 'css', value: 'button.save' }, timeoutMs: 2500 },
    { id: 'assert-1', action: 'assert_url', operator: 'contains', expected: '/done' },
  ]
  const steps = buildWorkflowStepText({ actions })
  assert.equal(steps, 'navigate: https://app.example.test/form\nfill label="Hours" <- ${test_data.hours}\nwait visible css=button.save timeout=2500\nassert url contains "/done"')
  assert.equal(actionToRuleText({ action: 'assert_value', locator: { kind: 'xpath', value: "//input[@name='hours']" }, variableKey: 'hours' }), `assert value xpath="//input[@name='hours']" <- \${test_data.hours}`)
  const parsed = compileTestCase({ rawSteps: steps, testData: { hours: '8' }, expectedResult: 'assert url contains "/done"' }, { base_url: 'https://app.example.test' })
  assert.deepEqual(parsed.actions.map((action) => action.action), ['navigate', 'fill', 'wait_visible', 'assert_url', 'assert_url'])
  assert.equal(parsed.actions[1].dataKey, 'hours')
})
