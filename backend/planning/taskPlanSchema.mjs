export const TASK_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'actions'],
  properties: {
    purpose: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { const: 'navigate_registered_app' } } },
          { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { const: 'inspect_page' } } },
          { type: 'object', additionalProperties: false, required: ['action', 'description'], properties: { action: { const: 'find_visible_element' }, description: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['action', 'description'], properties: { action: { const: 'extract_text' }, description: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['action', 'description'], properties: { action: { const: 'verify_element' }, description: { type: 'string' } } },
        ],
      },
    },
  },
}

const SAFE_ACTIONS = new Set([
  'navigate_registered_app',
  'inspect_page',
  'find_visible_element',
  'extract_text',
  'verify_element',
])
const descriptionActions = new Set(['find_visible_element', 'extract_text', 'verify_element'])
const explicitUrl = /(?:https?:\/\/|\bwww\.)\S+|\b[a-z0-9-]+\.(?:[a-z]{2,})\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/i
const explicitSelectorOrCode = /(?:^|\s)(?:#[\w-]+|\.[A-Za-z_][\w-]*|\[[^\]]+\]|\/\/[A-Za-z]|document\s*\.|javascript\s*:|css\s*=|xpath\s*=|text\s*=|:has-text|:visible|querySelector|\.locator\s*\(|getByRole)/i

export function validateTaskPlanOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The planning provider returned an invalid plan object.')
  }
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'actions,purpose') {
    throw new Error('The planning provider returned fields outside the supported plan schema.')
  }
  if (typeof value.purpose !== 'string' || !value.purpose.trim() || value.purpose.length > 300) {
    throw new Error('The plan purpose must be a non-empty string of at most 300 characters.')
  }
  if (explicitUrl.test(value.purpose)) {
    throw new Error('Plans cannot include arbitrary URLs; navigation is limited to the selected registered application.')
  }
  if (explicitSelectorOrCode.test(value.purpose)) {
    throw new Error('Plans cannot include selectors or executable code; describe visible content in plain language.')
  }
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 12) {
    throw new Error('A plan must contain between 1 and 12 supported read-only actions.')
  }

  const actions = value.actions.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.action !== 'string' || !SAFE_ACTIONS.has(item.action)) {
      throw new Error('The plan contains an unsupported action. Only read-only inspection actions are allowed.')
    }
    const requiresDescription = descriptionActions.has(item.action)
    const expectedKeys = requiresDescription ? ['action', 'description'] : ['action']
    if (Object.keys(item).sort().join(',') !== expectedKeys.sort().join(',')) {
      throw new Error('An action contains unsupported fields. URLs, selectors, code, and extra parameters are not allowed.')
    }
    if (requiresDescription) {
      if (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 200) {
        throw new Error('Each inspection description must be a non-empty string of at most 200 characters.')
      }
      if (explicitUrl.test(item.description)) {
        throw new Error('Plans cannot include arbitrary URLs; navigation is limited to the selected registered application.')
      }
      if (explicitSelectorOrCode.test(item.description)) {
        throw new Error('Plans cannot include selectors or executable code; describe visible content in plain language.')
      }
      return { action: item.action, description: item.description.trim() }
    }
    return { action: item.action }
  })

  return { purpose: value.purpose.trim(), actions }
}
