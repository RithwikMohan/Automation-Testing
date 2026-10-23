import { URL } from 'node:url'
import { normalizeAllowedOrigin } from '../exploration/networkSecurity.mjs'
import { validateActionPlan } from './actionRegistry.mjs'

const PLAN_VERSION = '1.0'
const MAX_ACTIONS = 50

// ─── Supported ARIA roles ────────────────────────────────────────────────────
const SUPPORTED_ROLES = new Set([
  'button', 'link', 'heading', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'tab', 'menuitem', 'searchbox', 'switch', 'spinbutton',
])

// ─── Locator parser ───────────────────────────────────────────────────────────
// Accepts both the strict syntax (role=button[name="..."]) and natural-language
// variants resolved from the surrounding instruction context.
function parseLocator(raw, lineNumber) {
  const value = raw.trim()

  // Strict: role=button[name="..."]
  let match = value.match(/^role=([a-zA-Z][a-zA-Z0-9-]{0,30})\[name="([^"\n]{1,120})"\]$/)
  if (match) {
    if (!SUPPORTED_ROLES.has(match[1])) throw new Error('Step ' + lineNumber + ': unsupported ARIA role "' + match[1] + '". Supported: ' + [...SUPPORTED_ROLES].join(', ') + '.')
    return { kind: 'role', role: match[1], name: match[2] }
  }

  // Strict: text="...", label="...", placeholder="...", testid="..."
  match = value.match(/^(text|label|placeholder|testid)="([^"\n]{1,160})"$/)
  if (match) return { kind: match[1], value: match[2] }

  // Strict: css=#id or css=.class
  match = value.match(/^css=(#[a-zA-Z][\w-]{0,100}|\.[a-zA-Z][\w-]{0,100})$/)
  if (match) return { kind: 'css', value: match[1] }

  throw new Error(
    'Step ' + lineNumber + ': unsupported or ambiguous locator "' + value.slice(0, 80) + '".\n' +
    'Use: role=button[name="..."], text="...", label="...", placeholder="...", testid="...", css=#id',
  )
}

// ─── Natural-language locator extraction ──────────────────────────────────────
// Interprets phrases like "the Sign In button", "the Email field", "the Country dropdown"
function parseNaturalLocator(phrase, lineNumber) {
  const trimmed = phrase.trim()

  // Explicit strict locators take priority
  if (/^(role=|text=|label=|placeholder=|testid=|css=)/.test(trimmed)) {
    return parseLocator(trimmed, lineNumber)
  }

  // role=button[name="..."] shorthand already covered above

  // Natural: "the <name> button" → role=button
  let match = trimmed.match(/^(?:the\s+)?(.+?)\s+button$/i)
  if (match) return { kind: 'role', role: 'button', name: match[1].trim() }
  match = trimmed.match(/^button\s+named\s+"([^"\n]{1,120})"$/i)
  if (match) return { kind: 'role', role: 'button', name: match[1] }

  // Natural: "the <name> link"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+link$/i)
  if (match) return { kind: 'role', role: 'link', name: match[1].trim() }

  // Natural: "the <name> field" or "the <name> input" or "the <name> textbox"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+(?:field|input|textbox)$/i)
  if (match) return { kind: 'label', value: match[1].trim() }

  // Natural: "the <name> checkbox"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+checkbox$/i)
  if (match) return { kind: 'role', role: 'checkbox', name: match[1].trim() }

  // Natural: "the <name> radio button"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+radio(?:\s+button)?$/i)
  if (match) return { kind: 'role', role: 'radio', name: match[1].trim() }

  // Natural: "the <name> dropdown" or "the <name> select"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+(?:dropdown|select)$/i)
  if (match) return { kind: 'role', role: 'combobox', name: match[1].trim() }

  // Natural: "the <name> heading"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+heading$/i)
  if (match) return { kind: 'role', role: 'heading', name: match[1].trim() }

  // Natural: "the <name> tab"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+tab$/i)
  if (match) return { kind: 'role', role: 'tab', name: match[1].trim() }

  // Natural: "the <name> menu item" or "the <name> menuitem"
  match = trimmed.match(/^(?:the\s+)?(.+?)\s+menu\s*item$/i)
  if (match) return { kind: 'role', role: 'menuitem', name: match[1].trim() }

  // Quoted text: text "Dashboard"
  match = trimmed.match(/^(?:text\s+)?"([^"\n]{1,160})"$/)
  if (match) return { kind: 'text', value: match[1] }

  if (/^(?:button|link|field|input|textbox|checkbox|radio|dropdown|select|heading|tab|menu\s*item)\s+/i.test(trimmed)) {
    throw new Error('Step ' + lineNumber + ': unsupported or ambiguous locator "' + trimmed.slice(0, 80) + '".')
  }

  // Raw text fallback — treat remaining as visible text
  if (trimmed.length > 0 && trimmed.length <= 160 && !/[<>{}]/.test(trimmed)) {
    return { kind: 'text', value: trimmed }
  }

  throw new Error('Step ' + lineNumber + ': cannot resolve locator from "' + trimmed.slice(0, 80) + '". Use a supported locator or a pattern like "the Sign In button".')
}

