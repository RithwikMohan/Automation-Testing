import assert from 'node:assert/strict'
import test from 'node:test'
import Papa from 'papaparse'
import { setDatabasePoolForTesting } from '../database.mjs'
import { compileTestCase } from './interpreter.mjs'
import { parseTestCaseCsv } from './csvImport.mjs'
import { finishWorkflowCapture, saveReviewedWorkflowCapture, startWorkflowCapture, cancelWorkflowCapture, isCapturedFormWrite, navigateWorkflowCapture, pauseWorkflowCapture, resumeWorkflowCapture, validateCaptureNavigationUrl, workflowCaptureSnapshot } from './workflowRecorder.mjs'

function deterministicBrowserType() {
  const page = {
    currentUrl: '', bindings: new Map(), handlers: new Map(), closed: false,
    async exposeBinding(name, callback) { this.bindings.set(name, callback); this.__record = (payload) => callback({ page: this }, payload) },
    async addInitScript() {}, async route(_pattern, callback) { this.routeHandler = callback },
    on(name, callback) { this.handlers.set(name, callback) },
    async goto(url) { this.currentUrl = url }, url() { return this.currentUrl }, isClosed() { return this.closed },
    async close() { this.closed = true },
  }
  const context = { async newPage() { return page }, async addInitScript() {}, async exposeBinding(name, callback) { await page.exposeBinding(name, callback) }, async route(_pattern, callback) { this.routeHandler = callback }, on(_name, _callback) {}, async close() {}, async storageState() { return { cookies: [], origins: [] } } }
  const browser = { async newContext() { return context }, async close() {} }
  return { page, context, launch: async () => browser }
}

class WorkflowMemoryPool {
  saved = null
  async query(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim()
    if (query.startsWith('SELECT workflow_version FROM application_workflow_templates')) return { rows: this.saved ? [{ workflow_version: this.saved.workflow_version }] : [] }
    if (query.startsWith('INSERT INTO application_workflow_templates')) {
      this.saved = { application_id: params[0], workflow_name: params[1], action_plan: JSON.parse(params[2]), data_fields: JSON.parse(params[3]), steps_text: params[4], csv_template: params[5], workflow_version: params[6] }
      return { rows: [this.saved] }
    }
    if (query.startsWith('SELECT application_id, workflow_name, action_plan, data_fields, steps_text, csv_template')) return { rows: this.saved ? [this.saved] : [] }
    return { rows: [] }
  }
}

function localApplicationFixture(authMethod = 'none') {
  return { id: 'app-workflow-test', name: 'Local fixture', status: 'Active', auth_method: authMethod, base_url: 'http://fixture.example.test/', approved_resource_origins: [], approved_navigation_origins: [] }
}

test('records a deterministic fixture workflow and generates compilable CSV without entered values', async (t) => {
  const pool = new WorkflowMemoryPool()
  setDatabasePoolForTesting(pool)
  t.after(() => setDatabasePoolForTesting(null))
  const application = localApplicationFixture()
  const browserType = deterministicBrowserType()
  let captureId
  const capture = await startWorkflowCapture(application, {
    headless: true,
    browserType,
    onPageReady: async (page) => {
      await page.__record({ type: 'fill', locator: { kind: 'label', value: 'First Name' }, label: 'First Name' })
      await page.__record({ type: 'click', locator: { kind: 'role', role: 'button', name: 'Create user' }, label: 'Create user', write: { method: 'POST', path: '/users/create' } })
    },
  })
  captureId = capture.id
  t.after(() => cancelWorkflowCapture(captureId))

  const snapshot = workflowCaptureSnapshot(capture.id)
  assert.equal(snapshot.state, 'CAPTURING')
  assert.deepEqual(snapshot.actions.map((action) => action.action), ['fill', 'create'])
  assert.equal(JSON.stringify(snapshot).includes('Sensitive Example Value'), false)
  assert.equal(pauseWorkflowCapture(capture.id), true)
  assert.equal(workflowCaptureSnapshot(capture.id).state, 'PAUSED')
  assert.equal(resumeWorkflowCapture(capture.id), true)
  assert.equal(workflowCaptureSnapshot(capture.id).state, 'CAPTURING')

  const review = await finishWorkflowCapture(capture.id)
  assert.equal(review.state, 'REVIEW_REQUIRED')
  const saved = await saveReviewedWorkflowCapture(capture.id, { name: review.workflowName, actions: review.actions.map((_, captureIndex) => ({ captureIndex, include: true, locatorCandidateIndex: 0 })), variables: review.fields.map((field) => ({ captureKey: field.key, key: field.key, label: field.label, include: true, required: true })) })
  assert.equal(saved.state, 'SAVED')
  assert.equal(saved.data_fields[0].key, 'first_name')
  assert.equal(saved.csv_template.includes('Sensitive Example Value'), false)
  assert.match(saved.csv_template.split('\r\n')[0], /first_name/)
  const blankTemplate = parseTestCaseCsv(saved.csv_template, { workflowVariables: saved.data_fields, workflowVersion: saved.workflow_version })
  assert.match(blankTemplate.rows[0].errors.join(' '), /Required workflow field/)
  const templateRows = Papa.parse(saved.csv_template, { header: true, skipEmptyLines: true }).data
  templateRows[0].first_name = 'Sample Person'
  const editedCsv = Papa.unparse(templateRows)
  const parsed = parseTestCaseCsv(editedCsv, { workflowVariables: saved.data_fields, workflowVersion: saved.workflow_version })
  assert.deepEqual(parsed.errors, [])
  const compiled = compileTestCase(parsed.rows[0], application)
  assert.deepEqual(compiled.actions.map((action) => action.action), ['fill', 'create', 'assert_visible'])
  assert.equal(compiled.actions[1].requiresWriteApproval, true)
  assert.equal(pool.saved.action_plan[1].writeAuthorization.path, '/users/create')
})

