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
  setDatabasePoolForTesting(null)
  process.env.DATABASE_URL = testDatabaseUrl
  try {
    let database = getDatabasePool()
    const schema = await database.query(`
      SELECT to_regclass('public.applications') AS applications,
             to_regclass('public.automation_definitions') AS definitions
    `)
    assert.equal(schema.rows[0].applications, 'applications')
    assert.equal(schema.rows[0].definitions, 'automation_definitions')

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
    assert.equal(persistedApp.name, updatedApp.name)
    assert.equal(persistedDefinition.name, updatedDefinition.name)
    assert.equal(persistedDefinition.safety_settings.max_actions, 32)

    assert.equal((await archiveAutomationDefinition(definition.id)).status, 'Archived')
    assert.equal((await archiveApplication(app.id)).status, 'Archived')
  } finally {
    try {
      if (taskIds.length) await getDatabasePool().query('DELETE FROM automation_definitions WHERE id = ANY($1::text[])', [taskIds])
      if (appIds.length) await getDatabasePool().query('DELETE FROM applications WHERE id = ANY($1::text[])', [appIds])
    } finally {
      await closeDatabase()
      process.env.DATABASE_URL = productionUrl
    }
  }
})
