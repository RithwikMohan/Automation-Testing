import { URL } from 'node:url'
import { normalizeAllowedOrigin } from './exploration/networkSecurity.mjs'

export const ALLOWED_ENVIRONMENTS = ['Development', 'Testing', 'Staging', 'Production']
export const ALLOWED_AUTH_METHODS = ['none', 'manual', 'credential_reference', 'other']
export const ALLOWED_APP_CATEGORIES = [
  'Productivity',
  'E-commerce',
  'Finance',
  'Internal Tool',
  'CRM',
  'ERP',
  'Development',
  'HR',
  'Support',
  'Other',
]

export const ALLOWED_TASK_CATEGORIES = [
  'Navigation',
  'Form filling',
  'Data extraction',
  'Data validation',
  'Record creation',
  'Record update',
  'Search',
  'Custom task',
]

export const ALLOWED_TASK_STATUSES = ['Draft', 'Configured', 'Archived']

export function validateUrl(rawUrl, fieldName = 'URL') {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error(`${fieldName} is required and must be a valid string.`)
  }

  const trimmed = rawUrl.trim()
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`${fieldName} is malformed or invalid.`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${fieldName} must use http or https protocol. Unsupported scheme: ${parsed.protocol}`)
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${fieldName} must not contain embedded credentials (username/password).`)
  }
  for (const key of parsed.searchParams.keys()) {
    if (/^(password|passwd|pwd|token|access_token|refresh_token|session|sessionid|sid|cookie)$/i.test(key)) {
      throw new Error(`${fieldName} must not contain credential or session query parameters.`)
    }
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    throw new Error(`${fieldName} must specify a valid host.`)
  }

  // Normalize: lower-case protocol and host, preserve pathname & search, remove trailing slash if root
  let normalized = parsed.origin + parsed.pathname.replace(/\/+$/, '')
  if (parsed.pathname === '/' || !parsed.pathname) normalized = parsed.origin
  if (parsed.search) normalized += parsed.search
  if (parsed.hash) normalized += parsed.hash

  return {
    raw: trimmed,
    normalizedUrl: normalized,
    origin: parsed.origin,
    hostname: parsed.hostname,
    protocol: parsed.protocol,
  }
}