test('records unknown POST navigation controls as clicks, not business writes, and keeps exact postback scope', async (t) => {
  const pool = new WorkflowMemoryPool()
  setDatabasePoolForTesting(pool)
  t.after(() => setDatabasePoolForTesting(null))
  const browserType = deterministicBrowserType()
  const capture = await startWorkflowCapture(localApplicationFixture(), {
    headless: true,
    browserType,
    onPageReady: async (page) => {
      await page.__record({ type: 'click', locator: { kind: 'id', value: 't_Button_navControl' }, locatorCandidates: [{ kind: 'id', value: 't_Button_navControl' }], label: 'Menu', write: { method: 'POST', path: '/home' } })
      await page.__record({ type: 'fill', locator: { kind: 'label', value: 'hours 241 4' }, locatorCandidates: [{ kind: 'label', value: 'hours 241 4' }], label: 'hours_241_4', metadata: { label: 'hours_241_4', name: 'hours_241_4', type: 'text' } })
      await page.__record({ type: 'click', locator: { kind: 'id', value: 'save-timesheet-btn' }, locatorCandidates: [{ kind: 'id', value: 'save-timesheet-btn' }], label: 'Save Timesheet', write: { method: 'POST', path: '/save-timesheet' } })
    },
  })
  t.after(() => cancelWorkflowCapture(capture.id))
  const review = await finishWorkflowCapture(capture.id)
  assert.deepEqual(review.actions.map((action) => action.action), ['click', 'fill', 'update'])
  assert.deepEqual(review.actions[0].postbackAuthorization, { captured: true, method: 'POST', origin: 'http://fixture.example.test', path: '/home' })
  assert.equal(review.actions[0].requiresWriteApproval, undefined)
  const saved = await saveReviewedWorkflowCapture(capture.id, {
    actions: review.actions.map((_, captureIndex) => ({ captureIndex, include: true, locatorCandidateIndex: 0 })),
    variables: review.fields.map((field) => ({ captureKey: field.key, key: field.key, label: field.label, include: true, required: true })),
  })
  assert.equal(saved.state, 'SAVED')
  assert.equal(pool.saved.action_plan[0].action, 'click')
  assert.equal(pool.saved.action_plan[0].postbackAuthorization.path, '/home')
  assert.equal(pool.saved.action_plan[2].action, 'update')
  assert.equal(pool.saved.action_plan[2].writeAuthorization.path, '/save-timesheet')
  const rows = Papa.parse(saved.csv_template, { header: true, skipEmptyLines: true }).data
  rows[0].hours_241_4 = '3'
  const csv = Papa.unparse(rows)
  const parsed = parseTestCaseCsv(csv, { workflowVariables: saved.data_fields, workflowVersion: saved.workflow_version })
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.rows[0].errors, [])
  const compiled = compileTestCase(parsed.rows[0], localApplicationFixture())
  assert.deepEqual(compiled.actions.map((action) => action.action), ['click', 'fill', 'update', 'assert_visible'])
})

