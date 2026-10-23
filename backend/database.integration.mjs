import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  archiveApplication,
  archiveAutomationDefinition,
  closeDatabase,
  createApplication,
  createAutomationDefinition,
  duplicateAutomationDefinition,
  getApplicationById,
  getAutomationDefinitionById,
  getDatabasePool,
  getBrowserTestCaseById,
  getBrowserTestExecutionById,
  importBrowserTestSuite,
  initializeDatabase,
  createBrowserTestExecution,
  updateBrowserTestExecution,
  persistBrowserTestStepResult,
  persistBrowserTestArtifact,
  setDatabasePoolForTesting,
  updateApplication,
  updateAutomationDefinition,
} from './database.mjs'

function confirmedTestTarget() {
  const testUrl = process.env.TEST_DATABASE_URL
  const productionUrl = process.env.DATABASE_URL
  if (!testUrl) throw new Error('TEST_DATABASE_URL is missing; integration test refused before any database write.')
  if (!productionUrl) throw new Error('DATABASE_URL is required to compare the test target; integration test refused.')
  if (process.env.CHRONOS_TEST_BRANCH_NAME !== 'chronos-test') {
    throw new Error('Set CHRONOS_TEST_BRANCH_NAME=chronos-test to confirm the isolated Neon branch; integration test refused.')
  }

  let testTarget
  let productionTarget
  try {
    testTarget = new URL(testUrl)
    productionTarget = new URL(productionUrl)
  } catch {
    throw new Error('A configured database URL is malformed; integration test refused.')
  }
  if (!['postgres:', 'postgresql:'].includes(testTarget.protocol)) throw new Error('TEST_DATABASE_URL must use PostgreSQL; integration test refused.')
  if (testTarget.hostname === productionTarget.hostname) throw new Error('TEST_DATABASE_URL resolves to the production database host; integration test refused.')
  return testUrl
}

const testDatabaseUrl = confirmedTestTarget()

