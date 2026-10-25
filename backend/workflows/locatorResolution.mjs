function toLocator(page, candidate) {
  if (candidate.kind === 'role') return page.getByRole(candidate.role, { name: candidate.name, exact: true })
  if (candidate.kind === 'label') return page.getByLabel(candidate.value, { exact: true })
  if (candidate.kind === 'placeholder') return page.getByPlaceholder(candidate.value, { exact: true })
  if (candidate.kind === 'text') return page.getByText(candidate.value, { exact: true })
  if (candidate.kind === 'testid') return page.getByTestId(candidate.value)
  if (candidate.kind === 'id') return page.locator(`#${candidate.value.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`)
  if (candidate.kind === 'name') return page.locator(`[name="${candidate.value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`)
  throw new Error('Unsupported workflow locator candidate.')
}

export async function resolveWorkflowLocator(page, action, { expectedTag, timeoutMs = 0, pollMs = 100 } = {}) {
  const candidates = Array.isArray(action?.locatorCandidates) ? action.locatorCandidates : []
  if (!candidates.length) throw Object.assign(new Error('This workflow action has no validated locator candidates.'), { code: 'LOCATOR_NOT_FOUND' })
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  const diagnostics = new Set()
  do {
    for (const candidate of candidates) {
      const locator = toLocator(page, candidate)
      const count = await locator.count()
      if (count > 1) throw Object.assign(new Error(`Locator is ambiguous: ${count} elements matched ${candidate.kind}.`), { code: 'LOCATOR_AMBIGUOUS', candidate, matchCount: count })
      if (count !== 1) { diagnostics.add(candidate.kind); continue }
      const tag = await locator.evaluate((element) => element.tagName.toLowerCase())
      if (expectedTag && tag !== expectedTag) throw Object.assign(new Error(`Resolved element is ${tag}; expected ${expectedTag}.`), { code: 'LOCATOR_TYPE_MISMATCH', candidate })
      return { locator, candidate, tag }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
  } while (Date.now() <= deadline)
  throw Object.assign(new Error(`No locator candidate matched this action. Tried: ${[...diagnostics].join(', ')}.`), { code: 'LOCATOR_NOT_FOUND', candidates: [...diagnostics] })
}
