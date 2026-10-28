function toLocator(page, candidate) {
  if (candidate.kind === 'role') return page.getByRole(candidate.role, { name: candidate.name, exact: true })
  if (candidate.kind === 'label') return page.getByLabel(candidate.value, { exact: true })
  if (candidate.kind === 'placeholder') return page.getByPlaceholder(candidate.value, { exact: true })
  if (candidate.kind === 'text') return page.getByText(candidate.value, { exact: true })
  if (candidate.kind === 'testid') return page.getByTestId(candidate.value)
  if (candidate.kind === 'id') return page.locator(`#${candidate.value.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`)
  if (candidate.kind === 'name') return page.locator(`[name="${candidate.value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`)
  if (candidate.kind === 'css') return page.locator(candidate.value)
  if (candidate.kind === 'xpath') return page.locator(`xpath=${candidate.value}`)
  throw new Error('Unsupported workflow locator candidate.')
}

function isDetachedFrameError(error) {
  return /frame (?:was )?detached|execution context was destroyed|cannot find context with specified id/i.test(String(error?.message || error))
}

async function visibleActionNames(page) {
  const names = []
  const frames = typeof page.frames === 'function' ? page.frames() : [page]
  for (const frame of frames) {
    try {
      if (typeof frame.isDetached === 'function' && frame.isDetached()) continue
      const items = await frame.locator('button, a, [role="button"], [role="link"]').evaluateAll((elements) => elements
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        })
        .map((element) => String(element.getAttribute('aria-label') || element.innerText || element.title || '').replace(/\s+/g, ' ').trim().slice(0, 80))
        .filter(Boolean))
      names.push(...items)
    } catch (error) {
      if (!isDetachedFrameError(error)) throw error
    }
  }
  return [...new Set(names)].slice(0, 40)
}

function oracleSelectLabelAliases(candidate) {
  if (candidate?.kind !== 'text' || !/^oj\s+dyn\s+form\b/i.test(String(candidate.value || ''))) return []
  const binding = String(candidate.value).match(/actionOccurrences\.([A-Za-z]+)$/i)?.[1]?.toLowerCase()
  if (binding === 'legalentityid') return ['Legal Employer', 'Legal Entity']
  if (binding === 'actionid') return ["What's the way to hire an employee?", 'Action']
  if (binding === 'businessunitid') return ['Business Unit']
  return []
}

async function oracleSelectInteractionTarget(locator, candidate) {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase())
  if (tag === 'oj-select-single') {
    const inputs = locator.locator('input[readonly]')
    const visibleInputs = []
    for (let index = 0; index < await inputs.count(); index += 1) {
      const input = inputs.nth(index)
      if (await input.isVisible()) visibleInputs.push(input)
    }
    if (visibleInputs.length === 1) return { locator: visibleInputs[0], candidate, tag: 'input' }
  }
  return { locator, candidate, tag }
}

async function resolveOracleSelectByLabel(page, candidate) {
  const aliases = oracleSelectLabelAliases(candidate)
  if (!aliases.length) return null
  const frames = typeof page.frames === 'function' ? page.frames() : [page]
  for (const alias of aliases) {
    for (const kind of ['role', 'label']) {
      const matches = []
      for (const frame of frames) {
        const locator = kind === 'role'
          ? frame.getByRole('combobox', { name: alias, exact: true })
          : frame.getByLabel(alias, { exact: true })
        const count = await locator.count()
        if (count === 1 && await locator.isVisible()) matches.push(locator)
      }
      if (matches.length > 1) throw Object.assign(new Error(`Oracle select binding matched multiple visible controls for "${alias}".`), { code: 'LOCATOR_AMBIGUOUS', candidate, matchCount: matches.length })
      if (matches.length === 1) return oracleSelectInteractionTarget(matches[0], candidate)
    }
  }
  // Older recordings stored an Oracle binding ID as visible text. Recover the
  // corresponding custom control by comparing normalized DOM IDs, without
  // relying on that internal string being rendered as page text.
  const normalizeBinding = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = normalizeBinding(candidate.value)
  const controlsSelector = 'oj-select-single, oj-combobox-one, oj-select-many, select, [role="combobox"], input[aria-autocomplete]'
  for (const frame of frames) {
    const controls = frame.locator(controlsSelector)
    const metadata = await controls.evaluateAll((elements) => elements.map((element) => ({
      id: element.id || '',
      name: element.getAttribute('name') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      tag: element.tagName.toLowerCase(),
    })))
    const exactIds = metadata.filter((item) => normalizeBinding(item.id) === target)
    const tail = candidate.value.match(/actionOccurrences\.([A-Za-z]+)$/i)?.[1] || ''
    const tailNorm = normalizeBinding(tail)
    const matches = exactIds.length ? exactIds : metadata.filter((item) => {
      const id = normalizeBinding(item.id)
      return id.includes(target) || (target.includes(id) && id.length >= target.length * 0.75) || (tailNorm && id.includes(tailNorm) && id.includes('actionoccurrences'))
    })
    const visible = []
    for (const item of matches) {
      if (!item.id) continue
      const locator = toLocator(frame, { kind: 'id', value: item.id })
      if (await locator.count() === 1 && await locator.isVisible()) visible.push({ locator, tag: item.tag })
    }
    if (visible.length > 1) throw Object.assign(new Error('Oracle select binding matched multiple visible controls by ID.'), { code: 'LOCATOR_AMBIGUOUS', candidate, matchCount: visible.length })
    if (visible.length === 1) return oracleSelectInteractionTarget(visible[0].locator, candidate)
  }
  return null
}

