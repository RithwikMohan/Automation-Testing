import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTestCaseCsv } from './csvImport.mjs'
import { compileTestCase, TEST_PLAN_VERSION } from './interpreter.mjs'
import { importBrowserTestSuite, initializeDatabase, setDatabasePoolForTesting } from '../database.mjs'
import { cancelBrowserTestExecution, executeBrowserTest, resumeBrowserTestAfterLogin, startBrowserTestExecution } from './execution.mjs'

class ExecutionMemoryPool {
  cases = new Map()
  executions = new Map()
  steps = []
  artifacts = []

  async query(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim()
    if (query.startsWith('SELECT c.*')) return { rows: this.cases.has(params[0]) ? [{ ...this.cases.get(params[0]) }] : [] }
    if (query.startsWith('UPDATE browser_test_executions SET')) {
      const row = this.executions.get(params[0]) || { id: params[0] }
      for (const match of query.matchAll(/([a-z_]+) = \$(\d+)/g)) {
        const column = match[1]
        const value = params[Number(match[2]) - 1]
        row[column] = ['policy_warnings', 'diagnostics'].includes(column) && typeof value === 'string' ? JSON.parse(value) : value
      }
      this.executions.set(params[0], row)
      return { rows: [{ ...row }] }
    }
    if (query.startsWith('INSERT INTO browser_test_step_results')) {
      this.steps.push({ params })
      return { rows: [{}] }
    }
    if (query.startsWith('INSERT INTO browser_test_artifacts')) {
      const row = { id: params[0], execution_id: params[1], kind: params[2], relative_path: params[3], content_type: params[4], size_bytes: params[5] }
      this.artifacts.push(row)
      return { rows: [row] }
    }
    return { rows: [] }
  }
}

class ImportMemoryPool {
  statements = []
  suites = []
  cases = []
  duplicate = false
  async query(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim()
    this.statements.push(query)
    if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') return { rows: [] }
    if (query.startsWith('INSERT INTO browser_test_suites')) {
      this.suites.push(params)
      return { rows: [] }
    }
    if (query.startsWith('INSERT INTO browser_test_cases')) {
      if (this.duplicate) throw Object.assign(new Error('duplicate test case key'), { code: '23505' })
      this.cases.push(params)
      return { rows: [] }
    }
    return { rows: [] }
  }
  async connect() { return { query: this.query.bind(this), release() {} } }
}

const app = { base_url: 'https://app.example.test/home', approved_navigation_origins: ['https://login.example.test'] }

test('CSV parser handles quoted commas, escaped quotes, and multiline fields', () => {
  const csv = 'test_case_id,name,preconditions,steps,test_data,expected_result,priority\n' +
    'TC-1,"Search, then verify",[],"navigate: /home\nassert text text=""Welcome"" contains ""Hello, world""","{""query"":""a,b""}","assert url contains ""/home""",high\n' +
    'TC-2,"Second ""quoted"" case",[],"navigate: /help",{},"assert url contains ""/help""",normal'
  const result = parseTestCaseCsv(csv)
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].name, 'Search, then verify')
  assert.deepEqual(result.rows[0].preconditions, [])
  assert.deepEqual(result.rows[0].testData, { query: 'a,b' })
  assert.equal(result.rows[0].rawSteps.split('\n').length, 2)
  assert.equal(result.rows[1].name, 'Second "quoted" case')
  assert.deepEqual(result.errors, [])
})

test('CSV parser finds duplicate IDs and refuses credential fields and literal secrets', () => {
  const csv = 'test_case_id,name,preconditions,steps,test_data,expected_result,priority\n' +
    'TC-1,First,[],"navigate: /",{"password":"nope"},"assert url contains ""/""",normal\n' +
    'tc-1,Second,[],"click text=""Go""",{},"password=example",normal'
  const result = parseTestCaseCsv(csv)
  assert.ok(result.rows[0].errors.some((item) => /passwords, tokens/.test(item)))
  assert.ok(result.rows[1].errors.some((item) => /Duplicate test case ID/.test(item)))
  assert.ok(result.rows[1].errors.some((item) => /Credentials and tokens/.test(item)))
})

test('CSV parser reports missing headers and malformed JSON row errors', () => {
  assert.match(parseTestCaseCsv('test_case_id,name\nTC-1,A').errors[0], /Missing required/)
  assert.match(parseTestCaseCsv('test_case_id,name,preconditions,steps,test_data,expected_result,priority,password\n').errors[0], /Credential-like CSV columns/)
  const result = parseTestCaseCsv('test_case_id,name,preconditions,steps,test_data,expected_result,priority\nTC-1,A,nope,"navigate: /",{},"assert url contains ""/""",normal')
  assert.ok(result.rows[0].errors.some((item) => /Preconditions must contain valid JSON/.test(item)))
})

