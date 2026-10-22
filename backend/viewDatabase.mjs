import 'dotenv/config'
import { getDatabasePool } from './database.mjs'

async function viewDatabase() {
  const db = getDatabasePool()

  console.log('\n=================== POSTGRESQL TABLES ===================')
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
  )
  console.log(tables.rows.map((r) => r.table_name).join(', '))

  console.log('\n=================== LATEST RUNS (automation_runs) ===================')
  const runs = await db.query(
    'SELECT id, source_case_id, status, read_only, created_at FROM automation_runs ORDER BY created_at DESC LIMIT 5;'
  )
  console.table(runs.rows)

  console.log('\n=================== LATEST CASES (automation_cases) ===================')
  const cases = await db.query(
    'SELECT id, run_id, case_id, project, requested_hours, status, current_hours, updated_hours FROM automation_cases ORDER BY id DESC LIMIT 10;'
  )
  console.table(cases.rows)

  console.log('\n=================== LATEST ARTIFACTS (automation_artifacts) ===================')
  const artifacts = await db.query(
    'SELECT id, run_id, case_id, kind, content_type FROM automation_artifacts ORDER BY id DESC LIMIT 5;'
  )
  console.table(artifacts.rows)

  process.exit(0)
}

viewDatabase().catch((error) => {
  console.error('Failed to query database:', error.message)
  process.exit(1)
})
