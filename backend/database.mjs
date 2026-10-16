import pg from 'pg'
import { normalizeDate } from './timesheetUpdates.mjs'

const { Pool } = pg

let pool

export function getDatabasePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.')
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 5_000),
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  })
  return pool
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
