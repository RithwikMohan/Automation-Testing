import { URL } from 'node:url'
import { normalizeAllowedOrigin } from '../exploration/networkSecurity.mjs'

const PLAN_VERSION = '1.0'
const MAX_ACTIONS = 30

function parseLocator(raw, lineNumber) {
  const value = raw.trim()
  let match = value.match(/^role=([a-zA-Z][a-zA-Z0-9-]{0,30})\[name="([^"\n]{1,120})"\]$/)
  if (match) {
    const supportedRoles = new Set(['button', 'link', 'heading', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'searchbox', 'switch'])
    if (!supportedRoles.has(match[1])) throw new Error('Step ' + lineNumber + ': unsupported ARIA role.')
    return { kind: 'role', role: match[1], name: match[2] }
  }
  match = value.match(/^(text|label|placeholder|testid)="([^"\n]{1,160})"$/)
  if (match) return { kind: match[1], value: match[2] }
  match = value.match(/^css=(#[a-zA-Z][\w-]{0,100}|\.[a-zA-Z][\w-]{0,100})$/)
  if (match) return { kind: 'css', value: match[1] }
  throw new Error('Step ' + lineNumber + ': unsupported or ambiguous locator. Use role=button[name="..."], text="...", label="...", placeholder="...", testid="...", or css=#id.')
}

function dataReference(value, lineNumber) {
  const match = value.trim().match(/^\$\{test_data\.([a-zA-Z][a-zA-Z0-9_]{0,63})\}$/)
  if (!match) throw new Error('Step ' + lineNumber + ': field values must use a ${test_data.key} reference.')
  return match[1]
}

function parseAssertion(text, lineNumber) {
  let match = text.match(/^assert\s+visible\s+(.+)$/i)
  if (match) return { action: 'assert_visible', locator: parseLocator(match[1], lineNumber) }
  match = text.match(/^assert\s+text\s+(.+)\s+contains\s+"([^"\n]{1,300})"$/i)
  if (match) return { action: 'assert_text', locator: parseLocator(match[1], lineNumber), expected: match[2] }
  match = text.match(/^assert\s+url\s+(contains|equals)\s+"([^"\n]{1,500})"$/i)
  if (match) {
    if (match[2].includes('?') || match[2].includes('#') || /^https?:\/\//i.test(match[2])) throw new Error('Step ' + lineNumber + ': URL assertions must use an in-scope path without query strings or fragments.')
    return { action: 'assert_url', operator: match[1].toLowerCase(), expected: match[2] }
  }
  throw new Error('Expected result line ' + lineNumber + ': use assert visible, assert text ... contains "...", or assert url contains/equals "...".')
}

function parseStep(text, lineNumber) {
  let match = text.match(/^navigate\s*:\s*(\S+)$/i) || text.match(/^navigate\s+(\S+)$/i)
  if (match) return { action: 'navigate', target: match[1] }
  match = text.match(/^click\s*:\s*(.+)$/i) || text.match(/^click\s+(.+)$/i)
  if (match) return { action: 'click', locator: parseLocator(match[1], lineNumber), requiresApproval: true }
  match = text.match(/^(create|update|delete)(?:\s*:\s*|\s+)(.+)$/i)
  if (match) return { action: match[1].toLowerCase(), locator: parseLocator(match[2], lineNumber), requiresApproval: true, requiresWriteApproval: true }
  match = text.match(/^fill\s+(.+?)\s*<-\s*(.+)$/i)
  if (match) return { action: 'fill', locator: parseLocator(match[1], lineNumber), dataKey: dataReference(match[2], lineNumber), requiresApproval: true }
  match = text.match(/^select\s+(.+?)\s*<-\s*(.+)$/i)
  if (match) return { action: 'select', locator: parseLocator(match[1], lineNumber), dataKey: dataReference(match[2], lineNumber), requiresApproval: true }
  match = text.match(/^(check|uncheck)\s+(.+)$/i)
  if (match) return { action: match[1].toLowerCase(), locator: parseLocator(match[2], lineNumber), requiresApproval: true }
  match = text.match(/^wait\s+visible\s+(.+?)(?:\s+timeout=(\d{1,5}))?$/i)
  if (match) {
    const timeoutMs = Number(match[2] || 5000)
    if (timeoutMs < 100 || timeoutMs > 30000) throw new Error('Step ' + lineNumber + ': wait timeout must be between 100 and 30,000 ms.')
    return { action: 'wait_visible', locator: parseLocator(match[1], lineNumber), timeoutMs }
  }
  match = text.match(/^read\s+(.+?)\s+as\s+([a-zA-Z][a-zA-Z0-9_]{0,63})$/i)
  if (match) return { action: 'read_text', locator: parseLocator(match[1], lineNumber), resultKey: match[2] }
  if (/^assert\s/i.test(text)) return parseAssertion(text, lineNumber)
  throw new Error('Step ' + lineNumber + ': unsupported instruction. Use navigate, click, create, update, delete, fill, select, check, uncheck, wait visible, read, or assert.')
}

