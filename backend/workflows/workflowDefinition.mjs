const ACTIONS = new Set(['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'create', 'update', 'delete', 'press', 'assert_visible', 'assert_text'])
const LOCATOR_KINDS = new Set(['role', 'label', 'placeholder', 'testid', 'text', 'id', 'name'])
const SAFE_ROLES = new Set(['button', 'link', 'heading', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'searchbox', 'switch', 'spinbutton'])
const RESERVED_VARIABLE_KEYS = new Set(['test_case_id', 'name', 'preconditions', 'steps', 'test_data', 'expected_result', 'priority', 'tags'])

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
    if (variable.sensitive === true && !(variable.credential === true && variable.key === 'password')) throw new Error('Credential and secret fields are not allowed as CSV variables except an explicitly identified password field.')
    variableKeys.add(variable.key)
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 100) throw new Error('Workflow must contain between 1 and 100 actions.')
  const origins = registeredOrigins ? new Set(registeredOrigins) : null
  const actions = input.actions.map((action, index) => {
    if (!action || !ACTIONS.has(action.action)) throw new Error(`Workflow action ${index + 1} is unsupported.`)
    if (action.action === 'navigate') {
      let target
      try { target = new URL(action.url) } catch { throw new Error(`Workflow action ${index + 1} has an invalid navigation URL.`) }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || origins && !origins.has(target.origin)) throw new Error(`Workflow action ${index + 1} is outside registered navigation scope.`)
      return copyCaptureMetadata({ action: 'navigate', url: target.origin + target.pathname }, action, origins, index)
    }
    if (!action.locator || !Array.isArray(action.locatorCandidates) || action.locatorCandidates.length === 0 || action.locatorCandidates.length > 8) throw new Error(`Workflow action ${index + 1} needs validated locator candidates.`)
    const candidates = action.locatorCandidates.map((candidate) => {
      if (!candidate || !LOCATOR_KINDS.has(candidate.kind)) throw new Error(`Workflow action ${index + 1} has an unsupported locator candidate.`)
      if (candidate.kind === 'role' && !SAFE_ROLES.has(candidate.role)) throw new Error(`Workflow action ${index + 1} has an unsupported ARIA role.`)
      const value = candidate.kind === 'role' ? candidate.name : candidate.value
      if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\r\n]/.test(value)) throw new Error(`Workflow action ${index + 1} has an invalid locator candidate.`)
      return candidate.kind === 'role' ? { kind: 'role', role: candidate.role, name: value } : { kind: candidate.kind, value }
    })
    if (!candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action.locator))) throw new Error(`Workflow action ${index + 1} primary locator must be one of its validated candidates.`)
    if (['fill', 'select'].includes(action.action) && !variableKeys.has(action.variableKey)) throw new Error(`Workflow action ${index + 1} references an unknown variable.`)
    if (action.credentialInput === true && (action.action !== 'fill' || action.variableKey !== 'password')) throw new Error(`Workflow action ${index + 1} has invalid credential-input metadata.`)
    if (action.credentialInput === true && !input.variables.some((variable) => variable.key === 'password' && variable.credential === true)) throw new Error(`Workflow action ${index + 1} references a password variable that was not explicitly reviewed.`)
    if (action.manualLoginSubmit === true && action.action !== 'click') throw new Error(`Workflow action ${index + 1} has invalid manual-login metadata.`)
    if (action.action === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(action.key)) throw new Error(`Workflow action ${index + 1} uses an unsupported key.`)
    const safe = { action: action.action, locator: action.locator, locatorCandidates: candidates }
    if (action.variableKey) safe.variableKey = action.variableKey
    if (action.credentialInput === true) safe.credentialInput = true
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
  return { applicationId: input.applicationId, name: input.name.trim(), actions, variables: input.variables.map(({ key, label, required = true, variable = true, locator, credential = false, sensitive = false }) => ({ key, label, required: required === true, variable: variable !== false, ...(locator ? { locator } : {}), ...(credential === true ? { credential: true, sensitive: sensitive === true } : {}) })), assertions: Array.isArray(input.assertions) ? input.assertions : [], version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1 }
}

export function validateWorkflowLocatorCandidate(candidate) {
  try { validateWorkflowDefinition({ applicationId: 'validation', name: 'Validation', variables: [], actions: [{ action: 'click', locator: candidate, locatorCandidates: [candidate] }] }); return true } catch { return false }
}

export function workflowStepsMatch(candidate, savedSteps) {
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
  return normalize(candidate) === normalize(savedSteps)
}

export function applyReviewedWorkflowLocators(plan, workflow) {
  if (!plan || !Array.isArray(plan.actions) || !workflow || !Array.isArray(workflow.action_plan)) throw new Error('The selected saved workflow definition is invalid.')
  if (plan.actions.length < workflow.action_plan.length) throw new Error('The imported steps do not contain every action from the selected workflow.')
  for (let index = 0; index < workflow.action_plan.length; index += 1) {
    const reviewed = workflow.action_plan[index]
    const compiled = plan.actions[index]
    if (!compiled || compiled.action !== reviewed.action) throw new Error(`CSV step ${index + 1} no longer matches the selected workflow action.`)
    if (reviewed.action !== 'navigate') {
      compiled.locator = reviewed.locator
      compiled.locatorCandidates = reviewed.locatorCandidates
      if (reviewed.pageUrl) compiled.pageUrl = reviewed.pageUrl
      if (reviewed.pageUrlAfter) compiled.pageUrlAfter = reviewed.pageUrlAfter
      if (reviewed.credentialInput === true) compiled.credentialInput = true
      if (reviewed.manualLoginSubmit === true) compiled.manualLoginSubmit = true
      if (reviewed.postbackAuthorization) compiled.postbackAuthorization = reviewed.postbackAuthorization
    } else {
      const parsed = new URL(compiled.url)
      if (parsed.origin + parsed.pathname !== reviewed.url) throw new Error(`CSV navigation step ${index + 1} differs from the selected workflow.`)
    }
    if (['create', 'update', 'delete'].includes(reviewed.action)) {
      compiled.requiresApproval = true
      compiled.requiresWriteApproval = true
      compiled.writeAuthorization = reviewed.writeAuthorization
    }
  }
  return plan
}