export function validateApplicationPayload(payload, isUpdate = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Application payload must be an object.')
  }

  const validated = {}

  for (const field of ['approvedResourceOrigins', 'approvedNavigationOrigins']) {
    const value = payload[field] ?? (isUpdate ? undefined : [])
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length > 100) throw new Error(`${field} must be an array of at most 100 approved origins.`)
    const normalized = [...new Set(value.map((origin) => normalizeAllowedOrigin(origin)))]
    validated[field] = normalized
  }

  // Name
  if (!isUpdate || payload.name !== undefined) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) {
      throw new Error('Application name is required.')
    }
    const trimmed = payload.name.trim()
    if (trimmed.length > 100) {
      throw new Error('Application name cannot exceed 100 characters.')
    }
    validated.name = trimmed
  }

  // Base URL
  if (!isUpdate || payload.baseUrl !== undefined) {
    const { normalizedUrl } = validateUrl(payload.baseUrl, 'Base URL')
    validated.baseUrl = normalizedUrl
  }

  // Environment
  if (!isUpdate || payload.environment !== undefined) {
    if (!ALLOWED_ENVIRONMENTS.includes(payload.environment)) {
      throw new Error(`Environment must be one of: ${ALLOWED_ENVIRONMENTS.join(', ')}.`)
    }
    validated.environment = payload.environment
  }

  // Auth Method
  if (!isUpdate || payload.authMethod !== undefined) {
    if (!ALLOWED_AUTH_METHODS.includes(payload.authMethod)) {
      throw new Error(`Authentication method must be one of: ${ALLOWED_AUTH_METHODS.join(', ')}.`)
    }
    validated.authMethod = payload.authMethod
  }

  // Credential Reference
  if (payload.credentialRef !== undefined) {
    if (payload.credentialRef === null || payload.credentialRef === '') {
      validated.credentialRef = null
    } else if (typeof payload.credentialRef === 'string') {
      const trimmed = payload.credentialRef.trim()
      if (trimmed.length > 100) throw new Error('Credential reference cannot exceed 100 characters.')
      if (/(?:password|passwd|pwd|token|secret|cookie)\s*[:=]|^bearer\s+/i.test(trimmed) || /^[\w-]+\.[\w-]+\.[\w-]+$/.test(trimmed)) {
        throw new Error('Credential reference must identify a secret in a vault; do not enter secret values.')
      }
      validated.credentialRef = trimmed || null
    } else {
      throw new Error('Credential reference must be a string or null.')
    }
  } else if (!isUpdate) {
    validated.credentialRef = null
  }

  // Description
  if (payload.description !== undefined) {
    if (payload.description !== null && typeof payload.description !== 'string') throw new Error('Description must be a string or null.')
    if ((payload.description || '').length > 500) throw new Error('Description cannot exceed 500 characters.')
    validated.description = payload.description?.trim() || null
  } else if (!isUpdate) {
    validated.description = null
  }

  // Category
  if (payload.category !== undefined) {
    if (payload.category !== null && typeof payload.category !== 'string') throw new Error('Category must be a string or null.')
    if (payload.category && !ALLOWED_APP_CATEGORIES.includes(payload.category)) {
      throw new Error(`Category must be one of: ${ALLOWED_APP_CATEGORIES.join(', ')}.`)
    }
    validated.category = payload.category || null
  } else if (!isUpdate) {
    validated.category = null
  }

  // Login URL
  if (payload.loginUrl !== undefined && payload.loginUrl) {
    const { normalizedUrl } = validateUrl(payload.loginUrl, 'Login URL')
    validated.loginUrl = normalizedUrl
  } else if (payload.loginUrl === null || payload.loginUrl === '') {
    validated.loginUrl = null
  } else if (payload.loginUrl !== undefined && typeof payload.loginUrl !== 'string') {
    throw new Error('Login URL must be a string or null.')
  } else if (!isUpdate) {
    validated.loginUrl = null
  }

  // Notes
  if (payload.notes !== undefined) {
    if (payload.notes !== null && typeof payload.notes !== 'string') throw new Error('Notes must be a string or null.')
    if ((payload.notes || '').length > 1000) throw new Error('Notes cannot exceed 1,000 characters.')
    validated.notes = payload.notes?.trim() || null
  } else if (!isUpdate) {
    validated.notes = null
  }

  // Status
  if (payload.status !== undefined) {
    if (!['Active', 'Archived'].includes(payload.status)) {
      throw new Error("Status must be 'Active' or 'Archived'.")
    }
    validated.status = payload.status
  } else if (!isUpdate) {
    validated.status = 'Active'
  }

  return validated
}