test('keeps unrecognized form submits classified as business writes', async (t) => {
  const pool = new WorkflowMemoryPool()
  setDatabasePoolForTesting(pool)
  t.after(() => setDatabasePoolForTesting(null))
  const capture = await startWorkflowCapture(localApplicationFixture(), {
    headless: true,
    browserType: deterministicBrowserType(),
    onPageReady: async (page) => page.__record({ type: 'click', locator: { kind: 'role', role: 'button', name: 'Continue' }, locatorCandidates: [{ kind: 'role', role: 'button', name: 'Continue' }], label: 'Continue', write: { method: 'POST', path: '/continue' } }),
  })
  t.after(() => cancelWorkflowCapture(capture.id))
  assert.equal(workflowCaptureSnapshot(capture.id).actions[0].action, 'create')
  assert.equal(workflowCaptureSnapshot(capture.id).actions[0].requiresWriteApproval, true)
})

test('manual-auth recording holds login until explicitly started and stores no credentials', async (t) => {
  const pool = new WorkflowMemoryPool()
  setDatabasePoolForTesting(pool)
  t.after(() => setDatabasePoolForTesting(null))
  const application = localApplicationFixture('manual')
  const browserType = deterministicBrowserType()
  let captureId
  const capture = await startWorkflowCapture(application, { headless: true, browserType })
  captureId = capture.id
  t.after(() => cancelWorkflowCapture(captureId))
  assert.equal(capture.state, 'WAITING_FOR_MANUAL_LOGIN')
  assert.equal(workflowCaptureSnapshot(capture.id).actions.length, 0)
  assert.equal(await (await import('./workflowRecorder.mjs')).beginWorkflowCapture(capture.id), true)
  assert.equal(workflowCaptureSnapshot(capture.id).state, 'CAPTURING')
  assert.equal(workflowCaptureSnapshot(capture.id).actions[0].action, 'navigate')
  await browserType.page.__record({ type: 'fill', locator: { kind: 'label', value: 'Department' }, label: 'Department' })
  const review = await finishWorkflowCapture(capture.id, { reuseAuthenticatedSession: true })
  const saved = await saveReviewedWorkflowCapture(capture.id, { actions: review.actions.map((_, captureIndex) => ({ captureIndex, include: true, locatorCandidateIndex: 0 })), variables: review.fields.map((field) => ({ captureKey: field.key, key: field.key, label: field.label, include: true, required: true })) })
  assert.equal(saved.state, 'SAVED')
  assert.deepEqual(saved.fields.map((field) => field.key), ['department'])
})

test('manual login capture adds blank username/password CSV columns without capturing typed values', async (t) => {
  const pool = new WorkflowMemoryPool()
  setDatabasePoolForTesting(pool)
  t.after(() => setDatabasePoolForTesting(null))
  const browserType = deterministicBrowserType()
  const capture = await startWorkflowCapture(localApplicationFixture('manual'), {
    headless: true,
    browserType,
    onPageReady: async (page) => {
      await page.__record({ type: 'fill', locator: { kind: 'label', value: 'Username' }, locatorCandidates: [{ kind: 'label', value: 'Username' }], label: 'Username', metadata: { label: 'Username', name: 'username', type: 'text' }, value: 'must-not-be-recorded' })
      await page.__record({ type: 'fill', locator: { kind: 'label', value: 'Password' }, locatorCandidates: [{ kind: 'label', value: 'Password' }], label: 'Password', metadata: { label: 'Password', name: 'password', type: 'password' }, value: 'must-not-be-recorded' })
      await page.__record({ type: 'click', locator: { kind: 'role', role: 'button', name: 'Sign In' }, locatorCandidates: [{ kind: 'role', role: 'button', name: 'Sign In' }], label: 'Sign In', loginSubmit: true })
    },
  })
  t.after(() => cancelWorkflowCapture(capture.id))
  const review = await finishWorkflowCapture(capture.id)
  const saved = await saveReviewedWorkflowCapture(capture.id, {
    actions: review.actions.map((_, captureIndex) => ({ captureIndex, include: true, locatorCandidateIndex: 0 })),
    variables: review.fields.map((field) => ({ captureKey: field.key, key: field.key, label: field.label, include: true, required: true, credential: field.credential === true })),
  })
  assert.deepEqual(saved.data_fields.map((field) => field.key), ['username', 'password'])
  assert.match(saved.csv_template.split('\r\n')[0], /username,password/)
  assert.equal(JSON.stringify(saved).includes('must-not-be-recorded'), false)
  assert.equal(saved.action_count, 3)
})