test('workflow CSV parser binds dynamic fields to the saved version and rejects missing or unexpected columns', () => {
  const workflowVariables = [{ key: 'first_name', label: 'First Name', required: true, variable: true }]
  const csv = 'test_case_id,name,preconditions,steps,first_name,expected_result,priority,tags\n' +
    'TC-1,Create user,[],"fill label=""First Name"" <- ${test_data.first_name}",Asha,"assert visible text=""User created""",normal,workflow-v2'
  const parsed = parseTestCaseCsv(csv, { workflowVariables, workflowVersion: 2 })
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.rows[0].testData, { first_name: 'Asha' })
  assert.deepEqual(parsed.rows[0].errors, [])
  const missing = parseTestCaseCsv(csv.replace(',Asha,', ',,'), { workflowVariables, workflowVersion: 2 })
  assert.ok(missing.rows[0].errors.some((item) => /Required workflow field/.test(item)))
  const oldVersion = parseTestCaseCsv(csv.replace('workflow-v2', 'workflow-v1'), { workflowVariables, workflowVersion: 2 })
  assert.ok(oldVersion.rows[0].errors.some((item) => /does not match selected version/.test(item)))
  const extra = parseTestCaseCsv(csv.replace('first_name,expected_result', 'first_name,unexpected,expected_result'), { workflowVariables, workflowVersion: 2 })
  assert.ok(extra.errors.some((item) => /not defined by the selected workflow/.test(item)))
  const credentialVariables = [
    { key: 'username', label: 'Username', required: true, variable: true },
    { key: 'password', label: 'Password', required: true, variable: true, credential: true, sensitive: true },
  ]
  const loginCsv = 'test_case_id,name,preconditions,steps,username,password,expected_result,priority,tags\n' +
    'TC-LOGIN,Login,[],"fill label=""Username"" <- ${test_data.username}\nfill label=""Password"" <- ${test_data.password}\nclick role=button[name=""Sign In""]",user1,PlainTextPassword123!,"assert url contains ""/home""",normal,workflow-v1'
  const loginParsed = parseTestCaseCsv(loginCsv, { workflowVariables: credentialVariables, workflowVersion: 1 })
  assert.deepEqual(loginParsed.errors, [])
  assert.deepEqual(loginParsed.rows[0].testData, { username: 'user1', password: 'PlainTextPassword123!' })
  assert.deepEqual(loginParsed.rows[0].errors, [])
  const apiKeyVariables = [...credentialVariables, { key: 'api_key', label: 'API key', required: true, variable: true }]
  const apiKeyCsv = loginCsv.replace('password,expected_result', 'password,api_key,expected_result').replace('PlainTextPassword123!,"assert', 'PlainTextPassword123!,should-not-be-allowed,"assert')
  const apiKeyParsed = parseTestCaseCsv(apiKeyCsv, { workflowVariables: apiKeyVariables, workflowVersion: 1 })
  assert.ok(apiKeyParsed.errors.some((item) => /Credential-like CSV columns/.test(item)))
})

test('Rule interpreter produces versioned structured plans and validates test data references', () => {
  const plan = compileTestCase({
    rawSteps: 'navigate: /profile\nfill label="Email" <- ${test_data.email}\nclick role=button[name="Continue"]\nread text="Result" as result',
    expectedResult: 'assert text text="Result" contains "Saved"\nassert url contains "/profile"',
    testData: { email: 'person@example.test' },
  }, app)
  assert.equal(plan.version, TEST_PLAN_VERSION)
  assert.deepEqual(plan.actions.map((action) => action.action), ['navigate', 'fill', 'click', 'read_text', 'assert_text', 'assert_url'])
  assert.equal(plan.actions[1].dataKey, 'email')
  assert.equal(plan.actions[2].requiresApproval, true)
  assert.equal(plan.actions[0].url, 'https://app.example.test/profile')
})

