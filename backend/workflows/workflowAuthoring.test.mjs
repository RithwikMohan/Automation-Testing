import assert from 'node:assert/strict'
import test from 'node:test'
import { setDatabasePoolForTesting } from '../database.mjs'
import { saveWorkflowDefinition, validateForApplication } from './workflowAuthoring.mjs'

class WorkflowPool {
  constructor() {
    this.application = { id: 'app-1', name: 'Timesheets', base_url: 'https://app.example.test/', approved_navigation_origins: [], status: 'Active' }
    this.current = null
    this.versions = []
  }
  async query(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim()
    if (query.startsWith('SELECT a.*') || query.startsWith('SELECT a.*, COUNT')) return { rows: params[0] === this.application.id ? [{ ...this.application, task_count: 0 }] : [] }
    if (query.startsWith('SELECT id, name, task_category')) return { rows: [] }
    if (query.startsWith('SELECT workflow_version FROM application_workflow_templates')) return { rows: this.current ? [{ workflow_version: this.current.workflow_version }] : [] }
    if (query.startsWith('INSERT INTO application_workflow_templates')) {
      const [applicationId, workflowName, actionPlan, dataFields, stepsText, csvTemplate, workflowVersion] = params
      this.current = { application_id: applicationId, workflow_name: workflowName, action_plan: JSON.parse(actionPlan), data_fields: JSON.parse(dataFields), steps_text: stepsText, csv_template: csvTemplate, workflow_version: workflowVersion }
      return { rows: [{ ...this.current }] }
    }
    if (query.startsWith('INSERT INTO application_workflow_versions')) { this.versions.push(params); return { rows: [] } }
    throw new Error(`Unexpected query: ${query}`)
  }
}

const definition = {
  name: 'Weekly hours',
  variables: [
    { key: 'project_name', label: 'Project', required: true, type: 'text' },
    { key: 'work_date', label: 'Work date', required: true, type: 'date' },
    { key: 'hours', label: 'Hours', required: true, type: 'number', defaultValue: '8' },
  ],
  actions: [
    { id: 'go', action: 'navigate', url: 'https://app.example.test/timesheet' },
    { id: 'fill-hours', action: 'fill', locator: { kind: 'label', value: 'Hours' }, locatorCandidates: [{ kind: 'label', value: 'Hours' }], variableKey: 'hours', contextualTarget: { strategy: 'table_intersection', tableSelector: '#week', rowSelector: 'tbody tr', rowLabelSelector: 'th', headerSelector: 'thead th', rowCellSelector: 'th,td', cellSelector: 'input', rowText: '${project_name}', headerText: '${work_date}', headerMatch: 'date' } },
    { id: 'success', action: 'assert_url', operator: 'contains', expected: '/saved' },
  ],
}

test('manual workflow validation and save persist an executable contextual definition as a new version', async () => {
  const pool = new WorkflowPool()
  setDatabasePoolForTesting(pool)
  try {
    const validated = await validateForApplication('app-1', definition)
    assert.match(validated.stepsText, /fill label="Hours" <- \$\{test_data\.hours\}/)
    assert.match(validated.stepsText, /assert url contains "\/saved"/)
    const first = await saveWorkflowDefinition('app-1', definition)
    assert.equal(first.workflow_version, 1)
    assert.deepEqual(first.action_plan[1].contextualTarget, definition.actions[1].contextualTarget)
    assert.deepEqual(first.data_fields.map((item) => item.key), ['project_name', 'work_date', 'hours'])
    assert.match(first.csv_template, /test_case_id,name,preconditions,steps,project_name,work_date,hours,expected_result/)
    const second = await saveWorkflowDefinition('app-1', { ...definition, name: 'Weekly hours edited' })
    assert.equal(second.workflow_version, 2)
    assert.equal(pool.versions.length, 2)
  } finally { setDatabasePoolForTesting(null) }
})

test('manual workflow validation rejects undeclared contextual variables and duplicate action IDs', async () => {
  const pool = new WorkflowPool()
  setDatabasePoolForTesting(pool)
  try {
    await assert.rejects(validateForApplication('app-1', { ...definition, variables: definition.variables.filter((item) => item.key !== 'work_date') }), /unknown variable/)
    await assert.rejects(validateForApplication('app-1', { ...definition, actions: definition.actions.map((item) => ({ ...item, id: 'same' })) }), /unique stable action ID/)
  } finally { setDatabasePoolForTesting(null) }
})