async function resolveOracleEmployeeFillByLabel(page, action, candidate) {
  if (action?.action !== 'fill' || candidate?.kind !== 'label') return null
  const label = String(candidate.value || '')
  if (!['Legal Employer', 'Business Unit'].includes(label)) return null
  let employeeWizard = false
  try {
    const pathname = new URL(page.url()).pathname
    employeeWizard = /\/employment-addperson\/create\/employee\/?$/i.test(pathname)
      || /\/hcmUI\/faces\/FndOverview\/?$/i.test(pathname)
  } catch {}
  if (!employeeWizard) return null
  const frames = typeof page.frames === 'function' ? page.frames() : [page]
  for (const role of ['combobox', 'textbox']) {
    const matches = []
    for (const frame of frames) {
      const locator = frame.getByRole(role, { name: label, exact: true })
      const count = await locator.count()
      for (let index = 0; index < count; index += 1) {
        const match = locator.nth(index)
        if (await match.isVisible()) matches.push(match)
      }
    }
    if (matches.length > 1) throw Object.assign(new Error(`Oracle employee field matched multiple visible ${role} controls for "${label}".`), { code: 'LOCATOR_AMBIGUOUS', candidate, matchCount: matches.length })
    if (matches.length === 1) return { locator: matches[0], candidate, tag: await matches[0].evaluate((element) => element.tagName.toLowerCase()) }
  }
  // Oracle ADF exposes these controls as an input nested in a selectOneChoice
  // widget. Its visible label is not always associated with the input on
  // FndOverview, so use the same input signal as the successful runner.
  const selector = label === 'Legal Employer'
    ? 'input[role="combobox"][aria-label*="Legal Employer" i], input[id$="selectOneChoice3::content"]'
    : 'input[role="combobox"][aria-label*="Business Unit" i]'
  const matches = []
  for (const frame of frames) {
    const locator = frame.locator(selector)
    for (let index = 0; index < await locator.count(); index += 1) {
      const match = locator.nth(index)
      if (await match.isVisible()) matches.push(match)
    }
  }
  if (matches.length > 1) throw Object.assign(new Error(`Oracle employee field matched multiple visible inputs for "${label}".`), { code: 'LOCATOR_AMBIGUOUS', candidate, matchCount: matches.length })
  if (matches.length === 1) return { locator: matches[0], candidate, tag: await matches[0].evaluate((element) => element.tagName.toLowerCase()) }
  return null
}

export async function resolveWorkflowLocator(page, action, { expectedTag, timeoutMs = 0, pollMs = 100 } = {}) {
  const candidates = Array.isArray(action?.locatorCandidates) ? action.locatorCandidates : []
  if (!candidates.length) throw Object.assign(new Error('This workflow action has no validated locator candidates.'), { code: 'LOCATOR_NOT_FOUND' })
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  const diagnostics = new Set()
  do {
    for (const candidate of candidates) {
      // Recorded Oracle select bindings can match wrapper text before their
      // visible label alias is considered. Resolve those aliases first so the
      // action targets the actual JET input instead of a text-matched host.
      if (action?.action === 'select') {
        const oracleSelect = await resolveOracleSelectByLabel(page, candidate)
        if (oracleSelect) return oracleSelect
      }
      const oracleEmployeeField = await resolveOracleEmployeeFillByLabel(page, action, candidate)
      if (oracleEmployeeField) return oracleEmployeeField
      // Manual capture observes clicks in every frame. Replay must search those
      // same frames, while preferring a visible match over hidden responsive
      // duplicates in the top document.
      const frames = typeof page.frames === 'function' ? page.frames() : [page]
      const matches = []
      for (const frame of frames) {
        try {
          if (typeof frame.isDetached === 'function' && frame.isDetached()) continue
          const locator = toLocator(frame, candidate)
          const count = await locator.count()
          if (count > 1) throw Object.assign(new Error(`Locator is ambiguous: ${count} elements matched ${candidate.kind}.`), { code: 'LOCATOR_AMBIGUOUS', candidate, matchCount: count })
          if (count !== 1) continue
          if (typeof locator.isVisible === 'function' && !await locator.isVisible()) continue
          matches.push(locator)
        } catch (error) {
          // Oracle replaces frames during login and task navigation. A frame
          // that detaches between page.frames() and locator inspection is a
          // transient page transition; let the outer polling loop inspect the
          // newly attached frame instead of failing the workflow immediately.
          if (isDetachedFrameError(error)) continue
          throw error
        }
      }
      if (matches.length > 1) throw Object.assign(new Error(`Locator is ambiguous: ${matches.length} visible frame matches for ${candidate.kind}.`), { code: 'LOCATOR_AMBIGUOUS', candidate, matchCount: matches.length })
      if (!matches.length) {
        diagnostics.add(candidate.kind)
        continue
      }
      const locator = matches[0]
      const tag = await locator.evaluate((element) => element.tagName.toLowerCase())
      if (expectedTag && tag !== expectedTag) throw Object.assign(new Error(`Resolved element is ${tag}; expected ${expectedTag}.`), { code: 'LOCATOR_TYPE_MISMATCH', candidate })
      return { locator, candidate, tag }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
  } while (Date.now() <= deadline)
  const actionNames = await visibleActionNames(page).catch(() => [])
  const actionHint = actionNames.length ? ` Visible buttons and links: ${actionNames.join(' | ')}.` : ''
  throw Object.assign(new Error(`No locator candidate matched this action. Tried: ${[...diagnostics].join(', ')}.${actionHint}`), { code: 'LOCATOR_NOT_FOUND', candidates: [...diagnostics] })
}