test('Rule interpreter supports documented natural language and semicolon-separated steps', () => {
  const plan = compileTestCase({
    rawSteps: 'Navigate to /login; Verify that the Sign In heading is visible; Click the Sign In button; Enter the Email field with ${test_data.email}; Wait until the Dashboard heading is visible; Read the text of Order Status element as status',
    expectedResult: 'Assert that the Dashboard heading is visible',
    testData: { email: 'person@example.test' },
  }, app)
  assert.deepEqual(plan.actions.map((action) => action.action), [
    'navigate', 'assert_visible', 'click', 'fill', 'wait_visible', 'read_text', 'assert_visible',
  ])
  assert.equal(plan.actions[1].locator.role, 'heading')
  assert.equal(plan.actions[2].locator.name, 'Sign In')
  assert.equal(plan.actions[3].dataKey, 'email')
  assert.equal(plan.actions[5].resultKey, 'status')

  const semicolonInText = compileTestCase({
    rawSteps: 'assert text text="Status; pending" contains "Status; pending"',
    expectedResult: 'assert text text="Status; pending" contains "Status; pending"',
    testData: {},
  }, app)
  assert.equal(semicolonInText.actions[0].expected, 'Status; pending')

  const assertions = compileTestCase({
    rawSteps: 'Navigate to /products',
    expectedResult: [
      'Assert that text="Order created" is visible',
      'Assert that the Status text contains "Complete"',
      'Assert that the URL contains "/products"',
      'Assert that the Email field has value ${test_data.email}',
      'Assert that the result count is greater than 0',
    ].join('\n'),
    testData: { email: 'person@example.test' },
  }, app)
  assert.deepEqual(assertions.actions.map((action) => action.action), [
    'navigate', 'assert_visible', 'assert_text', 'assert_url', 'assert_value', 'assert_count_gt',
  ])
  assert.equal(assertions.actions[2].locator.value, 'Status')
  assert.equal(assertions.actions[4].dataKey, 'email')
  assert.equal(assertions.actions[5].threshold, 0)
})

test('Rule interpreter recognizes button-named synonym and approved explicit dropdown option labels', () => {
  const plan = compileTestCase({
    rawSteps: 'Click button named "Continue"; Select "India" from the Country dropdown',
    expectedResult: 'Assert that the Country dropdown is visible',
    testData: {},
  }, app)
  assert.deepEqual(plan.actions.map((action) => action.action), ['click', 'select', 'assert_visible'])
  assert.equal(plan.actions[0].locator.name, 'Continue')
  assert.equal(plan.actions[1].optionLabel, 'India')
  assert.equal(plan.actions[1].requiresApproval, true)
})

test('Rule interpreter accepts stable captured id and name locators', () => {
  const plan = compileTestCase({ rawSteps: 'fill id="first_name" <- ${test_data.first_name}\nclick name="save_button"', expectedResult: 'assert visible text="Saved"', testData: { first_name: 'Asha' } }, app)
  assert.deepEqual(plan.actions.map((action) => action.action), ['fill', 'click', 'assert_visible'])
  assert.deepEqual(plan.actions[0].locator, { kind: 'id', value: 'first_name' })
  assert.deepEqual(plan.actions[1].locator, { kind: 'name', value: 'save_button' })
})

test('Rule registry rejects missing required assertions and persisted unknown action types', async () => {
  assert.throws(() => compileTestCase({ rawSteps: 'navigate: /home', expectedResult: '', testData: {} }, app), /Expected result must include at least one meaningful assertion/)
  const unsafeCase = {
    id: 'case-tampered', application_status: 'Active', application_base_url: 'http://unused.example', test_data: {},
    plan: { version: '1.0', actions: [{ action: 'execute_code', code: 'alert(1)' }] },
  }
  const pool = new ExecutionMemoryPool()
  setDatabasePoolForTesting(pool)
  pool.cases.set(unsafeCase.id, unsafeCase)
  pool.executions.set('exec-tampered', { id: 'exec-tampered' })
  await executeBrowserTest({ id: 'exec-tampered', caseId: unsafeCase.id, approvedInteractions: false }, { recordArtifacts: false })
  assert.equal(pool.executions.get('exec-tampered').status, 'BLOCKED')
  assert.equal(pool.executions.get('exec-tampered').error_code, 'UNSUPPORTED_INSTRUCTION')
})

test('Rule interpreter validates explicitly approved writes and requires a following result assertion', () => {
  const plan = compileTestCase({
    rawSteps: 'fill label="Name" <- ${test_data.name}\ncreate role=button[name="Create"]\nassert text text="Result" contains "Created"',
    expectedResult: 'assert visible role=heading[name="Done"]',
    testData: { name: 'Sample record' },
  }, app)
  assert.deepEqual(plan.actions.map((action) => action.action), ['fill', 'create', 'assert_text', 'assert_visible'])
  assert.equal(plan.actions[1].requiresWriteApproval, true)
  assert.throws(() => compileTestCase({ rawSteps: 'navigate: /home', expectedResult: '', testData: {} }, app), /meaningful assertion/)
})