test('PostgreSQL integration: application and task CRUD, FK, safety, reconnect persistence, cleanup', async () => {
  const productionUrl = process.env.DATABASE_URL
  const appIds = []
  const taskIds = []
  const browserSuiteIds = []
  const browserExecutionIds = []
  setDatabasePoolForTesting(null)
  process.env.DATABASE_URL = testDatabaseUrl
  try {
    let database = getDatabasePool()
    await initializeDatabase()
    const schema = await database.query(`
      SELECT to_regclass('public.applications') AS applications,
             to_regclass('public.automation_definitions') AS definitions,
             to_regclass('public.browser_test_suites') AS browser_test_suites,
             to_regclass('public.browser_test_executions') AS browser_test_executions,
             to_regclass('public.browser_test_step_results') AS browser_test_step_results,
             to_regclass('public.browser_test_artifacts') AS browser_test_artifacts
    `)
    assert.equal(schema.rows[0].applications, 'applications')
    assert.equal(schema.rows[0].definitions, 'automation_definitions')
    assert.equal(schema.rows[0].browser_test_suites, 'browser_test_suites')
    assert.equal(schema.rows[0].browser_test_executions, 'browser_test_executions')
    assert.equal(schema.rows[0].browser_test_step_results, 'browser_test_step_results')
    assert.equal(schema.rows[0].browser_test_artifacts, 'browser_test_artifacts')

    const app = await createApplication({
      name: `Chronos integration ${randomUUID()}`,
      baseUrl: 'https://integration.example.test',
      environment: 'Testing',
      authMethod: 'none',
      credentialRef: null,
    })
    appIds.push(app.id)
    assert.equal((await getApplicationById(app.id)).base_url, 'https://integration.example.test')
    const updatedApp = await updateApplication(app.id, { name: `${app.name} updated`, notes: 'isolated postgres integration record' })
    assert.equal(updatedApp.name, `${app.name} updated`)
    assert.equal(updatedApp.notes, 'isolated postgres integration record')

    const suiteId = randomUUID()
    const testCaseId = randomUUID()
    const executionId = randomUUID()
    const suite = await importBrowserTestSuite({
      id: suiteId,
      applicationId: app.id,
      name: 'Chronos browser test ' + randomUUID(),
      sourceFilename: 'integration.csv',
      cases: [{
        id: testCaseId,
        caseKey: 'INTEGRATION-' + randomUUID().slice(0, 8),
        name: 'Read-only browser assertion',
        preconditions: [],
        plan: { version: '1.0', actions: [{ action: 'assert_url', operator: 'contains', expected: '/' }] },
        testData: {},
        expectedResult: 'assert url contains "/"',
        priority: 'normal',
        tags: ['integration'],
      }],
    })
    browserSuiteIds.push(suite.id)
    const storedCase = await getBrowserTestCaseById(testCaseId)
    assert.equal(storedCase.name, 'Read-only browser assertion')
    assert.deepEqual(storedCase.plan.actions[0], { action: 'assert_url', operator: 'contains', expected: '/' })
    const queued = await createBrowserTestExecution({ id: executionId, suiteId, caseId: testCaseId, applicationId: app.id, approvedInteractions: false, expectedOutcome: 'assert url contains "/"' })
    browserExecutionIds.push(queued.id)
    await updateBrowserTestExecution(executionId, { status: 'RUNNING', startedAt: new Date() })
    await persistBrowserTestStepResult({ executionId, stepNumber: 1, action: 'assert_url', status: 'PASSED', expected: { contains: '/' }, actual: { url: 'https://integration.example.test/' }, startedAt: new Date(), completedAt: new Date(), durationMs: 3 })
    await persistBrowserTestArtifact({ id: 'bta-' + randomUUID(), executionId, kind: 'screenshot', relativePath: 'browser-tests/' + executionId + '/checkpoint.png', contentType: 'image/png', sizeBytes: 42 })
    await updateBrowserTestExecution(executionId, { status: 'PASSED', actualOutcome: 'All assertions passed.', completedAt: new Date(), durationMs: 9 })
    let persistedExecution = await getBrowserTestExecutionById(executionId)
    assert.equal(persistedExecution.status, 'PASSED')
    assert.equal(persistedExecution.steps.length, 1)
    assert.equal(persistedExecution.artifacts.length, 1)

    const definition = await createAutomationDefinition({
      applicationId: app.id,
      name: `Chronos definition ${randomUUID()}`,
      taskCategory: 'Search',
      taskInstruction: 'Find an integration test record without changing it.',
      preconditions: [{ id: 'pre-1', text: 'The test record exists.' }],
      expectedResults: [{ id: 'res-1', text: 'The record appears in search results.' }],
      safetySettings: { read_only_preferred: true, require_approval: true, stop_on_ambiguity: true, max_actions: 25 },
      status: 'Draft',
    })
    taskIds.push(definition.id)
    assert.equal(definition.application_id, app.id)
    assert.deepEqual(definition.safety_settings, { read_only_preferred: true, require_approval: true, stop_on_ambiguity: true, max_actions: 25 })
    const fk = await database.query(`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conrelid = 'public.automation_definitions'::regclass
        AND confrelid = 'public.applications'::regclass
        AND contype = 'f'
    `)
    assert.ok(fk.rows[0].count >= 1)

    const updatedDefinition = await updateAutomationDefinition(definition.id, {
      name: `${definition.name} updated`,
      safetySettings: { read_only_preferred: true, require_approval: true, stop_on_ambiguity: true, max_actions: 32 },
    })
    assert.equal(updatedDefinition.name, `${definition.name} updated`)
    assert.equal(updatedDefinition.safety_settings.max_actions, 32)

    const duplicate = await duplicateAutomationDefinition(definition.id)
    taskIds.push(duplicate.id)
    assert.equal(duplicate.application_id, app.id)
    assert.equal(duplicate.status, 'Draft')
    assert.equal(duplicate.safety_settings.max_actions, 32)

    await closeDatabase()
    process.env.DATABASE_URL = testDatabaseUrl
    database = getDatabasePool()
    const persistedApp = await getApplicationById(app.id)
    const persistedDefinition = await getAutomationDefinitionById(definition.id)
    persistedExecution = await getBrowserTestExecutionById(executionId)
    assert.equal(persistedApp.name, updatedApp.name)
    assert.equal(persistedDefinition.name, updatedDefinition.name)
    assert.equal(persistedDefinition.safety_settings.max_actions, 32)
    assert.equal(persistedExecution.status, 'PASSED')
    assert.equal(persistedExecution.steps[0].status, 'PASSED')

    assert.equal((await archiveAutomationDefinition(definition.id)).status, 'Archived')
    assert.equal((await archiveApplication(app.id)).status, 'Archived')
  } finally {
    try {
      if (browserExecutionIds.length) await getDatabasePool().query('DELETE FROM browser_test_executions WHERE id = ANY($1::text[])', [browserExecutionIds])
      if (browserSuiteIds.length) await getDatabasePool().query('DELETE FROM browser_test_suites WHERE id = ANY($1::text[])', [browserSuiteIds])
      if (taskIds.length) await getDatabasePool().query('DELETE FROM automation_definitions WHERE id = ANY($1::text[])', [taskIds])
      if (appIds.length) await getDatabasePool().query('DELETE FROM applications WHERE id = ANY($1::text[])', [appIds])
    } finally {
      await closeDatabase()
      process.env.DATABASE_URL = productionUrl
    }
  }
})