export function validateAutomationDefinitionPayload(payload, isUpdate = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Task definition payload must be an object.')
  }

  const validated = {}

  // Application ID
  if (!isUpdate || payload.applicationId !== undefined) {
    if (typeof payload.applicationId !== 'string' || !payload.applicationId.trim()) {
      throw new Error('Target application ID is required.')
    }
    validated.applicationId = payload.applicationId.trim()
  }

  // Name
  if (!isUpdate || payload.name !== undefined) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) {
      throw new Error('Automation name is required.')
    }
    const trimmed = payload.name.trim()
    if (trimmed.length > 150) {
      throw new Error('Automation name cannot exceed 150 characters.')
    }
    validated.name = trimmed
  }

  // Description
  if (payload.description !== undefined) {
    if (payload.description !== null && typeof payload.description !== 'string') throw new Error('Description must be a string or null.')
    if ((payload.description || '').length > 500) throw new Error('Description cannot exceed 500 characters.')
    validated.description = payload.description?.trim() || null
  } else if (!isUpdate) {
    validated.description = null
  }

  // Task Category
  if (!isUpdate || payload.taskCategory !== undefined) {
    if (!ALLOWED_TASK_CATEGORIES.includes(payload.taskCategory)) {
      throw new Error(`Task category must be one of: ${ALLOWED_TASK_CATEGORIES.join(', ')}.`)
    }
    validated.taskCategory = payload.taskCategory
  }

  // Task Instruction
  if (!isUpdate || payload.taskInstruction !== undefined) {
    if (typeof payload.taskInstruction !== 'string' || !payload.taskInstruction.trim()) {
      throw new Error('Task instruction is required.')
    }
    const trimmed = payload.taskInstruction.trim()
    if (trimmed.length > 5000) {
      throw new Error('Task instruction cannot exceed 5,000 characters.')
    }
    validated.taskInstruction = trimmed
  }

  // Preconditions (array of strings or items with text)
  if (payload.preconditions !== undefined) {
    if (!Array.isArray(payload.preconditions) || payload.preconditions.length > 20) {
      throw new Error('Preconditions must be an array with no more than 20 items.')
    }
    validated.preconditions = payload.preconditions
      .map((item, index) => {
        if (typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.text !== 'string')) throw new Error('Each precondition must be a string or an object with text.')
        if (typeof item === 'object' && item.id !== undefined && typeof item.id !== 'string') throw new Error('Precondition IDs must be strings.')
        if (typeof item === 'object' && item.id?.length > 80) throw new Error('Precondition IDs cannot exceed 80 characters.')
        const text = (typeof item === 'string' ? item : item.text).trim()
        if (text.length > 300) throw new Error('Preconditions cannot exceed 300 characters each.')
        return text ? { id: typeof item === 'object' && item.id ? item.id : `pre-${index + 1}`, text } : null
      })
      .filter(Boolean)
  } else if (!isUpdate) {
    validated.preconditions = []
  }

  // Expected Results (array of strings or items with text)
  if (payload.expectedResults !== undefined) {
    if (!Array.isArray(payload.expectedResults) || payload.expectedResults.length > 20) {
      throw new Error('Expected results must be an array with no more than 20 items.')
    }
    validated.expectedResults = payload.expectedResults
      .map((item, index) => {
        if (typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.text !== 'string')) throw new Error('Each expected result must be a string or an object with text.')
        if (typeof item === 'object' && item.id !== undefined && typeof item.id !== 'string') throw new Error('Expected-result IDs must be strings.')
        if (typeof item === 'object' && item.id?.length > 80) throw new Error('Expected-result IDs cannot exceed 80 characters.')
        const text = (typeof item === 'string' ? item : item.text).trim()
        if (text.length > 300) throw new Error('Expected results cannot exceed 300 characters each.')
        return text ? { id: typeof item === 'object' && item.id ? item.id : `res-${index + 1}`, text } : null
      })
      .filter(Boolean)
  } else if (!isUpdate) {
    validated.expectedResults = []
  }

  // Safety Settings
  if (payload.safetySettings !== undefined) {
    if (typeof payload.safetySettings !== 'object' || payload.safetySettings === null || Array.isArray(payload.safetySettings)) {
      throw new Error('Safety settings must be an object.')
    }
    const rawMaxActions = payload.safetySettings.max_actions ?? payload.safetySettings.maxActions ?? 25
    if (typeof rawMaxActions !== 'number') throw new Error('Maximum action count must be an integer between 1 and 100.')
    const maxActions = rawMaxActions
    if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) {
      throw new Error('Maximum action count must be an integer between 1 and 100.')
    }
    for (const [snake, camel] of [['read_only_preferred', 'readOnlyPreferred'], ['require_approval', 'requireApproval'], ['stop_on_ambiguity', 'stopOnAmbiguity']]) {
      const value = payload.safetySettings[snake] ?? payload.safetySettings[camel]
      if (value !== undefined && typeof value !== 'boolean') throw new Error(`Safety setting ${snake} must be a boolean.`)
    }
    if (payload.safetySettings.allowed_domain !== undefined && typeof payload.safetySettings.allowed_domain !== 'string') throw new Error('Allowed domain must be a string.')
    validated.safetySettings = {
      read_only_preferred: payload.safetySettings.read_only_preferred !== false && payload.safetySettings.readOnlyPreferred !== false,
      require_approval: payload.safetySettings.require_approval !== false && payload.safetySettings.requireApproval !== false,
      stop_on_ambiguity: payload.safetySettings.stop_on_ambiguity !== false && payload.safetySettings.stopOnAmbiguity !== false,
      max_actions: maxActions,
      allowed_domain: typeof payload.safetySettings.allowed_domain === 'string' ? payload.safetySettings.allowed_domain.trim() : undefined,
    }
  } else if (!isUpdate) {
    validated.safetySettings = {
      read_only_preferred: true,
      require_approval: true,
      stop_on_ambiguity: true,
      max_actions: 25,
    }
  }

  // Status
  if (payload.status !== undefined) {
    if (!ALLOWED_TASK_STATUSES.includes(payload.status)) {
      throw new Error(`Status must be one of: ${ALLOWED_TASK_STATUSES.join(', ')}.`)
    }
    validated.status = payload.status
  } else if (!isUpdate) {
    validated.status = 'Draft'
  }

  return validated
}
