import assert from 'node:assert/strict'
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
  listApplications,
  listAutomationDefinitions,
  setDatabasePoolForTesting,
  updateApplication,
  updateAutomationDefinition,
} from './database.mjs'

class MemoryPool {
  applications = new Map()
  definitions = new Map()
  failNext = null

  async query(sql, params = []) {
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error }
    const q = sql.replace(/\s+/g, ' ').trim()
    if (q.startsWith('INSERT INTO applications')) {
      const [id, name, base_url, description, category, environment, auth_method, credential_ref, login_url, notes, status, now] = params
      const row = { id, name, base_url, description, category, environment, auth_method, credential_ref, login_url, notes, status, created_at: now, updated_at: now }
      this.applications.set(id, row)
      return { rows: [{ ...row }] }
    }
    if (q.startsWith('INSERT INTO automation_definitions')) {
      const [id, application_id, name, description, task_category, task_instruction, preconditions, expected_results, safety_settings] = params
      const status = q.includes("'Draft'") ? 'Draft' : params[9]
      const now = q.includes("'Draft'") ? params[9] : params[10]
      const row = { id, application_id, name, description, task_category, task_instruction, preconditions: JSON.parse(preconditions), expected_results: JSON.parse(expected_results), safety_settings: JSON.parse(safety_settings), status, created_at: now, updated_at: now }
      this.definitions.set(id, row)
      return { rows: [{ ...row }] }
    }
    if (q.startsWith('SELECT id, status, base_url FROM applications')) {
      const row = this.applications.get(params[0])
      return { rows: row ? [{ id: row.id, status: row.status, base_url: row.base_url }] : [] }
    }
    if (q.startsWith('SELECT id, status FROM applications')) {
      const row = this.applications.get(params[0])
      return { rows: row ? [{ id: row.id, status: row.status }] : [] }
    }
    if (q.startsWith('SELECT * FROM applications')) {
      const row = this.applications.get(params[0])
      return { rows: row ? [{ ...row }] : [] }
    }
    if (q.startsWith('SELECT a.*, COUNT(d.id)')) {
      const rows = q.includes('WHERE a.id = $1')
        ? [this.applications.get(params[0])].filter(Boolean)
        : [...this.applications.values()].filter(row => row.status !== 'Archived')
      return { rows: rows.map(row => ({ ...row, task_count: [...this.definitions.values()].filter(d => d.application_id === row.id && d.status !== 'Archived').length })) }
    }
    if (q.startsWith('SELECT id, name, task_category, status, created_at, updated_at FROM automation_definitions')) {
      return { rows: [...this.definitions.values()].filter(d => d.application_id === params[0] && d.status !== 'Archived').map(({ id, name, task_category, status, created_at, updated_at }) => ({ id, name, task_category, status, created_at, updated_at })) }
    }
    if (q.startsWith('SELECT * FROM automation_definitions')) {
      const row = this.definitions.get(params[0])
      return { rows: row ? [{ ...row }] : [] }
    }
    if (q.startsWith('SELECT d.*, a.name AS application_name') && q.includes('WHERE d.id = $1')) {
      const row = this.definitions.get(params.at(-1))
      const app = row && this.applications.get(row.application_id)
      return { rows: row && app ? [{ ...row, application_name: app.name, application_base_url: app.base_url, application_environment: app.environment, application_auth_method: app.auth_method }] : [] }
    }
    if (q.startsWith('SELECT d.*,')) {
      return { rows: [...this.definitions.values()].filter(d => d.status !== 'Archived').map(d => ({ ...d, application_name: this.applications.get(d.application_id)?.name })) }
    }
    if (q.startsWith('UPDATE applications SET')) {
      const id = params[0]
      const row = this.applications.get(id)
      if (!row) return { rows: [] }
      const setClause = q.slice('UPDATE applications SET '.length).split(' WHERE ')[0]
      for (const assignment of setClause.split(', ')) {
        const match = assignment.match(/^([a-z_]+) = \$(\d+)$/)
        if (match) row[match[1]] = params[Number(match[2]) - 1]
        else if (assignment.startsWith("status = 'Archived'")) row.status = 'Archived'
        else if (assignment === 'updated_at = now()') row.updated_at = new Date()
      }
      return { rows: [{ ...row }] }
    }
    if (q.startsWith('UPDATE automation_definitions SET')) {
      const id = params[0]
      const row = this.definitions.get(id)
      if (!row) return { rows: [] }
      const setClause = q.slice('UPDATE automation_definitions SET '.length).split(' WHERE ')[0]
      for (const assignment of setClause.split(', ')) {
        const match = assignment.match(/^([a-z_]+) = \$(\d+)$/)
        if (match) {
          const value = params[Number(match[2]) - 1]
          row[match[1]] = ['preconditions', 'expected_results', 'safety_settings'].includes(match[1]) ? JSON.parse(value) : value
        } else if (assignment.startsWith("status = 'Archived'")) row.status = 'Archived'
        else if (assignment === 'updated_at = now()') row.updated_at = new Date()
      }
      return { rows: [{ ...row }] }
    }
    throw new Error(`Unexpected SQL in test pool: ${q}`)
  }

  async end() {}
}

test('requires DATABASE_URL before creating a pool', () => {
  setDatabasePoolForTesting(null)
  const previous = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  assert.throws(() => getDatabasePool(), /DATABASE_URL is not configured/)
  if (previous) process.env.DATABASE_URL = previous
})

test('application and task CRUD persists through an isolated mock pool', async () => {
  const pool = new MemoryPool()
  setDatabasePoolForTesting(pool)
  try {
    const application = await createApplication({ name: 'Portal', baseUrl: 'https://portal.example.test', environment: 'Development', authMethod: 'none' })
    assert.equal((await getApplicationById(application.id)).name, 'Portal')
    assert.equal((await listApplications()).length, 1)
    assert.equal((await updateApplication(application.id, { name: 'Updated Portal' })).name, 'Updated Portal')

    const definition = await createAutomationDefinition({
      applicationId: application.id,
      name: 'Find invoices',
      taskCategory: 'Search',
      taskInstruction: 'Find the latest invoice',
      preconditions: [{ id: 'pre-1', text: 'User has access' }],
      expectedResults: [{ id: 'res-1', text: 'Invoice is listed' }],
      safetySettings: { read_only_preferred: true, require_approval: true, stop_on_ambiguity: true, max_actions: 25 },
      status: 'Draft',
    })
    assert.equal((await getAutomationDefinitionById(definition.id)).task_instruction, 'Find the latest invoice')
    assert.equal((await listAutomationDefinitions()).length, 1)
    await assert.rejects(() => createAutomationDefinition({ applicationId: 'missing-app', name: 'Missing ref' }), /does not exist/)
    assert.equal((await updateAutomationDefinition(definition.id, { name: 'Find recent invoices' })).name, 'Find recent invoices')
    const duplicate = await duplicateAutomationDefinition(definition.id)
    assert.equal(duplicate.status, 'Draft')
    assert.equal(duplicate.task_instruction, definition.task_instruction)
    assert.equal((await archiveAutomationDefinition(definition.id)).status, 'Archived')
    assert.equal((await archiveApplication(application.id)).status, 'Archived')
    await assert.rejects(() => createAutomationDefinition({ applicationId: application.id }), /archived application/)
    await assert.rejects(() => duplicateAutomationDefinition(duplicate.id), /archived application/)
    const databaseFailure = Object.assign(new Error('connection details are private'), { code: '08006' })
    pool.failNext = databaseFailure
    await assert.rejects(() => listApplications(), /connection details are private/)
  } finally {
    await closeDatabase()
  }
})