// ─── Test-data reference ──────────────────────────────────────────────────────
function parseDataReference(value, lineNumber) {
  const trimmed = value.trim()
  // ${test_data.key} reference
  const match = trimmed.match(/^\$\{test_data\.([a-zA-Z][a-zA-Z0-9_]{0,63})\}$/)
  if (!match) throw new Error('Step ' + lineNumber + ': values must use a ${test_data.key} reference, not a literal string.')
  return match[1]
}

// ─── Assertion parser ─────────────────────────────────────────────────────────
function parseAssertion(text, lineNumber) {
  const t = text.trim()

  // assert visible <locator> — strict form
  let match = t.match(/^assert\s+visible\s+(.+)$/i)
  if (match) return { action: 'assert_visible', locator: parseNaturalLocator(match[1], lineNumber) }

  // assert text <locator> contains "..."
  match = t.match(/^assert\s+text\s+(.+?)\s+contains\s+"([^"\n]{1,300})"$/i)
  if (match) return { action: 'assert_text', locator: parseNaturalLocator(match[1], lineNumber), expected: match[2] }

  // assert url contains/equals "..."
  match = t.match(/^assert\s+(?:that\s+)?(?:the\s+)?url\s+(contains|equals)\s+"([^"\n]{1,500})"$/i)
  if (match) {
    if (match[2].includes('?') || match[2].includes('#') || /^https?:\/\//i.test(match[2])) {
      throw new Error('Step ' + lineNumber + ': URL assertions must use a path without query strings or fragments.')
    }
    return { action: 'assert_url', operator: match[1].toLowerCase(), expected: match[2] }
  }

  // assert that the <locator> is visible (natural language)
  match = t.match(/^assert\s+that\s+(?:the\s+)?(.+?)\s+is\s+visible$/i)
  if (match) return { action: 'assert_visible', locator: parseNaturalLocator(match[1], lineNumber) }

  // assert that text "..." is visible
  match = t.match(/^assert\s+that\s+text\s*=\s*"([^"\n]{1,300})"\s+is\s+visible$/i)
  if (match) return { action: 'assert_visible', locator: { kind: 'text', value: match[1] } }

  // assert that the Status text contains "..."
  match = t.match(/^assert\s+that\s+(?:the\s+)?(.+?)\s+text\s+contains\s+"([^"\n]{1,300})"$/i)
  if (match) return { action: 'assert_text', locator: parseNaturalLocator(match[1].replace(/\s+text$/i, ''), lineNumber), expected: match[2] }

  // assert that the URL contains/equals "..."
  match = t.match(/^assert\s+that\s+(?:the\s+)?url\s+(contains|equals)\s+"([^"\n]{1,500})"$/i)
  if (match) {
    return { action: 'assert_url', operator: match[1].toLowerCase(), expected: match[2] }
  }

  // assert that the <field> field has value ${test_data.key}
  match = t.match(/^assert\s+that\s+(?:the\s+)?(.+?)\s+(?:field\s+)?has\s+value\s+(\$\{test_data\.[a-zA-Z][a-zA-Z0-9_]{0,63}\})$/i)
  if (match) return { action: 'assert_value', locator: parseNaturalLocator(match[1] + ' field', lineNumber), dataKey: parseDataReference(match[2], lineNumber) }

  // assert that the result count is greater than 0
  match = t.match(/^assert\s+that\s+(?:the\s+)?(.+?)\s+(?:count\s+)?is\s+greater\s+than\s+(\d+)$/i)
  if (match) return { action: 'assert_count_gt', locator: parseNaturalLocator(match[1], lineNumber), threshold: Number(match[2]) }

  throw new Error('Expected result line ' + lineNumber + ': use "assert visible", "assert text ... contains \\"...\\"", "assert url contains/equals \\"...\\"", or natural-language variants like "Assert that the Dashboard heading is visible".')
}

