import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { normalizeDate } from './timesheetUpdates.mjs'

const { Pool } = pg

let pool

export function getDatabasePool() {
  if (pool) return pool
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.')
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 5_000),
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  })
  return pool
}

// Allows database CRUD tests to use an isolated in-memory pool without production credentials.
export function setDatabasePoolForTesting(testPool) {
  pool = testPool || undefined
}

export async function checkDatabaseConnection() {
  const database = getDatabasePool()
  const result = await database.query('SELECT 1 AS ok')
  return result.rows[0]?.ok === 1
}

export async function initializeDatabase() {
  const database = getDatabasePool()
  await database.query(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      source_case_id TEXT,
      status TEXT NOT NULL,
      read_only BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS automation_cases (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      row_number INTEGER,
      case_id TEXT,
      username_masked TEXT,
      requested_date DATE,
      project TEXT,
      requested_hours NUMERIC(6,2),
      status TEXT NOT NULL,
      message TEXT,
      current_hours NUMERIC(6,2),
      updated_hours NUMERIC(6,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS automation_artifacts (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      case_id TEXT,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      description TEXT,
      category TEXT,
      environment TEXT NOT NULL,
      auth_method TEXT NOT NULL,
      credential_ref TEXT,
      login_url TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_updated_at ON applications(updated_at DESC);

    CREATE TABLE IF NOT EXISTS automation_definitions (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      description TEXT,
      task_category TEXT NOT NULL,
      task_instruction TEXT NOT NULL,
      preconditions JSONB NOT NULL DEFAULT '[]'::jsonb,
      expected_results JSONB NOT NULL DEFAULT '[]'::jsonb,
      safety_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'Draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_automation_definitions_app_id ON automation_definitions(application_id);
    CREATE INDEX IF NOT EXISTS idx_automation_definitions_status ON automation_definitions(status);
    CREATE INDEX IF NOT EXISTS idx_automation_definitions_updated_at ON automation_definitions(updated_at DESC);
  `)
}

export async function persistResult(result, artifactDirectory, files = []) {
  const database = getDatabasePool()
  await database.query(
    `INSERT INTO automation_runs (id, source_case_id, status, read_only, completed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, read_only = EXCLUDED.read_only, completed_at = EXCLUDED.completed_at`,
    [result.artifactId, result.caseId || null, result.status, result.readOnly !== false],
  )
  await database.query('DELETE FROM automation_cases WHERE run_id = $1', [result.artifactId])
  await database.query('DELETE FROM automation_artifacts WHERE run_id = $1', [result.artifactId])
  const cases = result.updateResult?.per_row || (result.timesheetData ? [{
    row_number: null,
    status: result.status,
    message: result.message,
  }] : [])
  for (const item of cases) {
    await database.query(
      `INSERT INTO automation_cases
       (run_id, row_number, case_id, username_masked, requested_date, project, requested_hours, status, message, current_hours, updated_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [result.artifactId, item.row_number, result.caseId || null, null, item.date || null, item.project_name || null, item.requested_hours || null, item.status, item.message || null, item.current_hours ?? null, item.updated_hours ?? null],
    )
  }

  for (const file of files) {
    await database.query(
      `INSERT INTO automation_artifacts (run_id, case_id, kind, file_path, content_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [result.artifactId, result.caseId || null, file.kind, file.path, file.contentType],
    )
  }
}

function maskUsername(value) {
  const username = String(value || '')
  return username.length <= 3 ? '••••' : `${username.slice(0, 2)}•••${username.slice(-2)}`
}

export async function persistBatchResult({ runId, source, status, readOnly, rows, perRow }) {
  const database = getDatabasePool()
  const client = await database.connect()
  const results = new Map((perRow || []).map((item) => [item.row_number, item]))
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO automation_runs (id, source_case_id, status, read_only, completed_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET source_case_id = EXCLUDED.source_case_id, status = EXCLUDED.status, read_only = EXCLUDED.read_only, completed_at = EXCLUDED.completed_at`,
      [runId, source || 'uploaded.csv', status, readOnly],
    )
    await client.query('DELETE FROM automation_cases WHERE run_id = $1', [runId])
    for (const row of rows) {
      const item = results.get(row.row_number)
      await client.query(
        `INSERT INTO automation_cases
         (run_id, row_number, case_id, username_masked, requested_date, project, requested_hours, status, message, current_hours, updated_hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          runId,
          row.row_number,
          `TC-${String(row.row_number - 1).padStart(3, '0')}`,
          maskUsername(row['user name']),
          item?.date || normalizeDate(row.date),
          item?.project_name || row.project || null,
          item?.requested_hours ?? (Number(row['log time']) || null),
          item?.status || status,
          item?.message || null,
          item?.current_hours ?? null,
          item?.updated_hours ?? null,
        ],
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function persistArtifacts(runId, caseId, files) {
  const database = getDatabasePool()
  for (const file of files) {
    await database.query(
      `INSERT INTO automation_artifacts (run_id, case_id, kind, file_path, content_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, caseId || null, file.kind, file.path, file.contentType],
    )
  }
}

export async function listPersistedRuns() {
  const database = getDatabasePool()
  const result = await database.query(`
    SELECT r.id, r.source_case_id, r.status, r.read_only, r.created_at, r.completed_at,
           c.row_number, c.case_id, c.username_masked, c.requested_date, c.project,
           c.requested_hours, c.message, c.current_hours, c.updated_hours, c.status AS case_status,
           a.case_id AS artifact_case_id, a.kind, a.file_path, a.content_type
    FROM automation_runs r
    LEFT JOIN automation_cases c ON c.run_id = r.id
    LEFT JOIN automation_artifacts a ON a.run_id = r.id
    ORDER BY r.created_at DESC, c.row_number NULLS LAST
    LIMIT 1000
  `)
  const runs = new Map()
  for (const row of result.rows) {
    if (!runs.has(row.id)) runs.set(row.id, {
      id: row.id,
      file: row.source_case_id || 'uploaded.csv',
      created: row.created_at,
      status: row.status === 'UPDATED' ? 'Passed' : row.status === 'PARTIAL' ? 'Partial' : row.status === 'AUTHENTICATED_READ_ONLY' ? 'Passed' : 'Failed',
      cases: [],
      artifacts: [],
    })
    const run = runs.get(row.id)
    if (row.row_number !== null && !run.cases.some((item) => item.row_number === row.row_number)) {
      run.cases.push({
        row_number: row.row_number,
        case_id: row.case_id,
        username_masked: row.username_masked,
        requested_date: row.requested_date,
        project: row.project,
        requested_hours: row.requested_hours,
        status: row.case_status,
        message: row.message,
        current_hours: row.current_hours,
        updated_hours: row.updated_hours,
      })
    }
    if (row.kind && !run.artifacts.some((item) => item.kind === row.kind && item.case_id === row.artifact_case_id)) {
      run.artifacts.push({ case_id: row.artifact_case_id, kind: row.kind, content_type: row.content_type, url: `/api/runs/${encodeURIComponent(row.id)}/artifacts/${encodeURIComponent(row.kind)}?case_id=${encodeURIComponent(row.artifact_case_id || '')}` })
    }
  }
  return [...runs.values()].map((run) => {
    const passedCases = run.cases.filter((item) => ['UPDATED', 'READY'].includes(item.status)).length
    const totalCases = run.cases.length
    let runStatus = run.status
    if (totalCases > 0) {
      runStatus = passedCases === totalCases ? 'Passed' : passedCases > 0 ? 'Partial' : 'Failed'
    } else {
      runStatus = run.status === 'AUTHENTICATED_READ_ONLY' ? 'Passed' : 'Failed'
    }
    return {
      ...run,
      status: runStatus,
      cases: run.cases.map((item) => ({
        ...item,
        artifacts: run.artifacts
          .filter((artifact) => artifact.case_id === item.case_id)
          .map(({ kind, content_type, url }) => ({ kind, content_type, url })),
      })),
      total: totalCases,
      passed: passedCases,
      failed: totalCases - passedCases,
      skipped: 0,
      duration: '—',
    }
  })
}

export async function findArtifact(runId, kind, caseId = null) {
  const database = getDatabasePool()
  const result = await database.query(
    `SELECT file_path, content_type
     FROM automation_artifacts
     WHERE run_id = $1 AND kind = $2
       AND ($3::text IS NULL OR case_id = $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [runId, kind, caseId],
  )
  return result.rows[0] || null
}

export async function closeDatabase() {
  if (pool) {
    await pool.end()
    pool = undefined
  }
}

/* ==========================================================================
   Phase 1: Applications Persistence
   ========================================================================== */

export async function createApplication(data) {
  const database = getDatabasePool()
  const id = `app-${randomUUID()}`
  const now = new Date()

  const result = await database.query(
    `INSERT INTO applications
     (id, name, base_url, description, category, environment, auth_method, credential_ref, login_url, notes, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING *`,
    [
      id,
      data.name,
      data.baseUrl,
      data.description || null,
      data.category || null,
      data.environment,
      data.authMethod,
      data.credentialRef || null,
      data.loginUrl || null,
      data.notes || null,
      data.status || 'Active',
      now,
    ],
  )
  return result.rows[0]
}

export async function listApplications(options = {}) {
  const database = getDatabasePool()
  const conditions = []
  const params = []

  if (options.status) {
    params.push(options.status)
    conditions.push(`a.status = $${params.length}`)
  } else if (!options.includeArchived) {
    params.push('Archived')
    conditions.push(`a.status != $${params.length}`)
  }

  if (options.environment) {
    params.push(options.environment)
    conditions.push(`a.environment = $${params.length}`)
  }

  if (options.category) {
    params.push(options.category)
    conditions.push(`a.category = $${params.length}`)
  }

  if (options.authMethod) {
    params.push(options.authMethod)
    conditions.push(`a.auth_method = $${params.length}`)
  }

  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim()}%`)
    const idx = params.length
    conditions.push(`(a.name ILIKE $${idx} OR a.base_url ILIKE $${idx} OR a.description ILIKE $${idx})`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sortCol = ['name', 'created_at', 'updated_at'].includes(options.sortBy) ? options.sortBy : 'updated_at'
  const sortDir = options.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'

  const query = `
    SELECT
      a.*,
      COUNT(d.id)::int AS task_count
    FROM applications a
    LEFT JOIN automation_definitions d ON d.application_id = a.id AND d.status != 'Archived'
    ${whereClause}
    GROUP BY a.id
    ORDER BY a.${sortCol} ${sortDir}
  `

  const result = await database.query(query, params)
  return result.rows
}

export async function getApplicationById(id) {
  const database = getDatabasePool()
  const result = await database.query(
    `SELECT
       a.*,
       COUNT(d.id)::int AS task_count
     FROM applications a
     LEFT JOIN automation_definitions d ON d.application_id = a.id AND d.status != 'Archived'
     WHERE a.id = $1
     GROUP BY a.id`,
    [id],
  )
  if (!result.rows[0]) return null

  const tasks = await database.query(
    `SELECT id, name, task_category, status, created_at, updated_at
     FROM automation_definitions
     WHERE application_id = $1 AND status != 'Archived'
     ORDER BY updated_at DESC`,
    [id],
  )

  return {
    ...result.rows[0],
    tasks: tasks.rows,
  }
}

export async function updateApplication(id, updates) {
  const database = getDatabasePool()
  const existing = await database.query('SELECT * FROM applications WHERE id = $1', [id])
  if (!existing.rows[0]) return null

  const fields = []
  const params = [id]

  const allowedFields = {
    name: 'name',
    baseUrl: 'base_url',
    description: 'description',
    category: 'category',
    environment: 'environment',
    authMethod: 'auth_method',
    credentialRef: 'credential_ref',
    loginUrl: 'login_url',
    notes: 'notes',
    status: 'status',
  }

  for (const [key, col] of Object.entries(allowedFields)) {
    if (updates[key] !== undefined) {
      params.push(updates[key])
      fields.push(`${col} = $${params.length}`)
    }
  }

  if (fields.length === 0) return existing.rows[0]

  fields.push('updated_at = now()')
  const query = `UPDATE applications SET ${fields.join(', ')} WHERE id = $1 RETURNING *`
  const result = await database.query(query, params)
  return result.rows[0]
}

export async function archiveApplication(id) {
  const database = getDatabasePool()
  const result = await database.query(
    "UPDATE applications SET status = 'Archived', updated_at = now() WHERE id = $1 RETURNING *",
    [id],
  )
  return result.rows[0] || null
}

/* ==========================================================================
   Phase 1: Task Definitions (Automations) Persistence
   ========================================================================== */

export async function createAutomationDefinition(data) {
  const database = getDatabasePool()
  const id = `task-${randomUUID()}`
  const now = new Date()

  const appRes = await database.query('SELECT id, status, base_url FROM applications WHERE id = $1', [data.applicationId])
  if (!appRes.rows[0]) {
    throw new Error(`Referenced application '${data.applicationId}' does not exist.`)
  }
  if (appRes.rows[0].status === 'Archived') {
    throw new Error('Cannot create automation task for an archived application.')
  }
  validateAllowedDomain(data.safetySettings, appRes.rows[0].id, appRes.rows[0].base_url)

  const result = await database.query(
    `INSERT INTO automation_definitions
     (id, application_id, name, description, task_category, task_instruction, preconditions, expected_results, safety_settings, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     RETURNING *`,
    [
      id,
      data.applicationId,
      data.name,
      data.description || null,
      data.taskCategory,
      data.taskInstruction,
      JSON.stringify(data.preconditions || []),
      JSON.stringify(data.expectedResults || []),
      JSON.stringify(data.safetySettings || {}),
      data.status || 'Draft',
      now,
    ],
  )
  return result.rows[0]
}

export async function listAutomationDefinitions(options = {}) {
  const database = getDatabasePool()
  const conditions = []
  const params = []

  if (options.status) {
    params.push(options.status)
    conditions.push(`d.status = $${params.length}`)
  } else if (!options.includeArchived) {
    params.push('Archived')
    conditions.push(`d.status != $${params.length}`)
  }

  if (options.applicationId) {
    params.push(options.applicationId)
    conditions.push(`d.application_id = $${params.length}`)
  }

  if (options.category) {
    params.push(options.category)
    conditions.push(`d.task_category = $${params.length}`)
  }

  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim()}%`)
    const idx = params.length
    conditions.push(`(d.name ILIKE $${idx} OR d.task_instruction ILIKE $${idx} OR a.name ILIKE $${idx})`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sortCol = ['name', 'created_at', 'updated_at'].includes(options.sortBy) ? `d.${options.sortBy}` : 'd.updated_at'
  const sortDir = options.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'

  const query = `
    SELECT
      d.*,
      a.name AS application_name,
      a.base_url AS application_base_url,
      a.environment AS application_environment
    FROM automation_definitions d
    JOIN applications a ON a.id = d.application_id
    ${whereClause}
    ORDER BY ${sortCol} ${sortDir}
  `

  const result = await database.query(query, params)
  return result.rows
}

export async function getAutomationDefinitionById(id) {
  const database = getDatabasePool()
  const result = await database.query(
    `SELECT
       d.*,
       a.name AS application_name,
       a.base_url AS application_base_url,
       a.environment AS application_environment,
       a.auth_method AS application_auth_method
     FROM automation_definitions d
     JOIN applications a ON a.id = d.application_id
     WHERE d.id = $1`,
    [id],
  )
  return result.rows[0] || null
}

export async function updateAutomationDefinition(id, updates) {
  const database = getDatabasePool()
  const existing = await database.query('SELECT * FROM automation_definitions WHERE id = $1', [id])
  if (!existing.rows[0]) return null

  if (updates.applicationId && updates.applicationId !== existing.rows[0].application_id) {
    const appRes = await database.query('SELECT id, status FROM applications WHERE id = $1', [updates.applicationId])
    if (!appRes.rows[0]) throw new Error(`Referenced application '${updates.applicationId}' does not exist.`)
    if (appRes.rows[0].status === 'Archived') throw new Error('Cannot link to an archived application.')
  }
  if (updates.safetySettings?.allowed_domain) {
    const appId = updates.applicationId || existing.rows[0].application_id
    const appRes = await database.query('SELECT base_url, status FROM applications WHERE id = $1', [appId])
    if (!appRes.rows[0] || appRes.rows[0].status === 'Archived') throw new Error('Cannot link to a missing or archived application.')
    validateAllowedDomain(updates.safetySettings, appId, appRes.rows[0].base_url)
  }

  const fields = []
  const params = [id]

  if (updates.applicationId !== undefined) {
    params.push(updates.applicationId)
    fields.push(`application_id = $${params.length}`)
  }
  if (updates.name !== undefined) {
    params.push(updates.name)
    fields.push(`name = $${params.length}`)
  }
  if (updates.description !== undefined) {
    params.push(updates.description)
    fields.push(`description = $${params.length}`)
  }
  if (updates.taskCategory !== undefined) {
    params.push(updates.taskCategory)
    fields.push(`task_category = $${params.length}`)
  }
  if (updates.taskInstruction !== undefined) {
    params.push(updates.taskInstruction)
    fields.push(`task_instruction = $${params.length}`)
  }
  if (updates.preconditions !== undefined) {
    params.push(JSON.stringify(updates.preconditions))
    fields.push(`preconditions = $${params.length}`)
  }
  if (updates.expectedResults !== undefined) {
    params.push(JSON.stringify(updates.expectedResults))
    fields.push(`expected_results = $${params.length}`)
  }
  if (updates.safetySettings !== undefined) {
    params.push(JSON.stringify(updates.safetySettings))
    fields.push(`safety_settings = $${params.length}`)
  }
  if (updates.status !== undefined) {
    params.push(updates.status)
    fields.push(`status = $${params.length}`)
  }

  if (fields.length === 0) return existing.rows[0]

  fields.push('updated_at = now()')
  const query = `UPDATE automation_definitions SET ${fields.join(', ')} WHERE id = $1 RETURNING *`
  const result = await database.query(query, params)
  return result.rows[0]
}

function validateAllowedDomain(safetySettings, _applicationId, baseUrl) {
  const domain = safetySettings?.allowed_domain
  if (domain === undefined || domain === '') return
  if (!baseUrl) throw new Error('The selected application has no valid base URL.')
  let host
  try { host = new URL(baseUrl).hostname.toLowerCase() } catch { throw new Error('The selected application has no valid base URL.') }
  let supplied
  try {
    if (domain.includes('://') || domain.includes('/') || domain.includes('@') || domain.includes(':')) throw new Error()
    supplied = new URL(`https://${domain}`).hostname.toLowerCase()
  } catch { throw new Error('Allowed domain must be a hostname matching the registered application.') }
  if (supplied !== host) throw new Error('Allowed domain must match the registered application hostname. This setting is configuration only and is not enforced at runtime.')
}

export async function duplicateAutomationDefinition(id) {
  const database = getDatabasePool()
  const original = await getAutomationDefinitionById(id)
  if (!original) return null
  const application = await database.query('SELECT id, status, base_url FROM applications WHERE id = $1', [original.application_id])
  if (!application.rows[0] || application.rows[0].status === 'Archived') {
    throw new Error('Cannot duplicate a task linked to a missing or archived application.')
  }
  validateAllowedDomain(original.safety_settings, application.rows[0].id, application.rows[0].base_url)

  const newId = `task-${randomUUID()}`
  const newName = `${original.name} (Copy)`.slice(0, 150)
  const now = new Date()

  const result = await database.query(
    `INSERT INTO automation_definitions
     (id, application_id, name, description, task_category, task_instruction, preconditions, expected_results, safety_settings, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Draft', $10, $10)
     RETURNING *`,
    [
      newId,
      original.application_id,
      newName,
      original.description,
      original.task_category,
      original.task_instruction,
      JSON.stringify(original.preconditions || []),
      JSON.stringify(original.expected_results || []),
      JSON.stringify(original.safety_settings || {}),
      now,
    ],
  )
  return result.rows[0]
}

export async function archiveAutomationDefinition(id) {
  const database = getDatabasePool()
  const result = await database.query(
    "UPDATE automation_definitions SET status = 'Archived', updated_at = now() WHERE id = $1 RETURNING *",
    [id],
  )
  return result.rows[0] || null
}
