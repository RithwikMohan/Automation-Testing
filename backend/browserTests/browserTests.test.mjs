import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTestCaseCsv } from './csvImport.mjs'
import { compileTestCase, TEST_PLAN_VERSION } from './interpreter.mjs'
import { importBrowserTestSuite, initializeDatabase, setDatabasePoolForTesting } from '../database.mjs'
import { cancelBrowserTestExecution, executeBrowserTest, startBrowserTestExecution } from './execution.mjs'

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
    expectedResult: '',
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

test('Rule interpreter validates explicitly approved writes and requires a following result assertion', () => {
  const plan = compileTestCase({
    rawSteps: 'fill label="Name" <- ${test_data.name}\ncreate role=button[name="Create"]\nassert text text="Result" contains "Created"',
    expectedResult: 'assert visible role=heading[name="Done"]',
    testData: { name: 'Sample record' },
  }, app)
  assert.deepEqual(plan.actions.map((action) => action.action), ['fill', 'create', 'assert_text', 'assert_visible'])
  assert.equal(plan.actions[1].requiresWriteApproval, true)
  for (const operation of ['create', 'update', 'delete']) {
    assert.throws(() => compileTestCase({ rawSteps: operation + ' role=button[name="Save"]', expectedResult: '', testData: {} }, app), /followed by an assertion/)
  }
})

test('Rule interpreter rejects unknown instructions, unapproved origins, ambiguous locators, and URL secrets', () => {
  assert.throws(() => compileTestCase({ rawSteps: 'run javascript alert(1)', expectedResult: 'assert url contains "/"', testData: {} }, app), /unsupported instruction/)
  assert.throws(() => compileTestCase({ rawSteps: 'navigate: https://evil.example.test/', expectedResult: 'assert url contains "/"', testData: {} }, app), /origin .* is not approved/)
  assert.throws(() => compileTestCase({ rawSteps: 'click button Save', expectedResult: 'assert url contains "/"', testData: {} }, app), /unsupported or ambiguous locator/)
  assert.throws(() => compileTestCase({ rawSteps: 'navigate: /', expectedResult: 'assert url contains "/?token=private"', testData: {} }, app), /secret-like values are not allowed/)
  assert.throws(() => compileTestCase({ rawSteps: 'fill label="Email" <- email', expectedResult: 'assert url contains "/"', testData: { email: 'a' } }, app), /reference/)
})

test('Database migration adds isolated suite, case, execution, step, and artifact tables without dropping existing tables', async () => {
  let schema = ''
  setDatabasePoolForTesting({ async query(sql) { schema = sql; return { rows: [] } } })
  await initializeDatabase()
  for (const table of ['browser_test_suites', 'browser_test_cases', 'browser_test_executions', 'browser_test_step_results', 'browser_test_artifacts']) {
    assert.match(schema, new RegExp('CREATE TABLE IF NOT EXISTS ' + table))
  }
  assert.match(schema, /CREATE TABLE IF NOT EXISTS applications/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS exploration_results/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS automation_definitions/)
  assert.match(schema, /idx_browser_test_one_active_case/)
  assert.match(schema, /diagnostics JSONB NOT NULL DEFAULT '\[\]'::jsonb/)
  assert.match(schema, /'CANCELLED'/)
})

test('Suite imports are transactional and roll back when duplicate case IDs hit persistence constraints', async () => {
  const pool = new ImportMemoryPool()
  setDatabasePoolForTesting(pool)
  const cases = [{ id: 'case-1', caseKey: 'TC-1', name: 'Home', preconditions: [], plan: { version: '1.0', actions: [] }, testData: {}, expectedResult: 'assert url contains "/"', priority: 'normal', tags: [] }]
  const suite = await importBrowserTestSuite({ id: 'suite-1', applicationId: 'app-1', name: 'Smoke', sourceFilename: 'smoke.csv', cases })
  assert.equal(suite.case_count, 1)
  assert.ok(pool.statements.includes('COMMIT'))
  pool.duplicate = true
  await assert.rejects(importBrowserTestSuite({ id: 'suite-2', applicationId: 'app-1', name: 'Duplicate', cases }), (error) => error.code === '23505')
  assert.equal(pool.statements.at(-1), 'ROLLBACK')
})

test('Playwright execution verifies assertions, records optional policy blocks, and persists incrementally', async () => {
  let writeCount = 0
  const server = http.createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/records') {
      writeCount += 1
      for await (const _chunk of request) {}
      response.writeHead(201, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Created</title><h1>Result</h1><p>Record Created</p>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Portal</title><h1>Portal Ready</h1><script>console.error("password=sensitive-fixture")</script><form method="post" action="/records"><label for="record-name">Name</label><input id="record-name" name="name"><button type="submit">Create</button></form><img src="https://cdn.unapproved.test/optional.png">')
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
    assert.equal(pool.executions.get('exec-pass').status, 'PASSED')
    assert.equal(pool.steps.length, 1)
    assert.ok(pool.executions.get('exec-pass').policy_warnings.some((warning) => warning.reasonCode === 'RESOURCE_ORIGIN_BLOCKED'))
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
    await executeBrowserTest({ id: 'exec-create', caseId: 'case-create', approvedInteractions: true }, { ...settings, recordArtifacts: false })
    assert.equal(pool.executions.get('exec-create').status, 'PASSED', JSON.stringify(pool.executions.get('exec-create')))
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