test('execution requires an explicit write-mode choice before launching a reviewed write plan', async (t) => {
  const pool = new ExecutionMemoryPool()
  setDatabasePoolForTesting(pool)
  t.after(() => setDatabasePoolForTesting(null))
  const id = 'write-mode-explicit'
  pool.cases.set(id, {
    id, suite_id: 'suite-1', application_id: 'app-1', application_name: 'Fixture App',
    application_base_url: 'https://app.example.test/', application_status: 'Active', application_auth_method: 'none',
    application_login_url: null, approved_navigation_origins: [], approved_resource_origins: [], test_data: {},
    expected_result: 'assert visible text="Saved"',
    plan: { version: '1.0', actions: [
      { action: 'update', locator: { kind: 'role', role: 'button', name: 'Save' }, requiresApproval: true, requiresWriteApproval: true, writeAuthorization: { captured: true, operation: 'update', method: 'POST', origin: 'https://app.example.test', path: '/save' } },
      { action: 'assert_visible', locator: { kind: 'text', value: 'Saved' }, expected: 'Saved' },
    ] },
  })
  pool.executions.set(id, { id })
  await executeBrowserTest({ id, caseId: id, approvedInteractions: true }, { recordArtifacts: false })
  assert.equal(pool.executions.get(id).status, 'BLOCKED')
  assert.equal(pool.executions.get(id).error_code, 'WRITE_MODE_REQUIRED')
})

test('Rule interpreter rejects unknown instructions, unsafe schemes, ambiguous locators, and URL secrets while allowing public navigation', () => {
  assert.throws(() => compileTestCase({ rawSteps: 'run javascript alert(1)', expectedResult: 'assert url contains "/"', testData: {} }, app), /unsupported instruction/)
  const publicNavigation = compileTestCase({ rawSteps: 'navigate: https://public.example.test/help', expectedResult: 'assert url contains "/help"', testData: {} }, app)
  assert.equal(publicNavigation.actions[0].url, 'https://public.example.test/help')
  assert.throws(() => compileTestCase({ rawSteps: 'navigate: javascript:alert(1)', expectedResult: 'assert url contains "/"', testData: {} }, app), /invalid origin/)
  assert.throws(() => compileTestCase({ rawSteps: 'click button Save', expectedResult: 'assert url contains "/"', testData: {} }, app), /unsupported or ambiguous locator/)
  assert.throws(() => compileTestCase({ rawSteps: 'navigate: /', expectedResult: 'assert url contains "/?token=private"', testData: {} }, app), /secret-like values are not allowed/)
  assert.throws(() => compileTestCase({ rawSteps: 'fill label="Email" <- email', expectedResult: 'assert url contains "/"', testData: { email: 'a' } }, app), /reference/)
})

