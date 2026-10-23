// The executor may only receive actions that have a registered, validated shape.
export const ACTION_RULES = Object.freeze({
  navigate: ['url'], click: ['locator'], fill: ['locator', 'dataKey'], select: ['locator'],
  check: ['locator'], uncheck: ['locator'], wait_visible: ['locator', 'timeoutMs'], read_text: ['locator', 'resultKey'],
  assert_visible: ['locator'], assert_text: ['locator', 'expected'], assert_url: ['operator', 'expected'],
  assert_value: ['locator', 'dataKey'], assert_count_gt: ['locator', 'threshold'],
  create: ['locator'], update: ['locator'], delete: ['locator'],
})

const LOCATOR_KINDS = new Set(['role', 'text', 'label', 'placeholder', 'testid', 'css'])
const ASSERTION_ACTIONS = new Set(['assert_visible', 'assert_text', 'assert_url', 'assert_value', 'assert_count_gt'])

export function validateActionPlan(plan, testData = {}) {
  if (!plan || plan.version !== '1.0' || !Array.isArray(plan.actions) || plan.actions.length === 0 || plan.actions.length > 50) {
    throw Object.assign(new Error('The saved action plan is invalid or unsupported.'), { code: 'INVALID_ACTION_PARAMETERS' })
  }
  for (const action of plan.actions) {
    const required = ACTION_RULES[action?.action]
    if (!required) throw Object.assign(new Error('The saved plan contains unsupported action "' + String(action?.action) + '".'), { code: 'UNSUPPORTED_INSTRUCTION' })
    if (required.some((key) => action[key] === undefined || action[key] === null)) {
      throw Object.assign(new Error('The saved "' + action.action + '" action is missing required parameters.'), { code: 'INVALID_ACTION_PARAMETERS' })
    }
    if (action.locator && (!LOCATOR_KINDS.has(action.locator.kind) || typeof (action.locator.value || action.locator.name) !== 'string')) {
      throw Object.assign(new Error('The saved action contains an invalid locator.'), { code: 'INVALID_ACTION_PARAMETERS' })
    }
    if (action.dataKey && !Object.hasOwn(testData, action.dataKey)) {
      throw Object.assign(new Error('The saved action references missing test data.'), { code: 'INVALID_ACTION_PARAMETERS' })
    }
    if (action.action === 'select' && Boolean(action.dataKey) === Boolean(action.optionLabel)) {
      throw Object.assign(new Error('Select requires exactly one test data reference or explicit option label.'), { code: 'INVALID_ACTION_PARAMETERS' })
    }
    if (action.action === 'navigate') {
      let navigationUrl
      try { navigationUrl = new URL(action.url) } catch { throw Object.assign(new Error('Navigation URL must be absolute and valid.'), { code: 'INVALID_ACTION_PARAMETERS' }) }
      if (!['http:', 'https:'].includes(navigationUrl.protocol) || navigationUrl.username || navigationUrl.password) {
        throw Object.assign(new Error('Navigation supports only credential-free HTTP or HTTPS URLs.'), { code: 'UNSUPPORTED_INSTRUCTION' })
      }
    }
    if (action.action === 'assert_url' && !['equals', 'contains'].includes(action.operator)) {
      throw Object.assign(new Error('URL assertion operator is unsupported.'), { code: 'INVALID_ACTION_PARAMETERS' })
    }
    if (action.action === 'wait_visible' && (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 100 || action.timeoutMs > 60000)) {
      throw Object.assign(new Error('Wait timeout must be between 100 and 60,000 ms.'), { code: 'INVALID_ACTION_PARAMETERS' })
    }
  }
  if (!plan.actions.some((action) => ASSERTION_ACTIONS.has(action.action))) {
    throw Object.assign(new Error('A test case must include at least one expected-result assertion.'), { code: 'INVALID_ACTION_PARAMETERS' })
  }
  return plan
}
