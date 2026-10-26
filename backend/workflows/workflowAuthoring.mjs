import { getApplicationById, saveApplicationWorkflowTemplate } from '../database.mjs'
import { validateWorkflowDefinition } from './workflowDefinition.mjs'
import { generateWorkflowCsvTemplate } from './csvTemplate.mjs'
import { normalizeAllowedOrigin } from '../exploration/networkSecurity.mjs'

function locatorRule(locator) {
  if (locator.kind === 'role') return `role=${locator.role}[name=${JSON.stringify(locator.name)}]`
  if (locator.kind === 'css') return `css=${locator.value}`
  return `${locator.kind}=${JSON.stringify(locator.value)}`
}

export function actionToRuleText(action) {
  if (action.action === 'navigate') return `navigate: ${action.url}`
  if (action.action === 'assert_url') return `assert url ${action.operator} ${JSON.stringify(action.expected)}`
  const locator = locatorRule(action.locator)
  if (action.action === 'click' || action.action === 'check' || action.action === 'uncheck') return `${action.action} ${locator}`
  if (action.action === 'fill' || action.action === 'select') return `${action.action} ${locator} <- \${test_data.${action.variableKey}}`
  if (action.action === 'wait_visible') return `wait visible ${locator} timeout=${action.timeoutMs}`
  if (action.action === 'assert_visible') return `assert visible ${locator}`
  if (action.action === 'assert_text') return `assert text ${locator} contains ${JSON.stringify(action.expected)}`
  if (action.action === 'assert_value') return `assert value ${locator} <- \${test_data.${action.variableKey}}`
  throw new Error(`Cannot generate a runnable step for action "${action.action}".`)
}

export function buildWorkflowStepText(definition) {
  return definition.actions.map(actionToRuleText).join('\n')
}

export async function validateForApplication(applicationId, input) {
  const application = await getApplicationById(applicationId)
  if (!application || application.status !== 'Active') throw new Error('An active registered application is required.')
  const origin = normalizeAllowedOrigin(new URL(application.base_url).origin)
  const registeredOrigins = [origin, ...(application.approved_navigation_origins || []).map(normalizeAllowedOrigin)]
  const definition = validateWorkflowDefinition({ ...input, applicationId }, { applicationId, registeredOrigins })
  const stepsText = buildWorkflowStepText(definition)
  return { application, definition, stepsText }
}

export async function saveWorkflowDefinition(applicationId, input) {
  const { definition, stepsText } = await validateForApplication(applicationId, input)
  const fields = definition.variables.map((variable) => ({ ...variable, variable: true }))
  const actionPlan = definition.actions.map((action) => ({ ...action, ...(action.variableKey ? { dataKey: action.variableKey } : {}), ruleText: actionToRuleText(action) }))
  return saveApplicationWorkflowTemplate({
    applicationId,
    workflowName: definition.name,
    actionPlan,
    dataFields: fields,
    stepsText,
    csvTemplateForVersion: (version) => generateWorkflowCsvTemplate({ name: definition.name, variables: fields, actions: actionPlan }, version),
  })
}