// ─── Step parser ──────────────────────────────────────────────────────────────
function parseStep(text, lineNumber) {
  const t = text.trim()

  // ── Navigate ──────────────────────────────────────────────────────────────
  // navigate: /path  OR  Navigate to /path  OR  Open https://example.com/...
  let match = t.match(/^navigate\s*:\s*(\S+)$/i) || t.match(/^navigate\s+(\S+)$/i)
  if (match) return { action: 'navigate', target: match[1] }

  match = t.match(/^(?:navigate\s+to|open)\s+(\S+)$/i)
  if (match) return { action: 'navigate', target: match[1] }

  // ── Click ─────────────────────────────────────────────────────────────────
  // click: <locator>  OR  Click the Sign In button  OR  Click role=button[name="..."]
  match = t.match(/^click\s*:\s*(.+)$/i) || t.match(/^click\s+(.+)$/i)
  if (match) return { action: 'click', locator: parseNaturalLocator(match[1], lineNumber), requiresApproval: true }

  // ── Fill / Enter ──────────────────────────────────────────────────────────
  // fill <locator> <- ${test_data.key}  (strict)
  match = t.match(/^fill\s+(.+?)\s*<-\s*(.+)$/i)
  if (match) return { action: 'fill', locator: parseNaturalLocator(match[1], lineNumber), dataKey: parseDataReference(match[2], lineNumber), requiresApproval: true }

  // Fill the Email field with ${test_data.email}  (natural)
  match = t.match(/^(?:fill|enter|type)\s+(?:the\s+)?(.+?)\s+(?:field\s+)?with\s+(\$\{test_data\.[a-zA-Z][a-zA-Z0-9_]{0,63}\})$/i)
  if (match) return { action: 'fill', locator: parseNaturalLocator(match[1] + ' field', lineNumber), dataKey: parseDataReference(match[2], lineNumber), requiresApproval: true }

  // Fill label="..." with ${test_data.key}
  match = t.match(/^(?:fill|enter|type)\s+((?:label|placeholder|testid)="[^"]{1,160}")\s+with\s+(\$\{test_data\.[a-zA-Z][a-zA-Z0-9_]{0,63}\})$/i)
  if (match) return { action: 'fill', locator: parseNaturalLocator(match[1], lineNumber), dataKey: parseDataReference(match[2], lineNumber), requiresApproval: true }

  // ── Select ────────────────────────────────────────────────────────────────
  // select <locator> <- ${test_data.key}  (strict)
  match = t.match(/^select\s+(.+?)\s*<-\s*(\$\{test_data\.[a-zA-Z][a-zA-Z0-9_]{0,63}\})$/i)
  if (match) return { action: 'select', locator: parseNaturalLocator(match[1], lineNumber), dataKey: parseDataReference(match[2], lineNumber), requiresApproval: true }

  // Select India from the Country dropdown
  match = t.match(/^select\s+(\$\{test_data\.[a-zA-Z][a-zA-Z0-9_]{0,63}\})\s+from\s+(?:the\s+)?(.+?)\s+(?:dropdown|select|list)$/i)
  if (match) return { action: 'select', locator: parseNaturalLocator(match[2] + ' dropdown', lineNumber), dataKey: parseDataReference(match[1], lineNumber), requiresApproval: true }

  // An explicit, non-secret option label can be selected after run approval.
  match = t.match(/^select\s+"([^"\n]{1,120})"\s+from\s+(?:the\s+)?(.+?)\s+(?:dropdown|select|list)$/i)
  if (match) return { action: 'select', locator: parseNaturalLocator(match[2] + ' dropdown', lineNumber), optionLabel: match[1], requiresApproval: true }

  // Select label="..." with ${test_data.key}
  match = t.match(/^select\s+((?:label|testid)="[^"]{1,160}")\s+with\s+(\$\{test_data\.[a-zA-Z][a-zA-Z0-9_]{0,63}\})$/i)
  if (match) return { action: 'select', locator: parseNaturalLocator(match[1], lineNumber), dataKey: parseDataReference(match[2], lineNumber), requiresApproval: true }

  // ── Check / Uncheck ───────────────────────────────────────────────────────
  match = t.match(/^(check|uncheck)\s+(.+)$/i)
  if (match) return { action: match[1].toLowerCase(), locator: parseNaturalLocator(match[2], lineNumber), requiresApproval: true }

  // Select the Male radio button
  match = t.match(/^select\s+(?:the\s+)?(.+?)\s+radio(?:\s+button)?$/i)
  if (match) return { action: 'check', locator: { kind: 'role', role: 'radio', name: match[1].trim() }, requiresApproval: true }

  // ── Create / Update / Delete ──────────────────────────────────────────────
  match = t.match(/^(create|update|delete)(?:\s*:\s*|\s+)(.+)$/i)
  if (match) return { action: match[1].toLowerCase(), locator: parseNaturalLocator(match[2], lineNumber), requiresApproval: true, requiresWriteApproval: true }

  // ── Wait ──────────────────────────────────────────────────────────────────
  // wait visible <locator>  or  Wait until the <locator> is visible  or  Wait for text="..."
  match = t.match(/^wait\s+visible\s+(.+?)(?:\s+timeout=(\d{1,5}))?$/i)
  if (match) {
    const timeoutMs = Number(match[2] || 10000)
    if (timeoutMs < 100 || timeoutMs > 60000) throw new Error('Step ' + lineNumber + ': wait timeout must be 100–60,000 ms.')
    return { action: 'wait_visible', locator: parseNaturalLocator(match[1], lineNumber), timeoutMs }
  }

  match = t.match(/^wait\s+(?:until|for)\s+(?:the\s+)?(.+?)\s+is\s+visible(?:\s+timeout=(\d{1,5}))?$/i)
  if (match) {
    const timeoutMs = Number(match[2] || 10000)
    return { action: 'wait_visible', locator: parseNaturalLocator(match[1], lineNumber), timeoutMs }
  }

  match = t.match(/^wait\s+for\s+text\s*=\s*"([^"\n]{1,300})"(?:\s+timeout=(\d{1,5}))?$/i)
  if (match) {
    const timeoutMs = Number(match[2] || 10000)
    return { action: 'wait_visible', locator: { kind: 'text', value: match[1] }, timeoutMs }
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  match = t.match(/^read\s+(?:the\s+text\s+of\s+)?(.+?)\s+as\s+([a-zA-Z][a-zA-Z0-9_]{0,63})$/i)
  if (match) return { action: 'read_text', locator: parseNaturalLocator(match[1], lineNumber), resultKey: match[2] }

  // ── Assertions ────────────────────────────────────────────────────────────
  if (/^assert\s/i.test(t)) return parseAssertion(t, lineNumber)

  match = t.match(/^verify\s+(?:that\s+)?(.+)$/i)
  if (match) return parseAssertion('assert that ' + match[1], lineNumber)

  throw new Error(
    'Step ' + lineNumber + ': unsupported instruction "' + t.slice(0, 120) + '".\n' +
    'Supported: navigate, click, fill/enter, select, check, uncheck, wait visible/until, read, assert visible/text/url/value.\n' +
    'For write operations: create, update, delete (require per-run approval).',
  )
}

// ─── Secret guard ─────────────────────────────────────────────────────────────
function splitInstructionSteps(rawSteps) {
  const source = String(rawSteps || '')
  const result = []
  let current = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        current += '""'
        index += 1
        continue
      }
      quoted = !quoted
    }
    if (!quoted && (character === ';' || character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      result.push(current)
      current = ''
    } else {
      current += character
    }
  }
  result.push(current)
  return result
}

