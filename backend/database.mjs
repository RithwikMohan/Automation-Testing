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
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 15_000),
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
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
    ALTER TABLE applications ADD COLUMN IF NOT EXISTS approved_resource_origins JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE applications ADD COLUMN IF NOT EXISTS approved_navigation_origins JSONB NOT NULL DEFAULT '[]'::jsonb;
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

    CREATE TABLE IF NOT EXISTS exploration_results (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      target_url TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      meta_description TEXT,
      headings JSONB NOT NULL DEFAULT '[]'::jsonb,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      forms JSONB NOT NULL DEFAULT '[]'::jsonb,
      interactive_elements JSONB NOT NULL DEFAULT '{}'::jsonb,
      auth_detected BOOLEAN NOT NULL DEFAULT false,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      audit_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE exploration_results ADD COLUMN IF NOT EXISTS audit_summary JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS application_origin_audit (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      origin_kind TEXT NOT NULL CHECK (origin_kind IN ('resource', 'navigation')),
      action TEXT NOT NULL CHECK (action IN ('added', 'removed')),
      origin TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_exploration_results_app_id ON exploration_results(application_id);
    CREATE INDEX IF NOT EXISTS idx_exploration_results_created_at ON exploration_results(created_at DESC);

    CREATE TABLE IF NOT EXISTS browser_test_suites (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      source_filename TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_browser_test_suites_app ON browser_test_suites(application_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS browser_test_cases (
      id TEXT PRIMARY KEY,
      suite_id TEXT NOT NULL REFERENCES browser_test_suites(id) ON DELETE CASCADE,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      case_key TEXT NOT NULL,
      name TEXT NOT NULL,
      preconditions JSONB NOT NULL DEFAULT '[]'::jsonb,
      plan JSONB NOT NULL,
      test_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      expected_result TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(application_id, case_key)
    );
    CREATE INDEX IF NOT EXISTS idx_browser_test_cases_suite ON browser_test_cases(suite_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_test_case_key_application
      ON browser_test_cases(application_id, lower(case_key));

    CREATE TABLE IF NOT EXISTS browser_test_executions (
      id TEXT PRIMARY KEY,
      suite_id TEXT NOT NULL REFERENCES browser_test_suites(id) ON DELETE RESTRICT,
      case_id TEXT NOT NULL REFERENCES browser_test_cases(id) ON DELETE RESTRICT,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'INTERRUPTED', 'CANCELLED')),
      approved_interactions BOOLEAN NOT NULL DEFAULT false,
      expected_outcome TEXT,
      actual_outcome TEXT,
      policy_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
      error_code TEXT,
      error_details TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE browser_test_executions ADD COLUMN IF NOT EXISTS policy_warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE browser_test_executions ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE browser_test_executions DROP CONSTRAINT IF EXISTS browser_test_executions_status_check;
    ALTER TABLE browser_test_executions ADD CONSTRAINT browser_test_executions_status_check
      CHECK (status IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'INTERRUPTED', 'CANCELLED'));
    CREATE INDEX IF NOT EXISTS idx_browser_test_executions_case ON browser_test_executions(case_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_test_executions_suite ON browser_test_executions(suite_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_test_one_active_case
      ON browser_test_executions(case_id) WHERE status IN ('QUEUED', 'RUNNING');

    CREATE TABLE IF NOT EXISTS browser_test_step_results (
      id BIGSERIAL PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES browser_test_executions(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'BLOCKED', 'SKIPPED')),
      expected JSONB,
      actual JSONB,
      error_code TEXT,
      error_details TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      duration_ms INTEGER NOT NULL,
      UNIQUE(execution_id, step_number)
    );
    CREATE INDEX IF NOT EXISTS idx_browser_test_step_execution ON browser_test_step_results(execution_id, step_number);

    CREATE TABLE IF NOT EXISTS browser_test_artifacts (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES browser_test_executions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'video', 'trace', 'report')),
      relative_path TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_browser_test_artifacts_execution ON browser_test_artifacts(execution_id, created_at);
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
     (id, name, base_url, description, category, environment, auth_method, credential_ref, login_url, notes, status, approved_resource_origins, approved_navigation_origins, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $14)
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
      JSON.stringify(data.approvedResourceOrigins || []),
      JSON.stringify(data.approvedNavigationOrigins || []),
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
  const client = database.connect ? await database.connect() : database
  const transactional = client !== database
  try {
    if (transactional) await client.query('BEGIN')
    const existing = await client.query(`SELECT * FROM applications WHERE id = $1${transactional ? ' FOR UPDATE' : ''}`, [id])
    if (!existing.rows[0]) {
      if (transactional) await client.query('COMMIT')
      return null
    }

    const fields = []
    const params = [id]
    const allowedFields = {
      name: 'name', baseUrl: 'base_url', description: 'description', category: 'category',
      environment: 'environment', authMethod: 'auth_method', credentialRef: 'credential_ref',
      loginUrl: 'login_url', notes: 'notes', status: 'status',
      approvedResourceOrigins: 'approved_resource_origins', approvedNavigationOrigins: 'approved_navigation_origins',
    }
    for (const [key, col] of Object.entries(allowedFields)) {
      if (updates[key] === undefined) continue
      const isOrigins = key === 'approvedResourceOrigins' || key === 'approvedNavigationOrigins'
      params.push(isOrigins ? JSON.stringify(updates[key]) : updates[key])
      fields.push(`${col} = $${params.length}${isOrigins ? '::jsonb' : ''}`)
    }
    if (fields.length === 0) {
      if (transactional) await client.query('COMMIT')
      return existing.rows[0]
    }

    fields.push('updated_at = now()')
    const result = await client.query(`UPDATE applications SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, params)
    for (const [field, kind, column] of [
      ['approvedResourceOrigins', 'resource', 'approved_resource_origins'],
      ['approvedNavigationOrigins', 'navigation', 'approved_navigation_origins'],
    ]) {
      if (updates[field] === undefined) continue
      const rawBefore = existing.rows[0][column] || []
      const before = typeof rawBefore === 'string' ? JSON.parse(rawBefore) : rawBefore
      const after = updates[field] || []
      for (const origin of after.filter((item) => !before.includes(item))) {
        await client.query('INSERT INTO application_origin_audit (application_id, origin_kind, action, origin) VALUES ($1, $2, $3, $4)', [id, kind, 'added', origin])
      }
      for (const origin of before.filter((item) => !after.includes(item))) {
        await client.query('INSERT INTO application_origin_audit (application_id, origin_kind, action, origin) VALUES ($1, $2, $3, $4)', [id, kind, 'removed', origin])
      }
    }
    if (transactional) await client.query('COMMIT')
    return result.rows[0]
  } catch (error) {
    if (transactional) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    if (transactional) client.release()
  }
}

export async function listApplicationOriginAudit(id) {
  const database = getDatabasePool()
  const result = await database.query(
    'SELECT origin_kind, action, origin, created_at FROM application_origin_audit WHERE application_id = $1 ORDER BY created_at DESC LIMIT 100',
    [id],
  )
  return result.rows
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

export async function persistExplorationResult(result) {
  const database = getDatabasePool()
  const res = await database.query(
    `INSERT INTO exploration_results
     (id, application_id, target_url, status, title, meta_description, headings, links, forms, interactive_elements, auth_detected, warnings, audit_summary, duration_ms, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       title = EXCLUDED.title,
       meta_description = EXCLUDED.meta_description,
       headings = EXCLUDED.headings,
       links = EXCLUDED.links,
       forms = EXCLUDED.forms,
       interactive_elements = EXCLUDED.interactive_elements,
       auth_detected = EXCLUDED.auth_detected,
       warnings = EXCLUDED.warnings,
       audit_summary = EXCLUDED.audit_summary,
       duration_ms = EXCLUDED.duration_ms
     RETURNING *`,
    [
      result.id,
      result.applicationId,
      result.targetUrl,
      result.status,
      result.title || null,
      result.metaDescription || null,
      JSON.stringify(result.headings || []),
      JSON.stringify(result.links || []),
      JSON.stringify(result.forms || []),
      JSON.stringify(result.interactiveElements || {}),
      Boolean(result.authDetected),
      JSON.stringify(result.warnings || []),
      JSON.stringify(result.auditSummary || {}),
      result.durationMs || null,
      result.createdAt || new Date(),
    ],
  )
  return res.rows[0]
}

export async function listExplorationResults(applicationId) {
  const database = getDatabasePool()
  let query = 'SELECT * FROM exploration_results'
  const params = []
  if (applicationId) {
    query += ' WHERE application_id = $1'
    params.push(applicationId)
  }
  query += ' ORDER BY created_at DESC LIMIT 50'
  const res = await database.query(query, params)
  return res.rows
}

export async function getExplorationResultById(id) {
  const database = getDatabasePool()
  const res = await database.query('SELECT * FROM exploration_results WHERE id = $1', [id])
  return res.rows[0] || null
}

export async function importBrowserTestSuite({ id, applicationId, name, sourceFilename, cases }) {
  const database = getDatabasePool()
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO browser_test_suites (id, application_id, name, source_filename) VALUES ($1, $2, $3, $4)',
      [id, applicationId, name, sourceFilename || null],
    )
    for (const item of cases) {
      await client.query(
        `INSERT INTO browser_test_cases
         (id, suite_id, application_id, case_key, name, preconditions, plan, test_data, expected_result, priority, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [item.id, id, applicationId, item.caseKey, item.name, JSON.stringify(item.preconditions), JSON.stringify(item.plan), JSON.stringify(item.testData), item.expectedResult, item.priority, JSON.stringify(item.tags)],
      )
    }
    await client.query('COMMIT')
    return { id, application_id: applicationId, name, source_filename: sourceFilename || null, case_count: cases.length }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function listBrowserTestSuites() {
  const database = getDatabasePool()
  const result = await database.query(
    `SELECT s.*, a.name AS application_name, COUNT(c.id)::int AS case_count
     FROM browser_test_suites s
     JOIN applications a ON a.id = s.application_id
     LEFT JOIN browser_test_cases c ON c.suite_id = s.id
     GROUP BY s.id, a.name
     ORDER BY s.created_at DESC`,
  )
  return result.rows
}

export async function listBrowserTestCases(suiteId) {
  const database = getDatabasePool()
  const result = await database.query(
    'SELECT * FROM browser_test_cases WHERE suite_id = $1 ORDER BY created_at, case_key',
    [suiteId],
  )
  return result.rows
}

export async function findBrowserTestCaseKeys(applicationId, caseKeys) {
  if (!caseKeys.length) return []
  const database = getDatabasePool()
  const result = await database.query(
    'SELECT case_key FROM browser_test_cases WHERE application_id = $1 AND lower(case_key) = ANY($2::text[])',
    [applicationId, caseKeys.map((key) => key.toLowerCase())],
  )
  return result.rows.map((row) => row.case_key)
}

export async function getBrowserTestCaseById(id) {
  const database = getDatabasePool()
  const result = await database.query(
    `SELECT c.*, s.name AS suite_name, a.name AS application_name, a.base_url AS application_base_url,
       a.status AS application_status, a.auth_method AS application_auth_method, a.login_url AS application_login_url,
       a.approved_navigation_origins, a.approved_resource_origins
     FROM browser_test_cases c
     JOIN browser_test_suites s ON s.id = c.suite_id
     JOIN applications a ON a.id = c.application_id
     WHERE c.id = $1`,
    [id],
  )
  return result.rows[0] || null
}

export async function createBrowserTestExecution({ id, suiteId, caseId, applicationId, approvedInteractions, expectedOutcome }) {
  const database = getDatabasePool()
  const result = await database.query(
    `INSERT INTO browser_test_executions
     (id, suite_id, case_id, application_id, status, approved_interactions, expected_outcome)
     VALUES ($1, $2, $3, $4, 'QUEUED', $5, $6) RETURNING *`,
    [id, suiteId, caseId, applicationId, Boolean(approvedInteractions), expectedOutcome],
  )
  return result.rows[0]
}

export async function updateBrowserTestExecution(id, updates) {
  const database = getDatabasePool()
  const allowed = {
    status: 'status', actualOutcome: 'actual_outcome', errorCode: 'error_code', errorDetails: 'error_details',
    startedAt: 'started_at', completedAt: 'completed_at', durationMs: 'duration_ms', policyWarnings: 'policy_warnings', diagnostics: 'diagnostics',
  }
  const fields = []
  const params = [id]
  for (const [key, column] of Object.entries(allowed)) {
    if (updates[key] !== undefined) {
      params.push(['policyWarnings', 'diagnostics'].includes(key) ? JSON.stringify(updates[key]) : updates[key])
      fields.push(column + ' = $' + params.length)
    }
  }
  if (!fields.length) return null
  const result = await database.query('UPDATE browser_test_executions SET ' + fields.join(', ') + ' WHERE id = $1 RETURNING *', params)
  return result.rows[0] || null
}

export async function persistBrowserTestStepResult({ executionId, stepNumber, action, status, expected, actual, errorCode, errorDetails, startedAt, completedAt, durationMs }) {
  const database = getDatabasePool()
  const result = await database.query(
    `INSERT INTO browser_test_step_results
     (execution_id, step_number, action, status, expected, actual, error_code, error_details, started_at, completed_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [executionId, stepNumber, action, status, expected === undefined ? null : JSON.stringify(expected), actual === undefined ? null : JSON.stringify(actual), errorCode || null, errorDetails || null, startedAt, completedAt, durationMs],
  )
  return result.rows[0]
}

export async function persistBrowserTestArtifact({ id, executionId, kind, relativePath, contentType, sizeBytes }) {
  const database = getDatabasePool()
  const result = await database.query(
    `INSERT INTO browser_test_artifacts (id, execution_id, kind, relative_path, content_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, executionId, kind, relativePath, contentType, sizeBytes ?? null],
  )
  return result.rows[0]
}

export async function getBrowserTestArtifactById(id) {
  const database = getDatabasePool()
  const result = await database.query('SELECT * FROM browser_test_artifacts WHERE id = $1', [id])
  return result.rows[0] || null
}

export async function listBrowserTestExecutions(limit = 100) {
  const database = getDatabasePool()
  const result = await database.query(
    `SELECT e.*, c.case_key, c.name AS case_name, s.name AS suite_name, a.name AS application_name
     FROM browser_test_executions e
     JOIN browser_test_cases c ON c.id = e.case_id
     JOIN browser_test_suites s ON s.id = e.suite_id
     JOIN applications a ON a.id = e.application_id
     ORDER BY e.created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(500, Number(limit) || 100))],
  )
  return result.rows
}

export async function getBrowserTestExecutionById(id) {
  const database = getDatabasePool()
  const result = await database.query(
    `SELECT e.*, c.case_key, c.name AS case_name, c.plan, c.expected_result, s.name AS suite_name, a.name AS application_name
     FROM browser_test_executions e
     JOIN browser_test_cases c ON c.id = e.case_id
     JOIN browser_test_suites s ON s.id = e.suite_id
     JOIN applications a ON a.id = e.application_id
     WHERE e.id = $1`,
    [id],
  )
  if (!result.rows[0]) return null
  const [steps, artifacts] = await Promise.all([
    database.query('SELECT * FROM browser_test_step_results WHERE execution_id = $1 ORDER BY step_number', [id]),
    database.query('SELECT * FROM browser_test_artifacts WHERE execution_id = $1 ORDER BY created_at', [id]),
  ])
  return { ...result.rows[0], steps: steps.rows, artifacts: artifacts.rows }
}

export async function interruptOrphanedBrowserTestExecutions() {
  const database = getDatabasePool()
  const result = await database.query(
    `UPDATE browser_test_executions SET status = 'INTERRUPTED', completed_at = now(),
       error_code = 'WORKER_RESTARTED', error_details = 'Execution was interrupted when the browser-test worker restarted.'
     WHERE status IN ('QUEUED', 'RUNNING') RETURNING id`,
  )
  return result.rows.length
}

export async function getBrowserTestStats() {
  const database = getDatabasePool()
  const [execStats, suiteStats, appStats] = await Promise.all([
    database.query(`
      SELECT
        COUNT(*) AS total_executions,
        COUNT(*) FILTER (WHERE status = 'PASSED') AS passed,
        COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
        COUNT(*) FILTER (WHERE status IN ('SKIPPED', 'BLOCKED', 'INTERRUPTED')) AS skipped,
        COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
        COUNT(*) FILTER (WHERE status IN ('QUEUED', 'RUNNING')) AS running,
        MAX(created_at) AS most_recent_execution
      FROM browser_test_executions
    `),
    database.query(`
      SELECT COUNT(*) AS total_suites,
             COALESCE(SUM(case_count), 0) AS total_cases
      FROM (
        SELECT s.id, COUNT(c.id) AS case_count
        FROM browser_test_suites s
        LEFT JOIN browser_test_cases c ON c.suite_id = s.id
        GROUP BY s.id
      ) sub
    `),
    database.query('SELECT COUNT(*) AS total_applications FROM applications WHERE status = $1', ['Active']),
  ])
  const e = execStats.rows[0]
  const s = suiteStats.rows[0]
  const a = appStats.rows[0]
  return {
    total_executions: Number(e.total_executions),
    passed: Number(e.passed),
    failed: Number(e.failed),
    skipped: Number(e.skipped),
    cancelled: Number(e.cancelled),
    running: Number(e.running),
    most_recent_execution: e.most_recent_execution || null,
    total_suites: Number(s.total_suites),
    total_cases: Number(s.total_cases),
    total_applications: Number(a.total_applications),
  }
}