test('Database migration adds isolated suite, case, execution, step, and artifact tables without dropping existing tables', async () => {
  let schema = ''
  setDatabasePoolForTesting({ async query(sql) { schema = sql; return { rows: [] } } })
  await initializeDatabase()
  for (const table of ['application_workflow_templates', 'application_workflow_versions', 'browser_test_suites', 'browser_test_cases', 'browser_test_executions', 'browser_test_step_results', 'browser_test_artifacts']) {
    assert.match(schema, new RegExp('CREATE TABLE IF NOT EXISTS ' + table))
  }
  assert.match(schema, /CREATE TABLE IF NOT EXISTS applications/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS exploration_results/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS automation_definitions/)
  assert.match(schema, /idx_browser_test_one_active_case/)
  assert.match(schema, /diagnostics JSONB NOT NULL DEFAULT '\[\]'::jsonb/)
  assert.match(schema, /execution_options JSONB NOT NULL DEFAULT '\{\}'::jsonb/)
  assert.match(schema, /video_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'/)
  assert.match(schema, /'CANCELLED'/)
  assert.match(schema, /ADD COLUMN IF NOT EXISTS steps_text/)
  assert.match(schema, /ADD COLUMN IF NOT EXISTS workflow_version/)
})

test('Suite imports are transactional and roll back when duplicate case IDs hit persistence constraints', async () => {
  const pool = new ImportMemoryPool()
  setDatabasePoolForTesting(pool)
  const cases = [{ id: 'case-1', caseKey: 'TC-1', name: 'Home', preconditions: [], plan: { version: '1.0', actions: [] }, testData: {}, expectedResult: 'assert url contains "/"', priority: 'normal', tags: [] }]
  const suite = await importBrowserTestSuite({ id: 'suite-1', applicationId: 'app-1', name: 'Smoke', sourceFilename: 'smoke.csv', workflowVersion: 2, cases })
  assert.equal(suite.case_count, 1)
  assert.ok(pool.statements.includes('COMMIT'))
  assert.equal(pool.cases[0][11], 2)
  pool.duplicate = true
  await assert.rejects(importBrowserTestSuite({ id: 'suite-2', applicationId: 'app-1', name: 'Duplicate', cases }), (error) => error.code === '23505')
  assert.equal(pool.statements.at(-1), 'ROLLBACK')
})

test('Playwright execution verifies assertions, records optional policy blocks, and persists incrementally', async () => {
  let writeCount = 0
  let crossOriginResourceHits = 0
  const server = http.createServer(async (request, response) => {
    if (String(request.headers.host || '').startsWith('cdn.unapproved.test')) crossOriginResourceHits += 1
    if (request.method === 'POST' && request.url === '/records') {
      writeCount += 1
      for await (const _chunk of request) {}
      response.writeHead(201, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Created</title><h1>Result</h1><p>Record Created</p>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Portal</title><h1>Portal Ready</h1><script>console.error("password=sensitive-fixture")</script><form method="post" action="/records"><label for="record-name">Name</label><input id="record-name" name="name"><button type="submit">Create</button></form><img src="http://cdn.unapproved.test/optional.png">')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pool = new ExecutionMemoryPool()
  setDatabasePoolForTesting(pool)
  const artifactRoot = await mkdtemp(join(tmpdir(), 'chronos-browser-tests-'))
  const fixture = (caseId, expectedText) => ({
    id: caseId,
    suite_id: 'suite-1',
    application_id: 'app-1',
    application_name: 'Fixture App',
    application_base_url: 'http://browser-test.fixture',
    application_status: 'Active',
    application_auth_method: 'none',
    application_login_url: null,
    approved_navigation_origins: [],
    approved_resource_origins: [],
    test_data: {},
    expected_result: 'assert text text="Portal Ready" contains "' + expectedText + '"',
    plan: { version: '1.0', actions: [{ action: 'assert_text', locator: { kind: 'text', value: 'Portal Ready' }, expected: expectedText }] },
  })
  const settings = { dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }], testTargetIp: '127.0.0.1', testTargetPort: server.address().port, artifactRoot }
  try {
    pool.cases.set('case-pass', fixture('case-pass', 'Portal'))
    pool.executions.set('exec-pass', { id: 'exec-pass' })
    await executeBrowserTest({ id: 'exec-pass', caseId: 'case-pass', approvedInteractions: false }, { ...settings, recordArtifacts: false })
    assert.equal(pool.executions.get('exec-pass').status, 'PASSED', JSON.stringify(pool.executions.get('exec-pass')))
    assert.equal(pool.steps.length, 1)
    assert.ok(crossOriginResourceHits > 0, 'A public cross-origin page resource should load through the validated outbound proxy')
    assert.ok(pool.executions.get('exec-pass').diagnostics.some((item) => item.type === 'console_error' && item.message.includes('[redacted-sensitive-value]')))
    assert.ok(!JSON.stringify(pool.executions.get('exec-pass').diagnostics).includes('sensitive-fixture'))

    const valueAssertions = fixture('case-value-assertions', '')
    valueAssertions.test_data = { name: 'Sample record' }
    valueAssertions.plan = { version: '1.0', actions: [
      { action: 'fill', locator: { kind: 'label', value: 'Name' }, dataKey: 'name', requiresApproval: true },
      { action: 'assert_value', locator: { kind: 'label', value: 'Name' }, dataKey: 'name' },
      { action: 'assert_count_gt', locator: { kind: 'text', value: 'Portal Ready' }, threshold: 0 },
    ] }
    pool.cases.set(valueAssertions.id, valueAssertions)
    pool.executions.set('exec-value-assertions', { id: 'exec-value-assertions' })
    await executeBrowserTest({ id: 'exec-value-assertions', caseId: valueAssertions.id, approvedInteractions: true }, { ...settings, recordArtifacts: false })
    assert.equal(pool.executions.get('exec-value-assertions').status, 'PASSED', JSON.stringify(pool.executions.get('exec-value-assertions')))
    assert.deepEqual(pool.steps.filter((step) => step.params[0] === 'exec-value-assertions').map((step) => step.params[2]), ['fill', 'assert_value', 'assert_count_gt'])

    pool.cases.set('case-fail', fixture('case-fail', 'Missing'))
    pool.executions.set('exec-fail', { id: 'exec-fail' })
    await executeBrowserTest({ id: 'exec-fail', caseId: 'case-fail', approvedInteractions: false }, settings)
    assert.equal(pool.executions.get('exec-fail').status, 'FAILED')
    assert.equal(pool.executions.get('exec-fail').error_code, 'ASSERTION_FAILED')
    assert.ok(pool.artifacts.some((artifact) => artifact.execution_id === 'exec-fail' && artifact.kind === 'screenshot'))
    assert.ok(pool.artifacts.some((artifact) => artifact.execution_id === 'exec-fail' && artifact.kind === 'trace'))

    const writeCase = fixture('case-create', 'Record Created')
    writeCase.application_auth_method = 'none'
    writeCase.test_data = { name: 'Sample record' }
    writeCase.plan = { version: '1.0', actions: [
      { action: 'fill', locator: { kind: 'label', value: 'Name' }, dataKey: 'name', requiresApproval: true },
      { action: 'create', locator: { kind: 'role', role: 'button', name: 'Create' }, requiresApproval: true, requiresWriteApproval: true },
      { action: 'assert_text', locator: { kind: 'text', value: 'Record Created' }, expected: 'Record Created' },
    ] }
    pool.cases.set('case-create', writeCase)
    pool.executions.set('exec-create', { id: 'exec-create' })
    await executeBrowserTest({ id: 'exec-create', caseId: 'case-create', approvedInteractions: true }, { ...settings, allowWrites: true, recordArtifacts: false })
    assert.equal(pool.executions.get('exec-create').status, 'PASSED', JSON.stringify(pool.executions.get('exec-create')))
    assert.equal(writeCount, 1)
    pool.executions.set('exec-create-write-mode-disabled', { id: 'exec-create-write-mode-disabled' })
    await executeBrowserTest({ id: 'exec-create-write-mode-disabled', caseId: 'case-create', approvedInteractions: true }, { ...settings, recordArtifacts: false })
    assert.equal(pool.executions.get('exec-create-write-mode-disabled').status, 'BLOCKED')
    assert.equal(pool.executions.get('exec-create-write-mode-disabled').error_code, 'WRITE_MODE_REQUIRED')
    assert.equal(writeCount, 1)
    pool.cases.set('case-create-unapproved', { ...writeCase, id: 'case-create-unapproved' })
    pool.executions.set('exec-create-unapproved', { id: 'exec-create-unapproved' })
    await executeBrowserTest({ id: 'exec-create-unapproved', caseId: 'case-create-unapproved', approvedInteractions: false }, { ...settings, recordArtifacts: false })
    assert.equal(pool.executions.get('exec-create-unapproved').status, 'BLOCKED')
    assert.equal(pool.executions.get('exec-create-unapproved').error_code, 'APPROVAL_REQUIRED')
    assert.equal(writeCount, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('manual authenticated session reuse records separate videos for data entry and failed cases, while disabled recording stays off', async () => {
  const server = http.createServer(async (request, response) => {
    const cookies = String(request.headers.cookie || '')
    if (request.method === 'POST' && request.url === '/login') {
      let body = ''
      for await (const chunk of request) body += chunk
      if (!body.includes('password=fixture-password')) { response.writeHead(401); return response.end('Denied') }
      response.writeHead(303, { 'set-cookie': 'chronos_auth=approved; HttpOnly; SameSite=Lax; Path=/', location: '/app' })
      return response.end()
    }
    if (request.url === '/login' && !cookies.includes('chronos_auth=approved')) {
      response.writeHead(200, { 'content-type': 'text/html' })
      return response.end('<!doctype html><title>Sign in</title><form method="post" action="/login"><label>User<input name="username"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form>')
    }
    if (cookies.includes('chronos_auth=approved')) {
      response.writeHead(200, { 'content-type': 'text/html' })
      return response.end('<!doctype html><title>Private portal</title><h1>Authenticated</h1><label for="note">Note</label><input id="note"><p>Private area</p>')
    }
    response.writeHead(302, { location: '/login' }); response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pool = new ExecutionMemoryPool()
  setDatabasePoolForTesting(pool)
  const artifactRoot = await mkdtemp(join(tmpdir(), 'chronos-auth-video-'))
  const baseCase = (id, actions, testData = {}) => ({
    id, suite_id: 'suite-auth', application_id: 'app-auth-video', application_name: 'Auth fixture',
    application_base_url: 'http://auth-video.fixture/app', application_status: 'Active', application_auth_method: 'manual',
    application_login_url: 'http://auth-video.fixture/login', approved_navigation_origins: [], approved_resource_origins: [],
    test_data: testData, expected_result: 'local authenticated fixture', plan: { version: '1.0', actions },
  })
  const settings = { dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }], testTargetIp: '127.0.0.1', testTargetPort: server.address().port, artifactRoot, headless: true }
  try {
    const loginCase = baseCase('auth-first', [{ action: 'assert_text', locator: { kind: 'text', value: 'Authenticated' }, expected: 'Authenticated' }])
    pool.cases.set(loginCase.id, loginCase); pool.executions.set('auth-video-first', { id: 'auth-video-first' })
    const loginControl = { cancelled: false, page: null }
    const firstExecution = executeBrowserTest({ id: 'auth-video-first', caseId: loginCase.id, approvedInteractions: false }, { ...settings, control: loginControl, recordVideo: true, recordingPolicy: 'mask-form-values', reuseAuthenticatedSession: true })
    for (let attempt = 0; attempt < 100 && !loginControl.page; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.ok(loginControl.page, 'manual login page should be available')
    await loginControl.page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 5000 })
    const maskedColor = await loginControl.page.locator('input[type="password"]').evaluate((element) => getComputedStyle(element).color)
    assert.equal(maskedColor, 'rgba(0, 0, 0, 0)', 'password text must be visually masked during recording')
    await loginControl.page.locator('[name="username"]').fill('fixture-user')
    await loginControl.page.locator('[name="password"]').fill('fixture-password')
    await loginControl.page.getByRole('button', { name: 'Sign in' }).click()
    await loginControl.page.getByRole('heading', { name: 'Authenticated' }).waitFor({ timeout: 5000 })
    assert.equal(resumeBrowserTestAfterLogin('auth-video-first'), true)
    await firstExecution
    assert.equal(pool.executions.get('auth-video-first').status, 'PASSED')
    assert.equal(pool.executions.get('auth-video-first').video_status, 'AVAILABLE')

    const fillCase = baseCase('auth-fill', [
      { action: 'fill', locator: { kind: 'label', value: 'Note' }, dataKey: 'note', requiresApproval: true },
      { action: 'assert_value', locator: { kind: 'label', value: 'Note' }, dataKey: 'note' },
      { action: 'assert_text', locator: { kind: 'text', value: 'Authenticated' }, expected: 'Authenticated' },
    ], { note: 'private fixture value' })
    pool.cases.set(fillCase.id, fillCase); pool.executions.set('auth-video-fill', { id: 'auth-video-fill' })
    await executeBrowserTest({ id: 'auth-video-fill', caseId: fillCase.id, approvedInteractions: true }, { ...settings, recordVideo: true, recordingPolicy: 'mask-form-values', reuseAuthenticatedSession: true })
    assert.equal(pool.executions.get('auth-video-fill').status, 'PASSED')
    assert.equal(pool.executions.get('auth-video-fill').video_status, 'AVAILABLE')

    const failedCase = baseCase('auth-failed', [{ action: 'assert_text', locator: { kind: 'text', value: 'Never present' }, expected: 'Never present' }])
    pool.cases.set(failedCase.id, failedCase); pool.executions.set('auth-video-failed', { id: 'auth-video-failed' })
    await executeBrowserTest({ id: 'auth-video-failed', caseId: failedCase.id, approvedInteractions: false }, { ...settings, recordVideo: true, reuseAuthenticatedSession: true })
    assert.equal(pool.executions.get('auth-video-failed').status, 'FAILED')
    assert.equal(pool.executions.get('auth-video-failed').video_status, 'AVAILABLE')

    const disabledCase = baseCase('auth-disabled', [{ action: 'assert_text', locator: { kind: 'text', value: 'Authenticated' }, expected: 'Authenticated' }])
    pool.cases.set(disabledCase.id, disabledCase); pool.executions.set('auth-video-disabled', { id: 'auth-video-disabled' })
    await executeBrowserTest({ id: 'auth-video-disabled', caseId: disabledCase.id, approvedInteractions: false }, { ...settings, recordVideo: true, recordingPolicy: 'disabled', reuseAuthenticatedSession: true })
    assert.equal(pool.executions.get('auth-video-disabled').video_status, 'NOT_REQUESTED')

    const videoArtifacts = pool.artifacts.filter((artifact) => artifact.kind === 'video')
    assert.deepEqual(videoArtifacts.map((artifact) => artifact.execution_id).sort(), ['auth-video-failed', 'auth-video-fill', 'auth-video-first'].sort())
    assert.equal(new Set(videoArtifacts.map((artifact) => artifact.relative_path)).size, 3, 'each case must own a distinct recording file')
    for (const artifact of videoArtifacts) {
      const file = await stat(join(artifactRoot, 'browser-tests', ...artifact.relative_path.split('/')))
      assert.ok(file.size > 0, 'recording must be finalized before its artifact reference is persisted')
    }
    assert.match(pool.executions.get('auth-video-disabled').video_error, /disabled/)
    assert.ok(!JSON.stringify([...pool.executions.values()]).includes('fixture-password'), 'password must not be stored in execution results')
    assert.ok(!JSON.stringify([...pool.executions.values()]).includes('chronos_auth'), 'cookies must not be stored in execution results')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('network diagnostics distinguish a Chronos-blocked essential subresource from a remote HTTP failure', async () => {
  let blockedPostReachedServer = false
  const server = http.createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/bootstrap') blockedPostReachedServer = true
    if (request.url === '/api/bootstrap' && request.method === 'GET') {
      response.writeHead(503, { 'content-type': 'text/plain' })
      return response.end('Connect to the internet — You are offline')
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    const resource = request.url === '/remote' ? 'fetch("/api/bootstrap").then(r=>r.text()).then(t=>document.querySelector("#state").textContent=t).catch(()=>document.querySelector("#state").textContent="Connect to the internet — You are offline")' : 'fetch("/api/bootstrap",{method:"POST"}).then(()=>document.querySelector("#state").textContent="Online").catch(()=>document.querySelector("#state").textContent="Connect to the internet — You are offline")'
    response.end('<!doctype html><title>Network fixture</title><main id="state">Loading</main><script>' + resource + '</script>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pool = new ExecutionMemoryPool()
  setDatabasePoolForTesting(pool)
  const artifactRoot = await mkdtemp(join(tmpdir(), 'chronos-network-diagnostics-'))
  const createCase = (id, path) => ({
    id, suite_id: 'suite-network', application_id: 'app-network', application_name: 'Network fixture',
    application_base_url: 'http://network-fixture.test' + path, application_status: 'Active', application_auth_method: 'none',
    application_login_url: null, approved_navigation_origins: [], approved_resource_origins: [], test_data: {},
    expected_result: 'Offline notice visible', plan: { version: '1.0', actions: [{ action: 'assert_text', locator: { kind: 'css', value: '#state' }, expected: 'Connect to the internet' }] },
  })
  const settings = {
    dnsLookup: async (hostname) => hostname === 'network-fixture.test' ? [{ address: '8.8.8.8', family: 4 }] : [],
    testTargetIp: '127.0.0.1', testTargetPort: server.address().port, artifactRoot, recordVideo: false, headless: true,
  }
  try {
    for (const [id, path] of [['blocked-essential-api', '/'], ['remote-api-failure', '/remote']]) {
      const testCase = createCase(id, path)
      pool.cases.set(id, testCase); pool.executions.set(id, { id })
      await executeBrowserTest({ id, caseId: id, approvedInteractions: false }, settings)
    }
    assert.equal(blockedPostReachedServer, false, 'Chronos must continue to block the state-changing method')
    const policyCase = pool.executions.get('blocked-essential-api')
    const blocked = policyCase.diagnostics.find((item) => item.type === 'request_blocked' && item.method === 'POST')
    assert.equal(policyCase.status, 'PASSED', 'the expected offline UI assertion passed; a blocked background fetch is diagnosed without misclassifying the whole browser session as disconnected')
    assert.equal(blocked?.stage, 'subresource', JSON.stringify(policyCase))
    assert.equal(blocked?.resourceType, 'fetch')
    assert.equal(blocked?.blockingComponent, 'Chronos read-only request policy')
    assert.ok(policyCase.policy_warnings.some((item) => item.reasonCode === 'READ_ONLY_METHOD_BLOCKED' && item.topLevelNavigation === false))
    assert.equal(policyCase.diagnostics.find((item) => item.type === 'navigation_response')?.status, 200)
    assert.ok(policyCase.diagnostics.some((item) => item.type === 'request_failed' && item.reasonCode === 'REQUEST_BLOCKED_BY_CHRONOS_POLICY'))

    const remoteCase = pool.executions.get('remote-api-failure')
    const failedApi = remoteCase.diagnostics.find((item) => item.type === 'http_response' && item.status === 503)
    assert.equal(remoteCase.status, 'PASSED', 'the local page can render its explicit offline state despite a remote API error')
    assert.equal(failedApi?.stage, 'subresource')
    assert.equal(failedApi?.responseSource, 'remote website')
    assert.equal(failedApi?.resourceType, 'fetch')
    assert.ok(!JSON.stringify([policyCase, remoteCase]).includes('cookie='), 'diagnostics must not retain query secrets')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('Queued and running browser executions can be cancelled without retries', async () => {
  const server = http.createServer((_request, response) => setTimeout(() => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Slow portal</title><h1>Ready</h1>')
  }, 800))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pool = new ExecutionMemoryPool()
  setDatabasePoolForTesting(pool)
  const artifactRoot = await mkdtemp(join(tmpdir(), 'chronos-browser-cancel-'))
  pool.cases.set('case-cancel', {
    id: 'case-cancel', suite_id: 'suite-1', application_id: 'app-1', application_name: 'Fixture App',
    application_base_url: 'http://browser-cancel.fixture', application_status: 'Active', application_auth_method: 'none',
    application_login_url: null, approved_navigation_origins: [], approved_resource_origins: [], test_data: {},
    expected_result: 'assert visible role=heading[name="Never"]',
    plan: { version: '1.0', actions: [{ action: 'assert_visible', locator: { kind: 'role', role: 'heading', name: 'Never' } }] },
  })
  pool.executions.set('exec-cancel', { id: 'exec-cancel' })
  try {
    startBrowserTestExecution({ id: 'exec-cancel', case_id: 'case-cancel', approved_interactions: false })
    for (let attempt = 0; attempt < 150 && pool.executions.get('exec-cancel').status !== 'RUNNING'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(pool.executions.get('exec-cancel').status, 'RUNNING')
    assert.equal(cancelBrowserTestExecution('exec-cancel'), true)
    for (let attempt = 0; attempt < 50 && pool.executions.get('exec-cancel').status === 'RUNNING'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(pool.executions.get('exec-cancel').status, 'CANCELLED')
    assert.equal(pool.executions.get('exec-cancel').error_code, 'USER_CANCELLED')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(artifactRoot, { recursive: true, force: true })
  }
})