function normalizeSteps(rawSteps, label, splitSemicolons = false) {
  const lines = splitSemicolons ? splitInstructionSteps(rawSteps) : String(rawSteps || '').split(/\r?\n/)
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      if (/\b(?:password|passwd|pwd|token|secret|cookie|api[_-]?key)\s*[:=]/i.test(line)) {
        throw new Error(label + ' line ' + (index + 1) + ': secret-like values are not allowed.')
      }
      return line
    })
}

// ─── Main compiler ────────────────────────────────────────────────────────────
export function compileTestCase(testCase, application) {
  const appBase = new URL(application.base_url)
  const testData = testCase.testData || {}

  const actionLines = normalizeSteps(testCase.rawSteps, 'Step', true)
  const actions = actionLines.map((line, index) => parseStep(line, index + 1))

  const preconditionLines = normalizeSteps((testCase.preconditions || []).join('\n'), 'Precondition')
  const preconditions = preconditionLines.map((line, index) => parseAssertion(line, index + 1))

  // Resolve navigation URLs
  for (const action of actions) {
    if (action.action === 'navigate') {
      let target
      try { target = new URL(action.target, appBase) } catch { throw new Error('Navigation target "' + action.target + '" is invalid.') }
      try { normalizeAllowedOrigin(target.origin) } catch { throw new Error('Navigation target has an invalid origin.') }
      action.url = target.origin + target.pathname
      delete action.target
    }
  }

  // Parse expected result assertions
  const assertionLines = normalizeSteps(testCase.expectedResult, 'Expected result')
  const assertions = assertionLines.map(parseAssertion)
  if (assertions.length === 0) throw new Error('Expected result must include at least one meaningful assertion.')

  const allActions = [...preconditions, ...actions, ...assertions]
  if (!allActions.length) throw new Error('The case must contain at least one supported action or assertion.')
  if (allActions.length > MAX_ACTIONS) throw new Error('The case exceeds the ' + MAX_ACTIONS + '-action limit (' + allActions.length + ' actions).')

  // Verify write actions are followed by assertions
  const writeIndexes = allActions
    .map((a, i) => (a.requiresWriteApproval ? i : -1))
    .filter((i) => i >= 0)
  for (const [position, index] of writeIndexes.entries()) {
    const nextWriteIndex = writeIndexes[position + 1] ?? allActions.length
    if (!allActions.slice(index + 1, nextWriteIndex).some((a) => a.action.startsWith('assert_'))) {
      throw new Error('Every create, update, or delete action must be followed by an assertion before the next write action.')
    }
  }

  // Verify test data references exist
  for (const action of allActions) {
    if (
      action.dataKey &&
      (!Object.hasOwn(testData, action.dataKey) ||
        (typeof testData[action.dataKey] !== 'string' && typeof testData[action.dataKey] !== 'number'))
    ) {
      throw new Error(
        'Test data key "' + action.dataKey + '" is referenced in a step but was not found in test_data or is not a string/number.',
      )
    }
  }

  const plan = { version: PLAN_VERSION, actions: allActions, actionLimit: MAX_ACTIONS }
  return validateActionPlan(plan, testData)
}

export const TEST_PLAN_VERSION = PLAN_VERSION
export const TEST_ACTION_LIMIT = MAX_ACTIONS
