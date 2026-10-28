const FIXED_HEADERS = ['test_case_id', 'name', 'preconditions', 'steps', 'expected_result', 'priority', 'tags']

export function serializeCsv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = String(value ?? '')
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }).join(',')).join('\r\n') + '\r\n'
}

export function generateWorkflowCsvTemplate(definition, workflowVersion = 1) {
  const variables = (definition.variables || []).filter((item) => item.variable !== false && (item.sensitive !== true || item.credential === true))
  const headers = [...FIXED_HEADERS.slice(0, 4), ...variables.map((item) => item.key), ...FIXED_HEADERS.slice(4)]
  const actions = definition.actions || []
  const finalAction = actions.at(-1)
  const finalAssertion = finalAction?.action?.startsWith('assert_') ? finalAction.ruleText : null
  const stepActions = finalAssertion ? actions.slice(0, -1) : actions
  const row = ['TC001', `${definition.name} case 1`, '[]', stepActions.map((action) => action.ruleText || '').filter(Boolean).join('\n')]
  row.push(...variables.map((item) => item.defaultValue ?? ''))
  row.push(finalAssertion || 'assert visible text="Replace with expected result"', 'normal', `workflow-v${workflowVersion}`)
  return serializeCsv([headers, row])
}

export const WORKFLOW_CSV_FIXED_HEADERS = Object.freeze(FIXED_HEADERS)