function normalizeSteps(rawSteps, label) {
  return String(rawSteps || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    if (/\b(?:password|passwd|pwd|token|secret|cookie|api[_-]?key)\s*[:=]/i.test(line)) throw new Error(label + ' line ' + (index + 1) + ': secret-like values are not allowed.')
    return line
  })
}

export function compileTestCase(testCase, application) {
  const appBase = new URL(application.base_url)
  const testData = testCase.testData || {}
  const permittedNavigation = new Set([normalizeAllowedOrigin(appBase.origin), ...(application.approved_navigation_origins || []).map(normalizeAllowedOrigin)])
  const actionLines = normalizeSteps(testCase.rawSteps, 'Step')
  const actions = actionLines.map((line, index) => parseStep(line, index + 1))
  const preconditionLines = normalizeSteps((testCase.preconditions || []).join('\n'), 'Precondition')
  const preconditions = preconditionLines.map((line, index) => parseAssertion(line, index + 1))
  for (const action of actions) {
    if (action.action === 'navigate') {
      let target
      try { target = new URL(action.target, appBase) } catch { throw new Error('Navigation target is invalid.') }
      let origin
      try { origin = normalizeAllowedOrigin(target.origin) } catch { throw new Error('Navigation target is not an approved application origin.') }
      if (!permittedNavigation.has(origin)) throw new Error('Navigation target origin is not approved for this application.')
      action.url = target.origin + target.pathname
      delete action.target
    }
  }
  const assertions = normalizeSteps(testCase.expectedResult, 'Expected result').map(parseAssertion)
  const plan = { version: PLAN_VERSION, actions: [...preconditions, ...actions, ...assertions], actionLimit: MAX_ACTIONS }
  if (!plan.actions.length) throw new Error('The case must contain at least one supported action or assertion.')
  if (plan.actions.length > MAX_ACTIONS) throw new Error('The case exceeds the 30-action limit.')
  const writeIndexes = plan.actions.map((action, index) => action.requiresWriteApproval ? index : -1).filter((index) => index >= 0)
  for (const [position, index] of writeIndexes.entries()) {
    const nextWriteIndex = writeIndexes[position + 1] ?? plan.actions.length
    if (!plan.actions.slice(index + 1, nextWriteIndex).some((action) => action.action.startsWith('assert_'))) {
      throw new Error('Every create, update, or delete action must be followed by an assertion before the next write.')
    }
  }
  for (const action of plan.actions) {
    if ((action.dataKey && !Object.hasOwn(testData, action.dataKey)) || (action.dataKey && typeof testData[action.dataKey] !== 'string' && typeof testData[action.dataKey] !== 'number')) {
      throw new Error('Test data reference is missing or must resolve to a string or number.')
    }
  }
  return plan
}

export const TEST_PLAN_VERSION = PLAN_VERSION
export const TEST_ACTION_LIMIT = MAX_ACTIONS
