const ACTIONS = new Set(['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'create', 'update', 'delete', 'press', 'wait_visible', 'assert_visible', 'assert_text', 'assert_url', 'assert_value'])
const LOCATOR_KINDS = new Set(['role', 'label', 'placeholder', 'testid', 'text', 'id', 'name', 'css', 'xpath'])
const SAFE_ROLES = new Set(['button', 'link', 'heading', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'searchbox', 'switch', 'spinbutton'])
const RESERVED_VARIABLE_KEYS = new Set(['test_case_id', 'name', 'preconditions', 'steps', 'test_data', 'expected_result', 'priority', 'tags'])
const CONTEXT_SELECTORS = ['tableSelector', 'rowSelector', 'rowLabelSelector', 'headerSelector', 'cellSelector']

function validateContextualTarget(target, index, variableKeys) {
  if (!target || target.strategy !== 'table_intersection') throw new Error(`Workflow action ${index + 1} has an unsupported contextual target strategy.`)
  for (const key of CONTEXT_SELECTORS) if (typeof target[key] !== 'string' || !target[key].trim() || target[key].length > 240) throw new Error(`Workflow action ${index + 1} has an invalid contextual ${key}.`)
  if (target.rowCellSelector !== undefined && (typeof target.rowCellSelector !== 'string' || !target.rowCellSelector.trim() || target.rowCellSelector.length > 240)) throw new Error(`Workflow action ${index + 1} has an invalid contextual rowCellSelector.`)
  for (const key of ['rowText', 'headerText']) {
    if (typeof target[key] !== 'string' || !target[key].trim() || target[key].length > 240 || /\$\{(?![a-z][a-z0-9_]*\})/.test(target[key])) throw new Error(`Workflow action ${index + 1} has an invalid contextual ${key}.`)
    for (const [, variableKey] of target[key].matchAll(/\$\{([a-z][a-z0-9_]*)\}/g)) if (!variableKeys.has(variableKey)) throw new Error(`Workflow action ${index + 1} contextual target references an unknown variable.`)
  }
  if (target.headerMatch !== undefined && !['exact', 'date'].includes(target.headerMatch)) throw new Error(`Workflow action ${index + 1} has an invalid contextual headerMatch.`)
  return { strategy: 'table_intersection', ...Object.fromEntries([...CONTEXT_SELECTORS, 'rowCellSelector', 'rowText', 'headerText'].filter((key) => target[key] !== undefined).map((key) => [key, target[key].trim()])), headerMatch: target.headerMatch || 'exact' }
}

function copyCaptureMetadata(safe, action, origins, index) {
  if (Number.isInteger(action.sequence) && action.sequence > 0) safe.sequence = action.sequence
  if (typeof action.capturedAt === 'string' && !Number.isNaN(Date.parse(action.capturedAt))) safe.capturedAt = new Date(action.capturedAt).toISOString()
  for (const key of ['pageUrl', 'pageUrlAfter']) {
    if (typeof action[key] !== 'string' || !action[key]) continue
    let url
    try { url = new URL(action[key]) } catch { throw new Error(`Workflow action ${index + 1} has an invalid captured page URL.`) }
    if (!origins?.has(url.origin) || url.search || url.hash || url.username || url.password) throw new Error(`Workflow action ${index + 1} was captured outside the registered navigation scope.`)
    safe[key] = url.origin + url.pathname
  }
  if (action.element && typeof action.element === 'object') {
    safe.element = Object.fromEntries(['tag', 'name', 'id', 'placeholder', 'inputType'].filter((key) => typeof action.element[key] === 'string').map((key) => [key, action.element[key].slice(0, key === 'placeholder' ? 160 : 120)]))
  }
  return safe
}

export function validateWorkflowDefinition(input, { applicationId, registeredOrigins } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow definition must be an object.')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Workflow name is required and must be at most 120 characters.')
  if (applicationId && input.applicationId !== applicationId) throw new Error('Workflow application does not match the selected registered application.')
  if (!Array.isArray(input.variables) || input.variables.length > 100) throw new Error('Workflow variables must be an array of at most 100 entries.')
  const variableKeys = new Set()
  for (const variable of input.variables) {
    if (!variable || !/^[a-z][a-z0-9_]{0,63}$/.test(variable.key || '') || RESERVED_VARIABLE_KEYS.has(variable.key) || variableKeys.has(variable.key)) throw new Error('Workflow variable keys must be unique, non-reserved lowercase identifiers.')
    if (typeof variable.label !== 'string' || !variable.label.trim() || variable.label.length > 160) throw new Error('Every workflow variable needs a display label.')
    if (variable.type !== undefined && !['text', 'number', 'date', 'email'].includes(variable.type)) throw new Error(`Workflow variable "${variable.key}" has an unsupported type.`)
    if (variable.defaultValue !== undefined && (typeof variable.defaultValue !== 'string' || variable.defaultValue.length > 2000)) throw new Error(`Workflow variable "${variable.key}" has an invalid default value.`)
    if (variable.pattern !== undefined && (typeof variable.pattern !== 'string' || variable.pattern.length > 160 || /(\\[1-9]|\(\?[:=!<]|\([^)]*[+*][^)]*\)[+*{])/.test(variable.pattern))) throw new Error(`Workflow variable "${variable.key}" has an invalid or unsupported validation pattern.`)
    if (variable.pattern) { try { new RegExp(variable.pattern) } catch { throw new Error(`Workflow variable "${variable.key}" has an invalid validation pattern.`) } }
    if (variable.sensitive === true && !(variable.credential === true && variable.key === 'password')) throw new Error('Credential and secret fields are not allowed as CSV variables except an explicitly identified password field.')
    variableKeys.add(variable.key)
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 100) throw new Error('Workflow must contain between 1 and 100 actions.')
  const origins = registeredOrigins ? new Set(registeredOrigins) : null
  const actionIds = new Set()
  const actions = input.actions.map((action, index) => {
    if (!action || !ACTIONS.has(action.action)) throw new Error(`Workflow action ${index + 1} is unsupported.`)
    const actionId = action.id === undefined ? `action_${index + 1}` : action.id
    if (typeof actionId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(actionId) || actionIds.has(actionId)) throw new Error(`Workflow action ${index + 1} needs a unique stable action ID.`)
    actionIds.add(actionId)
    if (action.action === 'navigate') {
      let target
      try { target = new URL(action.url) } catch { throw new Error(`Workflow action ${index + 1} has an invalid navigation URL.`) }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || origins && !origins.has(target.origin)) throw new Error(`Workflow action ${index + 1} is outside registered navigation scope.`)
      const safe = { action: 'navigate', url: target.origin + target.pathname }
      safe.id = actionId
      if (typeof action.name === 'string' && action.name.length <= 120) safe.name = action.name
      return copyCaptureMetadata(safe, action, origins, index)
    }
    if (action.action === 'assert_url') {
      if (!['equals', 'contains'].includes(action.operator) || typeof action.expected !== 'string' || !action.expected.trim() || action.expected.length > 500 || /[\r\n?#]/.test(action.expected) || /^https?:\/\//i.test(action.expected)) throw new Error(`Workflow action ${index + 1} needs a safe URL path assertion.`)
      const safe = { action: 'assert_url', operator: action.operator, expected: action.expected }
      safe.id = actionId
      if (typeof action.name === 'string' && action.name.trim() && action.name.length <= 120) safe.name = action.name.trim()
      return copyCaptureMetadata(safe, action, origins, index)
    }
    if (!action.locator || !Array.isArray(action.locatorCandidates) || action.locatorCandidates.length === 0 || action.locatorCandidates.length > 8) throw new Error(`Workflow action ${index + 1} needs validated locator candidates.`)
    const candidates = action.locatorCandidates.map((candidate) => {
      if (!candidate || !LOCATOR_KINDS.has(candidate.kind)) throw new Error(`Workflow action ${index + 1} has an unsupported locator candidate.`)
      if (candidate.kind === 'role' && !SAFE_ROLES.has(candidate.role)) throw new Error(`Workflow action ${index + 1} has an unsupported ARIA role.`)
      const value = candidate.kind === 'role' ? candidate.name : candidate.value
      if (typeof value !== 'string' || !value.trim() || value.length > (['css', 'xpath'].includes(candidate.kind) ? 500 : 160) || /[\r\n]/.test(value)) throw new Error(`Workflow action ${index + 1} has an invalid locator candidate.`)
      return candidate.kind === 'role' ? { kind: 'role', role: candidate.role, name: value } : { kind: candidate.kind, value }
    })
    if (!candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action.locator))) throw new Error(`Workflow action ${index + 1} primary locator must be one of its validated candidates.`)
    if (['fill', 'select', 'assert_value'].includes(action.action) && !variableKeys.has(action.variableKey)) throw new Error(`Workflow action ${index + 1} references an unknown variable.`)
    if (action.action === 'select' && action.optionLabel !== undefined) throw new Error(`Workflow action ${index + 1} cannot specify both a variable and a fixed option label in the builder.`)
    if (action.action === 'wait_visible' && (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 100 || action.timeoutMs > 60000)) throw new Error(`Workflow action ${index + 1} wait timeout must be 100 to 60,000 ms.`)
    if (action.action === 'assert_text' && (typeof action.expected !== 'string' || !action.expected.trim() || action.expected.length > 300 || /[\r\n]/.test(action.expected))) throw new Error(`Workflow action ${index + 1} needs expected text on one line.`)
    if (action.credentialInput === true && (action.action !== 'fill' || action.variableKey !== 'password')) throw new Error(`Workflow action ${index + 1} has invalid credential-input metadata.`)
    if (action.credentialInput === true && !input.variables.some((variable) => variable.key === 'password' && variable.credential === true)) throw new Error(`Workflow action ${index + 1} references a password variable that was not explicitly reviewed.`)
    if (action.manualLoginSubmit === true && action.action !== 'click') throw new Error(`Workflow action ${index + 1} has invalid manual-login metadata.`)
    if (action.action === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(action.key)) throw new Error(`Workflow action ${index + 1} uses an unsupported key.`)
    const safe = { action: action.action, locator: candidates.find((candidate) => JSON.stringify(candidate) === JSON.stringify(action.locator)), locatorCandidates: candidates }
    safe.id = actionId
    if (typeof action.name === 'string' && action.name.trim() && action.name.length <= 120) safe.name = action.name.trim()
    if (action.variableKey) safe.variableKey = action.variableKey
    if (action.timeoutMs !== undefined && action.action === 'wait_visible') safe.timeoutMs = action.timeoutMs
    if (action.expected !== undefined && action.action === 'assert_text') safe.expected = action.expected
    if (action.credentialInput === true) safe.credentialInput = true
    if (action.contextualTarget !== undefined) safe.contextualTarget = validateContextualTarget(action.contextualTarget, index, variableKeys)
    if (action.manualLoginSubmit === true) safe.manualLoginSubmit = true
    if (action.key) safe.key = action.key
    if (action.requiresApproval === true) safe.requiresApproval = true
    if (action.requiresWriteApproval === true) safe.requiresWriteApproval = true
    copyCaptureMetadata(safe, action, origins, index)
    if (['create', 'update', 'delete'].includes(action.action)) {
      const auth = action.writeAuthorization
      if (!auth || auth.captured !== true || auth.operation !== action.action || auth.method !== 'POST' || typeof auth.path !== 'string' || !auth.path.startsWith('/') || /[?#]/.test(auth.path) || !origins?.has(auth.origin)) throw new Error(`Workflow action ${index + 1} has no approved registered-origin form scope.`)
      safe.writeAuthorization = { captured: true, operation: auth.operation, method: auth.method, origin: auth.origin, path: auth.path }
    }
    if (action.postbackAuthorization !== undefined) {
      const auth = action.postbackAuthorization
      if (action.action !== 'click' || auth.captured !== true || auth.method !== 'POST' || typeof auth.path !== 'string' || !auth.path.startsWith('/') || /[?#]/.test(auth.path) || !origins?.has(auth.origin)) throw new Error(`Workflow action ${index + 1} has no approved registered-origin postback scope.`)
      safe.postbackAuthorization = { captured: true, method: 'POST', origin: auth.origin, path: auth.path }
    }
    return safe
  })
  if (input.variables.some((variable) => variable.credential === true) && (!actions.some((action) => action.credentialInput === true) || !actions.some((action) => action.manualLoginSubmit === true))) throw new Error('A password CSV field requires a captured password fill and manual login submit action.')
  return { applicationId: input.applicationId, name: input.name.trim(), actions, variables: input.variables.map((item) => ({ key: item.key, label: item.label.trim(), required: item.required !== false, variable: item.variable !== false, ...(item.type ? { type: item.type } : {}), ...(item.defaultValue !== undefined ? { defaultValue: item.defaultValue } : {}), ...(item.pattern ? { pattern: item.pattern } : {}), ...(item.credential === true ? { credential: true, sensitive: item.sensitive === true } : {}) })), assertions: Array.isArray(input.assertions) ? input.assertions : [], version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1 }
}

export function validateWorkflowLocatorCandidate(candidate) {
  try { validateWorkflowDefinition({ applicationId: 'validation', name: 'Validation', variables: [], actions: [{ action: 'click', locator: candidate, locatorCandidates: [candidate] }] }); return true } catch { return false }
}

export function workflowStepsMatch(candidate, savedSteps) {
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
  return normalize(candidate) === normalize(savedSteps)
}

export function applyReviewedWorkflowLocators(plan, workflow, testData = {}) {
  if (!plan || !Array.isArray(plan.actions) || !workflow || !Array.isArray(workflow.action_plan)) throw new Error('The selected saved workflow definition is invalid.')
  const needsValue = (action) => ['fill', 'select', 'assert_value'].includes(action.action) && action.optionLabel === undefined
  const hasValue = (action) => String(testData[action.variableKey || action.dataKey] ?? '').trim().length > 0
  const reviewedActions = workflow.action_plan.filter((action) => !needsValue(action) || hasValue(action))
  plan.actions = plan.actions.filter((action) => !needsValue(action) || hasValue(action))
  if (plan.actions.length < reviewedActions.length) throw new Error('The imported steps must include the selected workflow actions for the CSV fields provided.')
  const trailingActions = plan.actions.slice(reviewedActions.length)
  if (trailingActions.some((action) => !action.action.startsWith('assert_'))) throw new Error('The imported steps contain an interactive action outside the selected workflow version.')
  for (let index = 0; index < reviewedActions.length; index += 1) {
    const reviewed = reviewedActions[index]
    const compiled = plan.actions[index]
    if (!compiled || compiled.action !== reviewed.action) throw new Error(`CSV step ${index + 1} no longer matches the selected workflow action.`)
    if (reviewed.action === 'navigate') {
      const parsed = new URL(compiled.url)
      if (parsed.origin + parsed.pathname !== reviewed.url) throw new Error(`CSV navigation step ${index + 1} differs from the selected workflow.`)
    } else if (reviewed.action === 'assert_url') {
      if (compiled.operator !== reviewed.operator || compiled.expected !== reviewed.expected) throw new Error(`CSV URL assertion ${index + 1} differs from the selected workflow.`)
    } else {
      const variableKey = reviewed.variableKey || reviewed.dataKey
      if (['fill', 'select', 'assert_value'].includes(reviewed.action) && compiled.dataKey !== variableKey) throw new Error(`CSV step ${index + 1} uses a different workflow field than the selected version.`)
      if (reviewed.action === 'select' && compiled.optionLabel !== reviewed.optionLabel) throw new Error(`CSV select step ${index + 1} differs from the selected workflow.`)
      if (reviewed.action === 'assert_text' && compiled.expected !== reviewed.expected) throw new Error(`CSV text assertion ${index + 1} differs from the selected workflow.`)
      if (reviewed.action === 'wait_visible' && compiled.timeoutMs !== reviewed.timeoutMs) throw new Error(`CSV wait step ${index + 1} differs from the selected workflow.`)
      compiled.locator = reviewed.locator
      compiled.locatorCandidates = reviewed.locatorCandidates
      if (reviewed.pageUrl) compiled.pageUrl = reviewed.pageUrl
      if (reviewed.pageUrlAfter) compiled.pageUrlAfter = reviewed.pageUrlAfter
      if (reviewed.contextualTarget) compiled.contextualTarget = reviewed.contextualTarget
      if (reviewed.credentialInput === true) compiled.credentialInput = true
      if (reviewed.manualLoginSubmit === true) compiled.manualLoginSubmit = true
      if (reviewed.postbackAuthorization) compiled.postbackAuthorization = reviewed.postbackAuthorization
    }
    if (['create', 'update', 'delete'].includes(reviewed.action)) {
      compiled.requiresApproval = true
      compiled.requiresWriteApproval = true
      compiled.writeAuthorization = reviewed.writeAuthorization
    }
  }
  return plan
}