test('captured writes require the exact recently clicked registered POST form path and exclude manual login submits', () => {
  const session = { captureActive: true, manualAuthActive: false, lastInteractionAt: Date.now(), appOrigin: 'https://app.example.test', navOrigins: new Set(['https://app.example.test']), lastActionIndex: 0, actions: [{ action: 'create', writeAuthorization: { method: 'POST', origin: 'https://app.example.test', path: '/records' } }] }
  const formType = 'application/x-www-form-urlencoded; charset=UTF-8'
  assert.equal(isCapturedFormWrite(session, 'POST', new URL('https://app.example.test/records?csrf=opaque'), formType), true)
  assert.equal(isCapturedFormWrite(session, 'POST', new URL('https://app.example.test/other'), formType), false)
  assert.equal(isCapturedFormWrite(session, 'POST', new URL('https://attacker.example.test/records'), formType), false)
  assert.equal(isCapturedFormWrite(session, 'POST', new URL('https://app.example.test/records'), 'application/json'), false)
  assert.equal(isCapturedFormWrite(session, 'PUT', new URL('https://app.example.test/records'), formType), false)
  assert.equal(isCapturedFormWrite({ ...session, captureActive: false }, 'POST', new URL('https://app.example.test/records'), formType), false)
  assert.equal(isCapturedFormWrite({ ...session, manualAuthActive: true }, 'POST', new URL('https://app.example.test/records'), formType), false)
  assert.equal(isCapturedFormWrite({ ...session, actions: [{ action: 'click', manualLoginSubmit: true, writeAuthorization: session.actions[0].writeAuthorization }] }, 'POST', new URL('https://app.example.test/records'), formType), false)
})

test('manual capture accepts public HTTPS resource origins but rejects unsafe URL schemes and ports', async (t) => {
  assert.equal(validateCaptureNavigationUrl('https://static.oracle.com/cdn/apex.css'), 'https://static.oracle.com/cdn/apex.css')
  assert.throws(() => validateCaptureNavigationUrl('javascript:alert(1)'), /HTTP or HTTPS/)
  assert.throws(() => validateCaptureNavigationUrl('https://user:pass@example.test/'), /credential-free/)
  assert.throws(() => validateCaptureNavigationUrl('https://example.test:8443/'), /standard web ports/)
  assert.throws(() => validateCaptureNavigationUrl('http://localhost/'), /hostname|local/i)

  const pool = new WorkflowMemoryPool()
  setDatabasePoolForTesting(pool)
  t.after(() => setDatabasePoolForTesting(null))
  const harness = deterministicBrowserType()
  const capture = await startWorkflowCapture(localApplicationFixture(), { headless: true, browserType: harness })
  t.after(() => cancelWorkflowCapture(capture.id))
  const request = (url, { navigation = false, method = 'GET', type = 'stylesheet' } = {}) => ({ request: () => ({ url: () => url, isNavigationRequest: () => navigation, resourceType: () => type, method: () => method, headerValue: async () => null }) })
  let continued = false
  await harness.context.routeHandler({ ...request('https://public.example.test/page', { navigation: true, type: 'document' }), continue: async () => { continued = true }, abort: async () => assert.fail('Public top-level navigation was unexpectedly blocked.') })
  assert.equal(continued, true)
  const navigated = await navigateWorkflowCapture(capture.id, 'https://public.example.test/page?session=redacted')
  assert.equal(navigated.currentUrl, 'https://public.example.test/page')
  continued = false
  await harness.context.routeHandler({ ...request('https://static.oracle.com/cdn/apex.css'), continue: async () => { continued = true }, abort: async () => assert.fail('Public CDN resource was unexpectedly blocked.') })
  assert.equal(continued, true)
  const sensitivePath = 'https://oracleapex.com/akam/Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  await harness.context.routeHandler({ ...request(sensitivePath, { method: 'POST', type: 'xhr' }), continue: async () => assert.fail('Unobserved POST must remain blocked.'), abort: async () => { continued = false } })
  assert.equal(continued, false)
  const diagnostics = workflowCaptureSnapshot(capture.id).diagnostics.join('\n')
  assert.equal(diagnostics.includes('Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'), false)
  assert.match(diagnostics, /\[redacted\]/)
})
