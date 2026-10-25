const SECRET = /password|passwd|passcode|pwd|token|secret|credential|authorization|cookie|api[_ -]?key/i
const RESERVED = new Set(['test_case_id', 'name', 'preconditions', 'steps', 'test_data', 'expected_result', 'priority', 'tags'])

function makeKey(value, fallback) {
  let key = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!key) key = fallback
  if (!/^[a-z]/.test(key)) key = `field_${key}`
  return key.slice(0, 64)
}

export function detectWorkflowVariable(metadata, index, used = new Set(), { allowPasswordCredential = false } = {}) {
  const parts = [metadata?.label, metadata?.name, metadata?.id, metadata?.placeholder].filter(Boolean).map(String)
  const label = String(parts[0] || `Input ${index + 1}`).slice(0, 160)
  const secret = SECRET.test(parts.join(' ')) || ['password', 'hidden', 'file'].includes(String(metadata?.type || '').toLowerCase())
  const passwordCredential = allowPasswordCredential && String(metadata?.type || '').toLowerCase() === 'password'
  const keySource = passwordCredential ? 'password' : parts.find((part) => !SECRET.test(part)) || ''
  let key = makeKey(keySource, `input_${index + 1}`)
  if (RESERVED.has(key)) key = `field_${key}`
  const base = key
  let suffix = 2
  while (used.has(key)) key = `${base.slice(0, 58)}_${suffix++}`
  used.add(key)
  return { key, label, type: String(metadata?.type || 'text').slice(0, 40), sensitive: secret, credential: passwordCredential, variable: !secret || passwordCredential, required: true, warning: parts.length ? null : 'Field label was unavailable; review the fallback name.' }
}
