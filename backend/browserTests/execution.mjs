import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import { validateActionPlan } from './actionRegistry.mjs'
import { resolveWorkflowLocator } from '../workflows/locatorResolution.mjs'
import { resolveContextualCell } from '../workflows/contextualTarget.mjs'
import { chromium } from 'playwright'
import { createSecurityProxy, isApprovedWritePostAllowed, isApprovedWorkflowPostbackAllowed, isManualLoginPostAllowed, isOracleHcmReadPostAllowed, normalizeAllowedOrigin, oracleHcmActionOperation } from '../exploration/networkSecurity.mjs'
import {
  getBrowserTestCaseById,
  persistBrowserTestArtifact,
  persistBrowserTestStepResult,
  updateBrowserTestExecution,
} from '../database.mjs'

const resumeControls = new Map()
const cancellationControls = new Map()
// Authenticated state is held only in worker memory, never in PostgreSQL or logs.
// The user must explicitly opt in before a later execution can reuse it.
const approvedSessionStates = new Map()
const MAX_EXECUTION_MS = 120_000
const AUTH_STATE_TTL_MS = 15 * 60_000
const CSV_FIELD_SETTLE_MS = 5000

export function rememberApprovedBrowserSession(applicationId, state) {
  if (typeof applicationId !== 'string' || !state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) return false
  for (const [key, entry] of approvedSessionStates) if (entry.expiresAt <= Date.now()) approvedSessionStates.delete(key)
  approvedSessionStates.set(applicationId, { state, expiresAt: Date.now() + AUTH_STATE_TTL_MS })
  return true
}

export class BrowserTestError extends Error {
  constructor(code, message, status = 'FAILED') {
    super(message)
    this.name = 'BrowserTestError'
    this.code = code
    this.status = status
  }
}

function safeText(value, testData = {}) {
  let result = String(value ?? '').slice(0, 2000)
  for (const item of Object.values(testData)) {
    if (typeof item === 'string' && item.length > 0) result = result.split(item).join('[redacted]')
  }
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted-token]')
    .replace(/\b(?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;&]+/gi, '[redacted-sensitive-value]')
    .replace(/([?&](?:password|passwd|pwd|token|access_token|refresh_token|session|sessionid|sid|cookie)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"']+/gi, (raw) => {
      try { const url = new URL(raw); return url.origin + url.pathname.replace(/\/(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{40,})(?=\/|$)/g, '/[redacted]') } catch { return '[redacted-url]' }
    })
}

function buildLocator(page, spec) {
  if (spec.kind === 'role') return page.getByRole(spec.role, { name: spec.name, exact: true })
  if (spec.kind === 'text') return page.getByText(spec.value, { exact: true })
  if (spec.kind === 'label') return page.getByLabel(spec.value, { exact: true })
  if (spec.kind === 'placeholder') return page.getByPlaceholder(spec.value, { exact: true })
  if (spec.kind === 'testid') return page.getByTestId(spec.value)
  if (spec.kind === 'css') return page.locator(spec.value)
  if (spec.kind === 'xpath') return page.locator(`xpath=${spec.value}`)
  if (spec.kind === 'id') return page.locator(`#${String(spec.value).replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`)
  if (spec.kind === 'name') return page.locator(`[name="${String(spec.value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`)
  throw new BrowserTestError('UNSUPPORTED_LOCATOR', 'The saved plan contains an unsupported locator.', 'BLOCKED')
}

async function uniqueLocator(page, spec) {
  const locator = buildLocator(page, spec)
  const count = await locator.count()
  if (count !== 1) throw new BrowserTestError(count === 0 ? 'LOCATOR_NOT_FOUND' : 'AMBIGUOUS_LOCATOR', count === 0 ? 'The locator did not match a visible element.' : 'The locator matched more than one element.')
  return locator
}

async function retryLocatorResolutionDuringNavigation(page, resolve, timeoutMs) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 100)
  let attempt = 0
  while (true) {
    try { return await resolve() }
    catch (error) {
      const transientNavigation = /execution context was destroyed|most likely because of a navigation|frame was detached|cannot find context with specified id/i.test(String(error?.message || error))
      if (!transientNavigation || attempt >= 2 || Date.now() >= deadline || page.isClosed()) throw error
      attempt += 1
      const remaining = Math.max(100, deadline - Date.now())
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(remaining, 3000) }).catch(() => {})
      await page.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now()))).catch(() => {})
    }
  }
}

async function uniqueActionLocator(page, action, timeoutMs = 0, testData = {}) {
  if (action.contextualTarget) {
    try { return (await retryLocatorResolutionDuringNavigation(page, () => resolveContextualCell(page, action.contextualTarget, testData), timeoutMs)).locator }
    catch (error) { throw new BrowserTestError(error.code || 'CONTEXT_TARGET_NOT_FOUND', error.message || 'The configured contextual target could not be resolved.') }
  }
  if (Array.isArray(action.locatorCandidates) && action.locatorCandidates.length) {
    try { return (await retryLocatorResolutionDuringNavigation(page, () => resolveWorkflowLocator(page, action, { timeoutMs }), timeoutMs)).locator }
    catch (error) {
      const currentPage = safePageUrl(page)
      const capturedPage = action.pageUrl ? safePageUrl({ url: () => action.pageUrl }) : ''
      const pageContext = capturedPage && currentPage
        ? capturedPage === currentPage ? ` Captured page: ${capturedPage}.` : ` Captured page: ${capturedPage}; current page: ${currentPage}.`
        : currentPage ? ` Current page: ${currentPage}.` : ''
      throw new BrowserTestError(error.code || 'LOCATOR_NOT_FOUND', (error.message || 'No captured locator matched the target element.') + pageContext)
    }
  }
  return uniqueLocator(page, action.locator)
}

async function clickOracleSelectOption(page, value, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const normalizedValue = String(value).replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const escapedValue = String(value).trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const optionName = new RegExp(`^\\s*${escapedValue}\\s*$`, 'i')
  const rowOptionName = new RegExp(escapedValue, 'i')
  while (Date.now() <= deadline) {
    const matches = []
    const frames = typeof page.frames === 'function' ? page.frames() : [page]
    for (const frame of frames) {
      try {
        const candidates = [
          { locator: frame.getByRole('option', { name: optionName }), exact: true },
          { locator: frame.getByText(optionName), exact: true },
          // Oracle JET lookup tables include other cells (for example, the
          // legislation code) in the row's text, so match the requested name
          // within the row rather than requiring the whole row to equal it.
          { locator: frame.getByRole('row').filter({ hasText: rowOptionName }), exact: false },
          // Oracle JET table popups often render a selectable row without ARIA
          // option/row roles. Match the visible cell text, then click its row.
          { locator: frame.getByText(String(value), { exact: true }), exact: true },
        ]
        for (const { locator: candidate, exact } of candidates) {
          const count = await candidate.count()
          const visible = []
          for (let index = 0; index < count; index += 1) {
            const match = candidate.nth(index)
            if (!await match.isVisible()) continue
            const text = await match.innerText().catch(() => '')
            const normalizedText = String(text).replace(/\s+/g, ' ').trim().toLocaleLowerCase()
            if (exact ? normalizedText === normalizedValue : normalizedText.includes(normalizedValue)) visible.push(match)
          }
          if (visible.length === 1) {
            const row = visible[0].locator('xpath=ancestor-or-self::*[self::tr or @role="row" or contains(@class,"oj-table")][1]')
            if (await row.count() === 1 && await row.isVisible()) matches.push(row)
            else matches.push(visible[0])
            break
          }
          if (visible.length > 1 && candidate === candidates[0].locator) throw new BrowserTestError('AMBIGUOUS_LOCATOR', `More than one Oracle option matched "${value}".`)
        }
      } catch (error) {
        if (!/frame was detached|execution context was destroyed|cannot find context/i.test(String(error?.message || error))) throw error
      }
    }
    if (matches.length > 1) throw new BrowserTestError('AMBIGUOUS_LOCATOR', `More than one Oracle option matched "${value}".`)
    if (matches.length === 1) {
      try {
        await matches[0].click({ timeout: Math.max(500, Math.min(timeoutMs, deadline - Date.now())) })
      } catch (error) {
        if (!/frame was detached|execution context was destroyed|cannot find context/i.test(String(error?.message || error))) throw error
        // Oracle may rerender the ADF frame as the selected suggestion commits.
        // The caller re-resolves the field and verifies the committed value.
      }
      return
    }
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())))
  }
  throw new BrowserTestError('OPTION_NOT_FOUND', `Oracle did not show an exact suggestion named "${value}" after the CSV value was typed.`)
}

async function selectWorkflowOption(page, locator, value, timeoutMs) {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase())
  if (tag === 'select') {
    try { return await locator.selectOption({ label: value }, { timeout: Math.min(timeoutMs, 3000) }) }
    catch { return locator.selectOption(value, { timeout: timeoutMs }) }
  }
  const searchInput = tag === 'input' ? locator : locator.locator('input').first()
  const inputCount = await searchInput.count().catch(() => 0)
  const readOnly = inputCount ? await searchInput.getAttribute('readonly').catch(() => null) : null
  const arrowSelector = '.oj-searchselect-arrow, .oj-searchselect-open-icon, .oj-select-arrow, [class*="searchselect-arrow"], [class*="select-arrow"], [id$="::drop"], [id$="::lov-btn"], [id$="::glyph"], .af_selectOneChoice_drop-icon, .af_inputComboboxListOfValues_lov-icon, a[title*="Search"], a[title*="Select"]'
  const isExpanded = async () => await searchInput.getAttribute('aria-expanded').catch(() => null) === 'true'
    || await locator.getAttribute('aria-expanded').catch(() => null) === 'true'
  const openDropdown = async () => {
    if (await isExpanded()) return
    const locatorId = await locator.getAttribute('id').catch(() => null)
    if (locatorId && /::content$/.test(locatorId)) {
      const dropId = locatorId.replace(/::content$/, '::drop')
      const lovId = locatorId.replace(/::content$/, '::lov-btn')
      const specificArrow = locator.page().locator(`[id="${dropId}"], [id="${lovId}"]`)
      if (await specificArrow.count().catch(() => 0)) {
        const arrow = specificArrow.first()
        if (await arrow.isVisible().catch(() => false)) {
          await arrow.click({ timeout: timeoutMs })
          return
        }
      }
    }
    let scope = locator
    for (let level = 0; level < 4; level += 1) {
      const arrows = scope.locator(arrowSelector)
      const visibleArrows = []
      for (let index = 0; index < await arrows.count().catch(() => 0); index += 1) {
        const arrow = arrows.nth(index)
        if (await arrow.isVisible().catch(() => false)) visibleArrows.push(arrow)
      }
      if (visibleArrows.length > 1) throw new BrowserTestError('AMBIGUOUS_LOCATOR', 'Oracle’s Legal Employer control has multiple visible dropdown arrows.')
      if (visibleArrows.length === 1) {
        await visibleArrows[0].click({ timeout: timeoutMs })
        return
      }
      if (level <= 1) {
        const buttons = scope.getByRole('button')
        const visibleButtons = []
        for (let index = 0; index < await buttons.count().catch(() => 0); index += 1) {
          const button = buttons.nth(index)
          if (await button.isVisible().catch(() => false)) visibleButtons.push(button)
        }
        if (visibleButtons.length > 1) throw new BrowserTestError('AMBIGUOUS_LOCATOR', 'Oracle’s Legal Employer control has multiple visible dropdown buttons.')
        if (visibleButtons.length === 1) {
          await visibleButtons[0].click({ timeout: timeoutMs })
          return
        }
      }
      if (level < 3) scope = scope.locator('xpath=..')
    }
    const bounds = await locator.boundingBox().catch(() => null)
    if (!bounds || bounds.width <= 24 || bounds.height <= 10) throw new BrowserTestError('LOCATOR_NOT_FOUND', 'Oracle’s Legal Employer dropdown trigger was not found.')
    await locator.click({ position: { x: bounds.width - Math.min(12, bounds.width / 4), y: bounds.height / 2 }, timeout: timeoutMs })
  }

  await openDropdown()
  await page.waitForTimeout(CSV_FIELD_SETTLE_MS)
  try {
    await clickOracleSelectOption(page, value, Math.min(timeoutMs, 1500))
    return
  } catch (error) {
    if (error.code === 'AMBIGUOUS_LOCATOR') throw error
  }
  if (inputCount && readOnly === null) {
    if (typeof searchInput.pressSequentially === 'function') {
      await searchInput.fill('', { timeout: Math.min(timeoutMs, 2000) }).catch(() => {})
      await searchInput.pressSequentially(value, { delay: 30, timeout: Math.min(timeoutMs, 3000) }).catch(() => {})
    } else {
      await searchInput.fill(value, { timeout: Math.min(timeoutMs, 3000) }).catch(() => {})
    }
  }
  await page.waitForTimeout(CSV_FIELD_SETTLE_MS)
  await openDropdown()
  await page.waitForTimeout(CSV_FIELD_SETTLE_MS)
  try {
    return await clickOracleSelectOption(page, value, timeoutMs)
  } catch (error) {
    if (error.code !== 'OPTION_NOT_FOUND') throw error
    throw new BrowserTestError('OPTION_NOT_FOUND', 'Oracle did not show an exact matching Legal Employer or Business Unit option after the dropdown was opened.')
  }
}

function locatorDescription(spec) {
  return spec.kind + (spec.name ? ':' + spec.name : spec.value ? ':' + spec.value : '')
}

function safePageUrl(page) {
  try {
    const url = new URL(page.url())
    const path = url.pathname.replace(/\/(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{40,})(?=\/|$)/g, '/[redacted]')
    return url.origin + path
  } catch { return '' }
}

function isOracleHcmApplication(app) {
  return /\boracle\b.*\bhcm\b/i.test(String(app?.application_name || ''))
}

function isOracleEmployeeWizardPage(app, pageUrl) {
  if (!isOracleHcmApplication(app)) return false
  try {
    const pathname = new URL(pageUrl).pathname
    return /\/employment-addperson\/create\/employee\/?$/i.test(pathname)
      || /\/hcmUI\/faces\/FndOverview\/?$/i.test(pathname)
  } catch { return false }
}

async function waitForOracleAdfSynchronized(page, timeoutMs = 30_000) {
  if (!page) return true
  const deadline = Date.now() + timeoutMs
  await page.waitForTimeout(400)
  while (Date.now() < deadline) {
    try {
      const isSynchronized = await page.evaluate(() => {
        try {
          if (window.AdfPage && window.AdfPage.PAGE) {
            if (typeof window.AdfPage.PAGE.isSynchronizedWithServer === 'function') {
              if (!window.AdfPage.PAGE.isSynchronizedWithServer()) return false
            }
          }
          const busyElem = document.querySelector('.p_AFBusy, #_af_busy, [id*="_af_busy"]')
          if (busyElem && window.getComputedStyle(busyElem).display !== 'none') return false
          return true
        } catch { return true }
      })
      if (isSynchronized) return true
    } catch {}
    await page.waitForTimeout(300)
  }
  return false
}

async function waitForOracleReviewStep(page, timeoutMs = 30_000) {
  if (!page) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const isReview = await page.evaluate(() => {
      try {
        const h1 = document.querySelector('h1, .af_panelHeader_title-text')
        if (h1 && /Review/i.test(h1.textContent || '')) return true
        const currentStep = document.querySelector('[aria-label*="Review"][aria-label*="Current"], [title*="Review"][title*="Current"]')
        if (currentStep) return true
        const trainText = document.body.innerText || ''
        if (/Review Step:\s*Current/i.test(trainText)) return true
        return false
      } catch { return false }
    })
    if (isReview) return true

    // Check if Submit button is already enabled
    const submitBtn = page.getByRole('button', { name: 'Submit', exact: true }).first()
    const ariaDisabled = await submitBtn.getAttribute('aria-disabled').catch(() => null)
    if (ariaDisabled === 'false') return true

    // If still on Compensation and Other Information step, ADF might have dropped the Next click
    const isCompensation = await page.evaluate(() => {
      try {
        const text = document.body.innerText || ''
        return /Compensation and Other Information Step:\s*Current/i.test(text)
          || /Hire an Employee:\s*Compensation and Other Information/i.test(text)
      } catch { return false }
    })

    if (isCompensation) {
      await waitForOracleAdfSynchronized(page, 5_000)
      const nextBtn = page.getByRole('button', { name: 'Next', exact: true }).first()
      const nextDisabled = await nextBtn.getAttribute('aria-disabled').catch(() => null)
      if (nextDisabled !== 'true' && await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click().catch(() => {})
        await page.waitForTimeout(1000)
        await waitForOracleAdfSynchronized(page, 10_000)
      }
    }

    await page.waitForTimeout(500)
  }
  return false
}

async function waitForOracleSubmitEnabled(locator, timeoutMs, throwIfCancelled) {
  const page = typeof locator.page === 'function' ? locator.page() : null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (typeof throwIfCancelled === 'function') throwIfCancelled()
    if (page) {
      const isCompensation = await page.evaluate(() => {
        try {
          const text = document.body.innerText || ''
          return /Compensation and Other Information Step:\s*Current/i.test(text)
            || /Hire an Employee:\s*Compensation and Other Information/i.test(text)
        } catch { return false }
      })
      if (isCompensation) {
        await waitForOracleReviewStep(page, Math.min(15_000, Math.max(1_000, deadline - Date.now())))
      }
    }
    const ariaDisabled = await locator.getAttribute('aria-disabled').catch(() => null)
    const classList = await locator.getAttribute('class').catch(() => '')
    const isEnabled = await locator.isEnabled().catch(() => false)
    if (ariaDisabled !== 'true' && !/\bp_AFDisabled\b/i.test(classList) && isEnabled) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function isOracleAuthPage(app, pageUrl) {
  if (!isOracleHcmApplication(app)) return false
  try {
    const url = new URL(pageUrl)
    return /identity\.oraclecloud\.com/i.test(url.hostname)
      || /\/(?:ui\/v1\/signin|signin|login)\b/i.test(url.pathname)
  } catch { return false }
}

function fieldLocatorTimeout(page, app, defaultTimeoutMs) {
  if (!isOracleHcmApplication(app)) return defaultTimeoutMs
  const url = page.url()
  return (isOracleEmployeeWizardPage(app, url) || isOracleAuthPage(app, url))
    ? Math.max(defaultTimeoutMs, 45_000)
    : defaultTimeoutMs
}

async function readOracleFieldValue(locator, timeoutMs) {
  const inputVal = await locator.inputValue({ timeout: timeoutMs }).catch(() => '')
  if (inputVal && inputVal.trim()) return inputVal.trim()
  const inner = await locator.innerText({ timeout: timeoutMs }).catch(() => '')
  if (inner && inner.trim()) return inner.trim()
  const title = await locator.getAttribute('title').catch(() => '')
  if (title && title.trim()) return title.trim()
  const ariaLabel = await locator.getAttribute('aria-label').catch(() => '')
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim()
  return ''
}

async function fillOracleEmployeeComboboxField(page, locator, action, value, locatorTimeoutMs, testData) {
  // Clear any existing value and focus the combobox input only if already non-empty
  try {
    const existing = await readOracleFieldValue(locator, 1000)
    if (existing) {
      await locator.click({ timeout: locatorTimeoutMs })
      await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {})
      await locator.press('Backspace').catch(() => {})
      await locator.fill('', { timeout: locatorTimeoutMs }).catch(() => {})
    } else {
      await locator.click({ timeout: locatorTimeoutMs }).catch(() => {})
    }
  } catch {}

  // Type sequentially so Oracle fires keyboard events and displays its auto-suggest popup
  if (typeof locator.pressSequentially === 'function') {
    await locator.pressSequentially(value, { delay: 30, timeout: locatorTimeoutMs }).catch(() => {})
  } else {
    await locator.fill(value, { timeout: locatorTimeoutMs }).catch(() => {})
  }
  await page.waitForTimeout(CSV_FIELD_SETTLE_MS)

  // Commit the suggestion:
  // 1. Try to click the suggestion from the auto-suggest popup
  try {
    await clickOracleSelectOption(page, value, Math.min(locatorTimeoutMs, 3000))
  } catch {
    // 2. If no option was clicked, press Enter to commit the active suggestion in the Oracle combobox
    try {
      await locator.press('Enter', { timeout: 1000 })
      await page.waitForTimeout(CSV_FIELD_SETTLE_MS)
    } catch {}
  }

  // 3. Re-read the field value to verify whether Oracle retained it
  let refreshedLocator = await uniqueActionLocator(page, action, locatorTimeoutMs, testData).catch(() => locator)
  let retainedValue = await readOracleFieldValue(refreshedLocator, locatorTimeoutMs)

  // 4. If Oracle cleared it or didn't commit, fall back to opening the dropdown via selectWorkflowOption
  if (retainedValue.trim() !== value.trim()) {
    try {
      await selectWorkflowOption(page, refreshedLocator, value, locatorTimeoutMs)
      await page.waitForTimeout(CSV_FIELD_SETTLE_MS)
      refreshedLocator = await uniqueActionLocator(page, action, locatorTimeoutMs, testData).catch(() => refreshedLocator)
      retainedValue = await readOracleFieldValue(refreshedLocator, locatorTimeoutMs)
    } catch {}
  }

  // 5. If it still didn't retain the value, throw the error
  if (retainedValue.trim() !== value.trim()) {
    const fieldName = action.dataKey === 'legal_employer' ? 'Legal Employer' : action.dataKey === 'business_unit' ? 'Business Unit' : 'field'
    throw new BrowserTestError(
      'ORACLE_FIELD_VALUE_CLEARED',
      `Oracle cleared the ${fieldName} value after it was typed. The workflow stopped before continuing.`
    )
  }
}

async function blurFilledField(locator, timeoutMs) {
  // Use a real keyboard blur first so Oracle receives the same focus/change
  // events as a person tabbing out of a field. ADF can detach and rebuild the
  // input during that event, so fall back to the element's blur when possible.
  try { await locator.press('Tab', { timeout: Math.min(timeoutMs, 5000) }) } catch {
    await locator.evaluate((element) => element.blur()).catch(() => {})
  }
  await locator.evaluate((element) => element.blur()).catch(() => {})
}

async function waitForOracleEmployeeFormReady(page, nextAction, timeoutMs, testData) {
  const deadline = Date.now() + Math.min(45_000, Math.max(timeoutMs, 15_000))
  const heading = page.getByText('Hire an Employee: Identification', { exact: true }).first()
  const taskMenu = page.getByText('What do you want to do or manage?', { exact: true }).first()
  while (Date.now() < deadline) {
    const headingVisible = await heading.isVisible().catch(() => false)
    let fieldVisible = false
    if (nextAction && ['fill', 'select'].includes(nextAction.action)) {
      try {
        const field = await uniqueActionLocator(page, nextAction, Math.min(timeoutMs, 1000), testData)
        fieldVisible = await field.isVisible().catch(() => false)
      } catch {}
    }
    const taskMenuVisible = await taskMenu.isVisible().catch(() => false)
    if ((headingVisible || fieldVisible) && !taskMenuVisible) return
    await page.waitForTimeout(150)
  }
  throw new BrowserTestError('ORACLE_PAGE_LOAD_TIMEOUT', 'Oracle did not finish opening the Hire an Employee form before field entry.', 'FAILED')
}

function safeDiagnosticUrl(raw) {
  try {
    const url = new URL(raw)
    const path = url.pathname.split('/').map((segment) => {
      if (/^(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{32,}|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(segment)) return '[redacted]'
      // Keep readable camel-case REST resource/action names in diagnostics,
      // while continuing to hide long opaque IDs and token-like path segments.
      if (segment.length >= 24 && !/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(segment)) return '[redacted]'
      return segment
    }).join('/')
    return { origin: url.origin, path }
  } catch { return { origin: null, path: null } }
}

function isMainFrameNavigation(request, page) {
  try { return request.isNavigationRequest() && request.frame() === page.mainFrame() } catch { return false }
}

async function maskInputsForScreenshot(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.value) element.value = '••••••'
      } else if (element instanceof HTMLElement && element.innerText) {
        element.innerText = '••••••'
      }
    }
  }).catch(() => {})
}

async function saveArtifact({ executionId, kind, sourcePath, bytes, contentType, outputDirectory, artifactBase }) {
  const extension = kind === 'screenshot' ? '.png' : kind === 'video' ? '.webm' : kind === 'trace' ? '.zip' : '.json'
  const fileName = kind + '-' + randomUUID() + extension
  const destination = resolve(outputDirectory, fileName)
  if (sourcePath) await rename(sourcePath, destination)
  else await writeFile(destination, bytes)
  const fileInfo = await stat(destination)
  const relativePath = relative(artifactBase, destination).split(sep).join('/')
  const row = await persistBrowserTestArtifact({
    id: 'bta-' + randomUUID(),
    executionId,
    kind,
    relativePath,
    contentType,
    sizeBytes: fileInfo.size,
  })
  return row
}

async function waitForManualLogin(executionId, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      resumeControls.delete(executionId)
      reject(new BrowserTestError('MANUAL_LOGIN_TIMEOUT', 'Manual login was not resumed before the five-minute limit.', 'BLOCKED'))
    }, timeoutMs)
    resumeControls.set(executionId, () => {
      clearTimeout(timer)
      resumeControls.delete(executionId)
      resolvePromise()
    })
  })
}

export function resumeBrowserTestAfterLogin(executionId) {
  const resume = resumeControls.get(executionId)
  if (!resume) return false
  resume()
  return true
}

export function cancelBrowserTestExecution(executionId) {
  const control = cancellationControls.get(executionId)
  if (!control) return false
  control.cancelled = true
  control.page?.close().catch(() => {})
  resumeControls.get(executionId)?.()
  return true
}

export async function executeBrowserTest(executionId, options = {}) {
  const startedAt = new Date()
  const startedMs = Date.now()
  const runId = executionId.id
  const actionTimeoutMs = Math.min(60_000, Math.max(1_000, Number(options.defaultTimeoutMs) || 10_000))
  // Federated Oracle sign-in can follow several same-workflow redirects and
  // return HTTP 200 before DOMContentLoaded fires. Give navigations their own
  // bounded allowance without lengthening ordinary locator/action waits.
  const navigationTimeoutMs = Math.min(60_000, Math.max(actionTimeoutMs, 30_000))
  const recordVideoRequested = options.recordVideo !== false && options.recordArtifacts !== false
  const recordingPolicy = ['disabled', 'mask-form-values', 'show-non-password-values', 'show-all-values'].includes(options.recordingPolicy) ? options.recordingPolicy : 'mask-form-values'
  const reuseAuthenticatedSession = options.reuseAuthenticatedSession === true
  const control = options.control || { cancelled: false, page: null }
  cancellationControls.set(runId, control)
  const throwIfCancelled = () => {
    if (control.cancelled) throw new BrowserTestError('USER_CANCELLED', 'Execution was cancelled by the user.', 'CANCELLED')
  }
  let browser
  let context
  let page
  let proxy
  let traceStarted = false
  let traceSensitive = false
  let manualAuthActive = false
  const manualAuthPaths = new Set()
  const manualAuthOrigins = new Set()
  let activeWriteAuthorization = null
  let activeWorkflowPostback = null
  let pendingWorkflowPostback = null
  let policyBlock = null
  let stepNumber = 0
  let videoPath
  let videoPersisted = false
  let safeRecording = recordVideoRequested && recordingPolicy !== 'disabled'
  let videoStatus = safeRecording ? 'PENDING' : 'NOT_REQUESTED'
  let videoError = safeRecording ? null : recordVideoRequested ? 'Recording was disabled for this test by its recording policy.' : 'Recording was disabled for this test.'
  let tracePath
  let outputDirectory
  let artifactBase
  let testData = {}
  const policyWarnings = []
  const diagnostics = []
  const recordDiagnostic = (item) => {
    if (diagnostics.length < 100) { diagnostics.push(item); return }
    // Pages such as Oracle HCM can emit many client-side rule errors during
    // startup. Keep actionable network-policy failures in the report even when
    // those messages have filled the diagnostic limit.
    if (['request_blocked', 'outbound_request_blocked', 'request_failed'].includes(item?.type)) {
      const replaceIndex = diagnostics.findIndex((entry) => entry?.type === 'console_error')
      if (replaceIndex >= 0) diagnostics[replaceIndex] = item
    }
  }
  let remoteHttpError = null
  const recordPolicyWarning = (code, hostname, category, topLevelNavigation) => {
    policyWarnings.push({ reasonCode: code, hostname: hostname || null, category, topLevelNavigation: Boolean(topLevelNavigation) })
    if (topLevelNavigation) policyBlock = { code, hostname: hostname || null }
  }
  const stepResults = []

  try {
    throwIfCancelled()
    const testCase = await getBrowserTestCaseById(executionId.caseId || executionId)
    if (!testCase) throw new BrowserTestError('CASE_NOT_FOUND', 'The registered browser test case no longer exists.', 'BLOCKED')
    const app = testCase
    testData = testCase.test_data || {}
    if (app.application_auth_method === 'credential_reference') throw new BrowserTestError('CREDENTIAL_PROVIDER_UNAVAILABLE', 'This application uses a credential reference, but no vault provider is configured for browser tests.', 'BLOCKED')
    if (app.application_status !== 'Active') throw new BrowserTestError('APPLICATION_ARCHIVED', 'The registered application is not active.', 'BLOCKED')
    const plan = testCase.plan
    try { validateActionPlan(plan, testData) } catch (error) { throw new BrowserTestError(error.code || 'INVALID_PLAN', error.message, 'BLOCKED') }
    const planHasCsvCredentials = plan.actions.some((action) => action.credentialInput === true)
    if (planHasCsvCredentials && app.application_auth_method !== 'manual') throw new BrowserTestError('INVALID_PLAN', 'CSV credential login steps require the application to use manual authentication.', 'BLOCKED')
    if (plan.actions.some((action) => ['create', 'update', 'delete'].includes(action.action) && (action.requiresApproval !== true || action.requiresWriteApproval !== true))) {
      throw new BrowserTestError('INVALID_PLAN', 'Every saved write action must carry explicit interactive and write approval requirements.', 'BLOCKED')
    }
    if (plan.actions.some((action) => action.requiresApproval) && !executionId.approvedInteractions) throw new BrowserTestError('APPROVAL_REQUIRED', 'This plan contains interactive actions and needs explicit run approval.', 'BLOCKED')
    if (plan.actions.some((action) => ['create', 'update', 'delete'].includes(action.action)) && options.allowWrites !== true) {
      throw new BrowserTestError('WRITE_MODE_REQUIRED', 'This test contains write actions. Enable writes and approve the reviewed form actions for this run.', 'BLOCKED')
    }

    const appUrl = new URL(app.application_base_url)
    const loginUrl = app.application_login_url || app.application_base_url
    const loginOrigin = normalizeAllowedOrigin(new URL(loginUrl).origin)
    const navOrigins = new Set([normalizeAllowedOrigin(appUrl.origin), ...(app.approved_navigation_origins || []).map(normalizeAllowedOrigin)])
    // The registered login URL can redirect through an explicitly approved
    // identity provider before the runner sees its first page event. Seed the
    // temporary auth scope from registered navigation origins so that redirect
    // POSTs to that IdP are allowed while manual authentication is active.
    for (const origin of navOrigins) manualAuthOrigins.add(origin)
    manualAuthOrigins.add(loginOrigin)
    if (!navOrigins.has(loginOrigin)) throw new BrowserTestError('LOGIN_ORIGIN_BLOCKED', 'The registered login URL origin is not an approved navigation origin.', 'BLOCKED')
    const resourceOrigins = new Set([normalizeAllowedOrigin(appUrl.origin), ...(app.approved_resource_origins || []).map(normalizeAllowedOrigin)])
    const internalOrigins = [appUrl.origin, ...(app.approved_navigation_origins || []), ...(app.approved_resource_origins || [])]

    const configuredArtifact = resolve(options.artifactRoot || process.env.ARTIFACT_DIR || 'backend/artifacts')
    artifactBase = resolve(configuredArtifact, 'browser-tests')
    outputDirectory = resolve(artifactBase, runId)
    await mkdir(outputDirectory, { recursive: true })

    throwIfCancelled()
    proxy = await createSecurityProxy({
      allowedHost: appUrl.hostname,
      primaryOrigin: appUrl.origin,
      navigationOrigins: [...navOrigins].filter((origin) => origin !== normalizeAllowedOrigin(appUrl.origin)),
      resourceOrigins: [...resourceOrigins].filter((origin) => origin !== normalizeAllowedOrigin(appUrl.origin)),
      allowPublicOrigins: true,
      internalOrigins,
      manualAuthOrigin: loginOrigin,
      manualAuthOrigins,
      manualAuthPaths,
      isManualAuthActive: () => manualAuthActive,
      isApprovedWriteRequest: (request) => isApprovedWritePostAllowed({ ...request, authorization: activeWriteAuthorization }),
      isApprovedWorkflowPostback: (request) => isApprovedWorkflowPostbackAllowed({ ...request, authorization: activeWorkflowPostback }),
      // The outbound proxy independently inspects the JSON operation body before
      // permitting Oracle's employment-configuration helper action.
      isOracleHcmReadPost: (request) => isOracleHcmApplication(app) && isOracleHcmReadPostAllowed({ ...request, applicationOrigin: appUrl.origin }),
      dnsLookup: options.dnsLookup,
      testTargetIp: options.testTargetIp,
      testTargetPort: options.testTargetPort,
      connectTimeoutMs: 8000,
      onSecurityViolation: (event) => {
        const host = String(event.hostname || '').toLowerCase().replace(/\.$/, '')
        const isMainHost = host === appUrl.hostname.toLowerCase().replace(/\.$/, '')
        recordPolicyWarning(event.type || 'SECURITY_POLICY_BLOCKED', host, 'network', isMainHost)
        recordDiagnostic({ type: 'outbound_request_blocked', stage: event.stage || 'proxy_destination_validation', blockingComponent: 'Chronos outbound security proxy', hostname: host || null, reasonCode: event.type || 'SECURITY_POLICY_BLOCKED', reason: safeText(event.reason || 'Outbound destination was rejected by network policy.', testData) })
      },
    })
    throwIfCancelled()
    const cachedAuth = reuseAuthenticatedSession && !planHasCsvCredentials ? approvedSessionStates.get(String(app.application_id)) : null
    const cachedStorageState = cachedAuth && cachedAuth.expiresAt > Date.now() ? cachedAuth.state : undefined
    if (cachedAuth && !cachedStorageState) approvedSessionStates.delete(String(app.application_id))
    const shouldRunHeadless = typeof options.headless === 'boolean'
      ? options.headless
      : (process.env.HEADLESS === 'false' ? false : (app.application_auth_method === 'manual' && !cachedStorageState ? false : process.env.HEADLESS === 'true'))
    console.log("[Chronos Runner] Launching browser for execution " + runId + " (headless: " + shouldRunHeadless + ")")
    const launchOptions = {
      headless: shouldRunHeadless,
      slowMo: shouldRunHeadless ? 0 : 400,
      timeout: 30_000,
      proxy: { server: proxy.proxyUrl, bypass: '<-loopback>' },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-quic',
        '--dns-prefetch-disable',
        '--disable-background-networking',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--new-window',
        '--start-maximized',
        '--window-position=0,0',
        '--proxy-bypass-list=<-loopback>',
        '--proxy-server=' + proxy.proxyUrl,
      ],
    }
    // Launch Playwright's dedicated Chromium browser for visible execution
    if (process.env.BROWSER_ENGINE === 'chrome') {
      try { browser = await chromium.launch({ ...launchOptions, channel: 'chrome' }) }
      catch { browser = await chromium.launch(launchOptions) }
    } else {
      browser = await chromium.launch(launchOptions)
    }
    context = await browser.newContext({
      ignoreHTTPSErrors: false,
      // Keep Oracle's responsive layout aligned with the manual workflow
      // recorder so fixed-footer controls remain present in the live browser.
      // Oracle's Redwood shell also expects its service worker to be available.
      viewport: null,
      ...(cachedStorageState ? { storageState: cachedStorageState } : {}),
      ...(safeRecording ? { recordVideo: { dir: outputDirectory } } : {}),
    })
    if (safeRecording && recordingPolicy === 'mask-form-values') {
      await context.addInitScript(() => {
        const installMask = () => {
          if (!document.documentElement) return
          if (!document.getElementById('chronos-video-mask')) {
            const style = document.createElement('style')
            style.id = 'chronos-video-mask'
            style.textContent = `input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select, [contenteditable="true"] { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; text-shadow: none !important; } input::placeholder, textarea::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; }`
            document.documentElement.appendChild(style)
          }
          for (const element of document.querySelectorAll('input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select, [contenteditable="true"]')) {
            for (const [property, value] of [['color', 'transparent'], ['-webkit-text-fill-color', 'transparent'], ['caret-color', 'transparent'], ['text-shadow', 'none']]) {
              if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== 'important') element.style.setProperty(property, value, 'important')
            }
          }
        }
        installMask()
        new MutationObserver(installMask).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
      })
    }
    if (safeRecording && recordingPolicy === 'show-all-values') {
      await context.addInitScript(() => {
        const style = document.createElement('style')
        style.id = 'chronos-show-all-form-values'
        style.textContent = 'input[type="password"] { -webkit-text-security: none !important; }'
        const install = () => { if (document.documentElement && !document.getElementById(style.id)) document.documentElement.appendChild(style) }
        install()
        new MutationObserver(install).observe(document, { childList: true, subtree: true })
      })
    }
    page = await context.newPage()
    control.page = page
    throwIfCancelled()
    await context.route('**/*', async (route) => {
      const request = route.request()
      let parsed
      try { parsed = new URL(request.url()) } catch {
        const main = isMainFrameNavigation(request, page)
        if (main) policyBlock = { code: 'INVALID_REQUEST_URL' }
        recordDiagnostic({ type: 'request_blocked', stage: main ? 'main_document' : 'subresource', blockingComponent: 'Chronos Playwright request policy', reasonCode: 'INVALID_REQUEST_URL', method: request.method(), resourceType: request.resourceType(), isMainFrameNavigation: main, reason: 'The request URL was malformed.' })
        return route.abort('blockedbyclient')
      }
      if (traceStarted && [...parsed.searchParams.keys()].some((key) => /password|passwd|pwd|token|session|cookie|authorization|secret/i.test(key))) traceSensitive = true
      if (traceStarted) {
        const headers = await request.allHeaders().catch(() => ({}))
        if (headers.cookie || headers.authorization || headers['proxy-authorization']) traceSensitive = true
      }
      const isMainNavigation = isMainFrameNavigation(request, page)
      try { normalizeAllowedOrigin(parsed.origin) } catch {
        if (isMainNavigation) policyBlock = { code: 'INVALID_DESTINATION' }
        recordDiagnostic({ type: 'request_blocked', stage: isMainNavigation ? 'main_document' : 'subresource', blockingComponent: 'Chronos Playwright request policy', hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''), reasonCode: 'INVALID_DESTINATION', method: request.method(), resourceType: request.resourceType(), isMainFrameNavigation: isMainNavigation, reason: 'Destination hostname is prohibited by the local-address policy.' })
        return route.abort('blockedbyclient')
      }
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      if (port !== 80 && port !== 443) {
        recordPolicyWarning('PORT_BLOCKED', parsed.hostname, request.resourceType(), isMainNavigation)
        recordDiagnostic({ type: 'request_blocked', stage: isMainNavigation ? 'main_document' : 'subresource', blockingComponent: 'Chronos Playwright request policy', reasonCode: 'PORT_BLOCKED', method: request.method(), ...safeDiagnosticUrl(request.url()), resourceType: request.resourceType(), isMainFrameNavigation: isMainNavigation, reason: 'Only standard web ports 80 and 443 are allowed.' })
        return route.abort('blockedbyclient')
      }
      const method = request.method()
      // In a credential-backed manual-auth workflow, the reviewed login steps
      // themselves perform the sign-in. Record each top-level HTTP(S) origin as
      // it is visited so an IdP redirect can submit only after its GET navigation
      // was observed during the active login sequence.
      if (manualAuthActive && ['GET', 'HEAD'].includes(method) && request.isNavigationRequest()) {
        try { manualAuthOrigins.add(normalizeAllowedOrigin(parsed.origin)) } catch {}
      }
      const contentType = method === 'POST' ? await request.headerValue('content-type').catch(() => null) : null
      let oracleActionPayload = null
      let oracleActionPayloadParsed = false
      if (isOracleHcmApplication(app) && /^application\/vnd\.oracle\.adf\.action\+json(?:;|$)/i.test(String(contentType || ''))) {
        try { oracleActionPayload = request.postDataJSON(); oracleActionPayloadParsed = true } catch {}
      }
      const accessControlRequestMethod = method === 'OPTIONS' ? await request.headerValue('access-control-request-method').catch(() => null) : null
      const isManualLoginPost = isManualLoginPostAllowed({
        method,
        targetUrl: parsed,
        contentType,
        accessControlRequestMethod,
        isDocumentNavigation: request.isNavigationRequest() && request.resourceType() === 'document',
        manualAuthOrigin: loginOrigin,
        manualAuthOrigins,
        manualAuthPaths,
        isManualAuthActive: () => manualAuthActive,
      })
      const isApprovedWritePost = isApprovedWritePostAllowed({ method, targetUrl: parsed, contentType, authorization: activeWriteAuthorization })
      // Oracle ADF actions can submit their reviewed form postback through XHR
      // instead of a document navigation. The approval remains active only for
      // the captured click and is still limited to its exact origin and path.
      const isApprovedPostback = isApprovedWorkflowPostbackAllowed({ method, targetUrl: parsed, contentType, authorization: activeWorkflowPostback })
      // Oracle's BI proxy is used as a same-origin page-data document request
      // while rendering the ADF shell. Without this read-only query the browser
      // shows the navbar but the main content area becomes a broken document.
      const isOracleHcmReadPost = isOracleHcmApplication(app)
        && isOracleHcmReadPostAllowed({ method, targetUrl: parsed, contentType, applicationOrigin: appUrl.origin, requestBody: oracleActionPayload })
      if (method !== 'GET' && method !== 'HEAD' && !isManualLoginPost && !isApprovedWritePost && !isApprovedPostback && !isOracleHcmReadPost) {
        recordPolicyWarning('READ_ONLY_METHOD_BLOCKED', parsed.hostname, request.resourceType(), isMainNavigation)
        const manualAuthOriginObserved = (() => { try { return manualAuthOrigins.has(normalizeAllowedOrigin(parsed.origin)) } catch { return false } })()
        const oracleOperation = oracleHcmActionOperation(oracleActionPayload)
        recordDiagnostic({ type: 'request_blocked', stage: isMainNavigation ? 'main_document' : 'subresource', blockingComponent: 'Chronos read-only request policy', reasonCode: 'READ_ONLY_METHOD_BLOCKED', method, ...safeDiagnosticUrl(request.url()), resourceType: request.resourceType(), isMainFrameNavigation: isMainNavigation, ...(method === 'POST' ? { manualAuthActive, manualAuthOriginObserved, requestContentType: String(contentType || '').split(';')[0] || null, ...(isOracleHcmApplication(app) ? { oracleActionPayloadParsed, oracleActionOperation: oracleOperation || null } : {}) } : {}), reason: 'Chronos blocked this non-GET/HEAD request under the read-only policy.' })
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    page.on('response', (response) => {
      const request = response.request()
      const mainNavigation = isMainFrameNavigation(request, page)
      // Redirects in federated sign-in can bypass the request route callback for
      // an intermediate identity-provider URL. Learn its origin from the
      // completed top-level GET so the following login form POST can be scoped
      // to an origin the browser actually visited during the active auth gate.
      if (manualAuthActive && ['GET', 'HEAD'].includes(request.method()) && mainNavigation) {
        try { manualAuthOrigins.add(normalizeAllowedOrigin(new URL(response.url()).origin)) } catch {}
      }
      if (traceStarted && response.headers()['set-cookie']) traceSensitive = true
      const responseUrl = safeDiagnosticUrl(response.url())
      const proxyRejected = diagnostics.some((item) => item.type === 'outbound_request_blocked' && item.hostname === responseUrl.origin?.replace(/^https?:\/\//, '').toLowerCase().replace(/:\d+$/, ''))
      if (response.status() >= 400 || mainNavigation) recordDiagnostic({ type: mainNavigation ? 'navigation_response' : 'http_response', stage: mainNavigation ? 'main_document' : 'subresource', responseSource: proxyRejected ? 'Chronos outbound security proxy' : 'remote website', method: request.method(), ...responseUrl, status: response.status(), resourceType: request.resourceType(), isMainFrameNavigation: mainNavigation })
      if (response.status() >= 400 && mainNavigation) {
        remoteHttpError = { status: response.status(), hostname: (() => { try { return new URL(response.url()).hostname } catch { return null } })() }
      }
    })
    page.on('console', (message) => {
      if (message.type() === 'error') recordDiagnostic({ type: 'console_error', message: safeText(message.text(), testData) })
    })
    page.on('pageerror', (error) => recordDiagnostic({ type: 'page_error', name: error.name, message: safeText(error.message, testData) }))
    const captureManualAuthForms = async () => {
      if (!manualAuthActive || !page || page.isClosed()) return
      let paths
      try {
        paths = await retryLocatorResolutionDuringNavigation(page, () => page.locator('form').evaluateAll((forms) => forms
          .filter((form) => form.method.toUpperCase() === 'POST')
          .map((form) => {
            try {
              const action = new URL(form.action, location.href)
              return action.origin === location.origin ? action.pathname : null
            } catch { return null }
          })
          .filter(Boolean)), 4000)
      } catch (error) {
        if (/execution context was destroyed|most likely because of a navigation|frame was detached|cannot find context with specified id/i.test(String(error?.message || error))) return
        throw error
      }
      let pageOrigin
      try {
        const currentUrl = new URL(page.url())
        if (!['http:', 'https:'].includes(currentUrl.protocol)) return
        pageOrigin = normalizeAllowedOrigin(currentUrl.origin)
      } catch {
        // Redirects can briefly expose an opaque URL while the identity page is
        // changing documents. It is not an origin to add to the auth allowlist.
        return
      }
      manualAuthOrigins.add(pageOrigin)
      for (const path of paths) manualAuthPaths.add(pageOrigin + path)
    }
    page.on('domcontentloaded', () => { captureManualAuthForms().catch(() => {}) })
    page.on('requestfailed', (request) => {
      const failure = safeText(request.failure()?.errorText || 'Request failed.', testData)
      const safeUrl = safeDiagnosticUrl(request.url())
      const chronosAborted = failure.includes('ERR_BLOCKED_BY_CLIENT') && diagnostics.some((item) => item.type === 'request_blocked' && item.method === request.method() && item.origin === safeUrl.origin && item.path === safeUrl.path)
      const networkError = /ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_(RESET|REFUSED|TIMED_OUT)|TIMED_OUT|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/i.exec(failure)?.[0] || null
      recordDiagnostic({
        type: 'request_failed', stage: isMainFrameNavigation(request, page) ? 'main_document' : 'subresource',
        failureSource: chronosAborted ? 'Chronos request policy' : networkError ? 'browser_or_network_transport' : 'browser_request',
        reasonCode: chronosAborted ? 'REQUEST_BLOCKED_BY_CHRONOS_POLICY' : networkError || (failure.includes('ERR_ABORTED') ? 'REQUEST_ABORTED' : 'REQUEST_FAILED'),
        method: request.method(), ...safeUrl, isMainFrameNavigation: isMainFrameNavigation(request, page),
        resourceType: request.resourceType(), error: failure,
      })
    })

    throwIfCancelled()
    await updateBrowserTestExecution(runId, { status: 'RUNNING', startedAt })
    // The login page may issue identity-provider requests while it loads. Enable
    // the tightly scoped manual-auth policy before navigating when the saved plan
    // contains an explicitly reviewed password CSV field.
    if (app.application_auth_method === 'manual' && planHasCsvCredentials && !cachedStorageState) manualAuthActive = true
    const initialResponse = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
    if (initialResponse && initialResponse.status() >= 400) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + initialResponse.status() + '.', 'FAILED')
    if (app.application_auth_method === 'manual' && !cachedStorageState) {
      manualAuthActive = true
      await captureManualAuthForms()
      if (!planHasCsvCredentials) {
        await updateBrowserTestExecution(runId, { actualOutcome: 'Waiting for user to complete manual login and resume the test.' })
        await waitForManualLogin(runId, 300_000)
        manualAuthActive = false
        const currentOrigin = normalizeAllowedOrigin(new URL(page.url()).origin)
        if (!navOrigins.has(currentOrigin)) throw new BrowserTestError('LOGIN_ORIGIN_BLOCKED', 'After manual login, the browser was outside approved application navigation origins.', 'BLOCKED')
        const stillHasPasswordField = await page.locator('input[type="password"]').count().catch(() => 0)
        if (stillHasPasswordField && new URL(page.url()).pathname === new URL(loginUrl).pathname) throw new BrowserTestError('AUTHENTICATION_NOT_CONFIRMED', 'The login page is still active after manual confirmation.', 'BLOCKED')
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
        if (reuseAuthenticatedSession) {
          const approvedState = await context.storageState()
          for (const [key, entry] of approvedSessionStates) if (entry.expiresAt <= Date.now()) approvedSessionStates.delete(key)
          approvedSessionStates.set(String(app.application_id), { state: approvedState, expiresAt: Date.now() + AUTH_STATE_TTL_MS })
        }
      }
    } else if (app.application_auth_method === 'manual' && cachedStorageState) {
      const currentOrigin = normalizeAllowedOrigin(new URL(page.url()).origin)
      if (!navOrigins.has(currentOrigin)) throw new BrowserTestError('AUTHENTICATED_SESSION_INVALID', 'The approved authenticated session did not reach a registered application origin.', 'BLOCKED')
      if (await page.locator('input[type="password"]').count().catch(() => 0)) {
        approvedSessionStates.delete(String(app.application_id))
        throw new BrowserTestError('AUTHENTICATED_SESSION_EXPIRED', 'The approved authenticated session has expired; complete manual login again.', 'BLOCKED')
      }
    }

    if (safeRecording) {
      await context.tracing.start({ screenshots: false, snapshots: false, sources: false })
      traceStarted = true
    }

    for (let actionIndex = 0; actionIndex < plan.actions.length; actionIndex += 1) {
      const action = plan.actions[actionIndex]
      throwIfCancelled()
      if (Date.now() - startedMs > MAX_EXECUTION_MS) throw new BrowserTestError('EXECUTION_TIMEOUT', 'The browser test exceeded its two-minute execution limit.')
      if (pendingWorkflowPostback && !(action.action === 'fill' && action.dataKey === 'search')) pendingWorkflowPostback = null
      stepNumber += 1
      const stepStarted = new Date()
      const stepStartedMs = Date.now()
      let actual
      let expected
      try {
        if (action.action === 'navigate') {
          const target = new URL(action.url)
          if (!['http:', 'https:'].includes(target.protocol)) throw new BrowserTestError('NAVIGATION_ORIGIN_BLOCKED', 'Navigation must use HTTP or HTTPS.', 'BLOCKED')
          // General pages such as Oracle's sign-in page can keep late resources
          // open after their document is interactive. Wait for the document to
          // be ready here; the employee wizard below has its own UI readiness
          // checks before execution advances.
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
          const oracleEmployeeWizard = isOracleHcmApplication(app) && /\/employment-addperson\/create\/employee\/?$/.test(target.pathname)
          if (oracleEmployeeWizard) {
            // Oracle Redwood finishes rendering after the document load event.
            // Don't advance the workflow while its employee wizard is still
            // an empty shell; wait for visible page content and the footer CTA.
            const pageReadyTimeoutMs = Math.min(45_000, Math.max(actionTimeoutMs, 30_000))
            const expectedPage = Promise.all([
              page.getByText('Hire an Employee', { exact: true }).first().waitFor({ state: 'visible', timeout: pageReadyTimeoutMs }),
              page.getByText('Info to include', { exact: true }).first().waitFor({ state: 'visible', timeout: pageReadyTimeoutMs }),
              page.getByRole('button', { name: 'Continue', exact: true }).first().waitFor({ state: 'visible', timeout: pageReadyTimeoutMs }),
            ]).then(() => 'ready').catch(() => 'timeout')
            const restActionError = page.getByText('Exception during RestAction', { exact: true }).first()
              .waitFor({ state: 'visible', timeout: pageReadyTimeoutMs }).then(() => 'rest-action-error').catch(() => 'timeout')
            const pageState = await Promise.race([expectedPage, restActionError])
            if (pageState === 'rest-action-error') throw new BrowserTestError('ORACLE_REST_ACTION_FAILED', 'Oracle displayed “Exception during RestAction” while loading the employee wizard. A required HCM REST action did not complete.', 'FAILED')
            if (pageState !== 'ready') throw new BrowserTestError('ORACLE_PAGE_LOAD_TIMEOUT', 'The employee wizard did not finish rendering: its heading, first section, or Continue button did not become visible.', 'FAILED')
          }
          if (remoteHttpError) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + remoteHttpError.status + '.', 'FAILED')
          actual = { url: safePageUrl(page) }
          expected = { url: action.url }
        } else if (action.action === 'click') {
          const clickTimeoutMs = isOracleHcmApplication(app)
            ? Math.max(actionTimeoutMs, 30_000)
            : actionTimeoutMs
          const isOracleSubmit = isOracleHcmApplication(app)
            && action.locator?.kind === 'role'
            && action.locator.role === 'button'
            && /^Submit$/i.test(action.locator.name || '')
            && isOracleEmployeeWizardPage(app, page.url())
          if (isOracleSubmit) {
            const submitReadyTimeout = Math.min(45_000, Math.max(actionTimeoutMs, 30_000))
            await waitForOracleReviewStep(page, submitReadyTimeout)
          }
          const locator = await uniqueActionLocator(page, action, clickTimeoutMs, testCase.test_data)
          const isOracleEmployeeNext = isOracleEmployeeWizardPage(app, page.url())
            && action.locator?.kind === 'role'
            && action.locator.role === 'button'
            && /^Next$/i.test(action.locator.name || '')
          if (isOracleEmployeeNext) {
            const legalEmployerIndex = plan.actions.findIndex((candidate) => candidate.action === 'fill' && candidate.dataKey === 'legal_employer')
            const firstNextIndex = legalEmployerIndex >= 0
              ? plan.actions.findIndex((candidate, idx) => idx > legalEmployerIndex && candidate.action === 'click' && /^Next$/i.test(candidate.locator?.name || ''))
              : -1
            const isLegalEmployerStepNext = firstNextIndex >= 0 && plan.actions[firstNextIndex] === action
            const legalEmployerAction = isLegalEmployerStepNext ? plan.actions[legalEmployerIndex] : null
            const legalEmployerValue = String(testCase.test_data.legal_employer ?? '').trim()
            if (legalEmployerAction && legalEmployerValue) {
              let legalEmployerLocator = await uniqueActionLocator(page, legalEmployerAction, 2000, testCase.test_data).catch(() => null)
              if (legalEmployerLocator) {
                let retainedValue = await readOracleFieldValue(legalEmployerLocator, actionTimeoutMs)
                if (retainedValue.trim() !== legalEmployerValue) {
                  try {
                    await fillOracleEmployeeComboboxField(page, legalEmployerLocator, legalEmployerAction, legalEmployerValue, actionTimeoutMs, testCase.test_data)
                    legalEmployerLocator = await uniqueActionLocator(page, legalEmployerAction, actionTimeoutMs, testCase.test_data).catch(() => legalEmployerLocator)
                    retainedValue = await readOracleFieldValue(legalEmployerLocator, actionTimeoutMs)
                  } catch {}
                }
                if (retainedValue.trim() !== legalEmployerValue) {
                  throw new BrowserTestError(
                    'ORACLE_FIELD_VALUE_CLEARED',
                    'Oracle cleared the Legal Employer value before Next. The workflow stopped without clicking Next; this required field will not accept typed text until an Oracle suggestion is committed.'
                  )
                }
              }
            }
          }
          if (isOracleSubmit) {
            const submitReadyTimeout = Math.min(45_000, Math.max(actionTimeoutMs, 30_000))
            const enabled = await waitForOracleSubmitEnabled(locator, submitReadyTimeout, throwIfCancelled)
            if (!enabled) {
              throw new BrowserTestError('ORACLE_SUBMIT_DISABLED', 'Oracle reached the final employee wizard step, but Submit is still disabled. Complete any required Assignment fields or resolve the page validation before submitting.', 'FAILED')
            }
          }
          if (action.postbackAuthorization) {
            const auth = action.postbackAuthorization
            if (!navOrigins.has(normalizeAllowedOrigin(auth.origin))) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The captured form postback origin is outside the selected registered application navigation scope.', 'BLOCKED')
            const form = await locator.evaluate((element) => {
              const owner = element.form || element.closest('form')
              if (!owner || owner.method.toUpperCase() !== 'POST') return null
              try { const target = new URL(owner.action, location.href); return { origin: target.origin, path: target.pathname } } catch { return null }
            })
            if (!form || form.origin !== auth.origin || form.path !== auth.path) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The captured form postback no longer matches its reviewed origin and path.', 'BLOCKED')
            const postbackTimeoutMs = Math.min(45_000, Math.max(actionTimeoutMs, 30_000))
            const postbackResponseWait = page.waitForResponse((response) => {
              const request = response.request()
              try {
                const target = new URL(response.url())
                return request.method() === 'POST' && target.origin === auth.origin && target.pathname === auth.path
              } catch { return false }
            }, { timeout: postbackTimeoutMs }).catch(() => null)
            activeWorkflowPostback = auth
            try {
              await locator.click({ timeout: actionTimeoutMs })
              const postbackResponse = await postbackResponseWait
              if (!postbackResponse) throw new BrowserTestError('WORKFLOW_POSTBACK_UNCONFIRMED', 'Oracle did not complete the reviewed form postback after the click. No retry was attempted.', 'FAILED')
              if (postbackResponse.status() >= 400) throw new BrowserTestError('WORKFLOW_POSTBACK_REJECTED', 'Oracle returned HTTP ' + postbackResponse.status() + ' for the reviewed form postback.', 'FAILED')
              pendingWorkflowPostback = auth
            } finally { activeWorkflowPostback = null }
          } else {
            try {
              await locator.click({ timeout: actionTimeoutMs })
            } catch (error) {
              // Oracle's Navigator tree can render a transparent overlay over
              // its tiny group-expander links. If the pointer click is blocked,
              // activate that specific menu link from the keyboard instead.
              const isOracleGroupExpander = isOracleHcmApplication(app)
                && action.locator?.kind === 'role'
                && action.locator.role === 'link'
                && /^Expand (?:My Client Groups|Me)$/i.test(action.locator.name || '')
                && /\/fscmUI\/faces\/AtkHomePageWelcome\/?$/i.test(new URL(page.url()).pathname)
              if (!isOracleGroupExpander || !/Timeout|intercepts pointer events|detached from the DOM/i.test(String(error?.message || error))) throw error
              await locator.focus({ timeout: actionTimeoutMs })
              await locator.press('Enter', { timeout: actionTimeoutMs })
            }
          }
          if (isOracleEmployeeNext) {
            await waitForOracleAdfSynchronized(page, Math.min(45_000, Math.max(actionTimeoutMs, 30_000)))
            const nextAction = plan.actions[actionIndex + 1]
            if (nextAction) {
              const isNextAgain = nextAction.action === 'click' && /^Next$/i.test(nextAction.locator?.name || '')
              const isSubmitNext = ['create', 'update', 'click'].includes(nextAction.action) && /^Submit$/i.test(nextAction.locator?.name || '')
              if (isNextAgain || isSubmitNext) {
                await page.waitForTimeout(1000)
                await waitForOracleAdfSynchronized(page, 15_000)
                if (isSubmitNext) {
                  await waitForOracleReviewStep(page, Math.min(45_000, Math.max(actionTimeoutMs, 30_000)))
                }
              }
            }
          }
          const nextAction = plan.actions[actionIndex + 1]
          const isOracleHireEmployeeClick = isOracleHcmApplication(app)
            && action.locator?.kind === 'role'
            && action.locator.role === 'button'
            && /^Hire an Employee$/i.test(action.locator.name || '')
          if (isOracleHireEmployeeClick) {
            await waitForOracleEmployeeFormReady(page, nextAction, actionTimeoutMs, testCase.test_data)
          }
          const isOracleWizardContinue = isOracleEmployeeWizardPage(app, page.url())
            && action.locator?.kind === 'role'
            && action.locator.role === 'button'
            && action.locator.name === 'Continue'
            && /\/employment-addperson\/create\/employee\/?$/i.test(new URL(page.url()).pathname)
          if (isOracleWizardContinue && nextAction && ['fill', 'select'].includes(nextAction.action)) {
            // Redwood changes wizard sections asynchronously after Continue.
            // Wait for the next captured field itself, not just the button
            // click or document load, before advancing the workflow.
            const nextFieldTimeoutMs = Math.min(45_000, Math.max(actionTimeoutMs, 30_000))
            try {
              await uniqueActionLocator(page, nextAction, nextFieldTimeoutMs, testCase.test_data)
            } catch (error) {
              if (error.code === 'LOCATOR_NOT_FOUND') throw new BrowserTestError('ORACLE_PAGE_LOAD_TIMEOUT', 'Oracle advanced the wizard after Continue, but the next field did not finish loading.', 'FAILED')
              throw error
            }
          } else if (isOracleWizardContinue && nextAction?.action === 'click'
            && nextAction.locator?.kind === 'role'
            && nextAction.locator.role === 'button'
            && nextAction.locator.name === 'Submit') {
            // The last Continue transitions from Personal details to Assignment.
            // A successful click only confirms the footer received the click;
            // Redwood can still be rendering the next wizard section.
            const nextPageTimeoutMs = Math.min(45_000, Math.max(actionTimeoutMs, 30_000))
            try {
              await page.getByRole('heading', { name: 'Assignment', exact: true })
                .waitFor({ state: 'visible', timeout: nextPageTimeoutMs })
            } catch {
              throw new BrowserTestError('ORACLE_PAGE_LOAD_TIMEOUT', 'Oracle accepted Continue, but the Assignment page did not finish loading.', 'FAILED')
            }
          }
          if (action.manualLoginSubmit === true) {
            await page.locator('input[type="password"]:visible').waitFor({ state: 'hidden', timeout: actionTimeoutMs }).catch(() => {})
            if (await page.locator('input[type="password"]:visible').count().catch(() => 0)) throw new BrowserTestError('AUTHENTICATION_FAILED', 'The application still shows its password prompt after the captured login submission.')
            manualAuthActive = false
          }
          actual = 'Element clicked.'
          expected = locatorDescription(action.locator)
        } else if (['create', 'update', 'delete'].includes(action.action)) {
          const writeTimeoutMs = isOracleHcmApplication(app)
            ? Math.max(actionTimeoutMs, 45_000)
            : actionTimeoutMs
          const isOracleSubmit = isOracleHcmApplication(app)
            && /^Submit$/i.test(action.locator?.name || '')
            && isOracleEmployeeWizardPage(app, page.url())
          if (isOracleSubmit) {
            await waitForOracleReviewStep(page, writeTimeoutMs)
          }
          const locator = await uniqueActionLocator(page, action, writeTimeoutMs, testCase.test_data)
          if (isOracleSubmit) {
            const enabled = await waitForOracleSubmitEnabled(locator, writeTimeoutMs, throwIfCancelled)
            if (!enabled) {
              throw new BrowserTestError('ORACLE_SUBMIT_DISABLED', 'Oracle reached the final employee wizard step, but Submit is still disabled. Complete any required Assignment fields or resolve the page validation before submitting.', 'FAILED')
            }
          }
          const form = await locator.evaluate((element) => {
            const owner = element.form || element.closest('form')
            if (!owner || owner.method.toUpperCase() !== 'POST') return null
            try {
              const target = new URL(owner.action, location.href)
              return { origin: target.origin, path: target.pathname }
            } catch { return null }
          })
          if (!form || (action.writeAuthorization ? action.writeAuthorization.origin !== form.origin : form.origin !== appUrl.origin)) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The approved write control must submit a POST form to the exact origin recorded in the selected reviewed workflow.', 'BLOCKED')
          if (action.writeAuthorization && (action.writeAuthorization.origin !== appUrl.origin || action.writeAuthorization.path !== form.path || action.writeAuthorization.operation !== action.action || action.writeAuthorization.method !== 'POST')) throw new BrowserTestError('WRITE_SCOPE_INVALID', 'The captured write form no longer matches its reviewed registered application path.', 'BLOCKED')
          activeWriteAuthorization = { operation: action.action, origin: appUrl.origin, path: form.path }
          let writeResponse
          const responseWait = page.waitForResponse((response) => {
            const request = response.request()
            try {
              const target = new URL(response.url())
              return request.method() === 'POST' && target.origin === activeWriteAuthorization?.origin && target.pathname === activeWriteAuthorization?.path
            } catch { return false }
          }, { timeout: Math.min(60_000, Math.max(writeTimeoutMs, 30_000)) }).catch(() => null)
          try {
            await locator.click({ timeout: writeTimeoutMs })
            writeResponse = await responseWait
          } finally {
            activeWriteAuthorization = null
          }
          if (!writeResponse) throw new BrowserTestError('WRITE_RESPONSE_UNCONFIRMED', 'The approved form did not return a matching response. The outcome is uncertain; no retry was attempted.', 'FAILED')
          if (writeResponse.status() >= 400) throw new BrowserTestError('APPLICATION_WRITE_REJECTED', 'The application returned HTTP ' + writeResponse.status() + ' for the approved form submission.', 'FAILED')
          actual = 'Approved ' + action.action + ' form returned HTTP ' + writeResponse.status() + '; the application result still requires assertion.'
          expected = { operation: action.action, formPath: form.path, verifiedByFollowingAssertion: true }
        } else if (action.action === 'fill') {
          const value = String(testCase.test_data[action.dataKey] ?? '')
          if (!value) actual = 'Optional field is blank; fill action skipped.'
          else {
            const locatorTimeoutMs = fieldLocatorTimeout(page, app, actionTimeoutMs)
            const locator = await uniqueActionLocator(page, action, locatorTimeoutMs, testCase.test_data)
            let searchPostback = null
            if (action.dataKey === 'search' && pendingWorkflowPostback) {
              try {
                const current = new URL(page.url())
                if (normalizeAllowedOrigin(current.origin) === pendingWorkflowPostback.origin && current.pathname === pendingWorkflowPostback.path) searchPostback = pendingWorkflowPostback
              } catch {}
            }
            if (searchPostback) activeWorkflowPostback = searchPostback
            try {
              const isOracleEmployeeCombobox = isOracleEmployeeWizardPage(app, page.url())
                && (['legal_employer', 'business_unit'].includes(action.dataKey) || action.locator?.role === 'combobox')
              if (isOracleEmployeeCombobox) {
                await fillOracleEmployeeComboboxField(page, locator, action, value, locatorTimeoutMs, testCase.test_data)
              } else {
                await locator.fill(value, { timeout: locatorTimeoutMs })
                await blurFilledField(locator, locatorTimeoutMs)
                await page.waitForTimeout(CSV_FIELD_SETTLE_MS)
              }
              if (searchPostback) await page.waitForTimeout(250)
            } finally {
              if (searchPostback) activeWorkflowPostback = null
            }
            actual = 'Field filled; submitted data is not recorded.'
            expected = { locator: locatorDescription(action.locator), value: '[test data reference]' }
          }
        } else if (action.action === 'select') {
          const value = action.optionLabel !== undefined ? String(action.optionLabel) : String(testCase.test_data[action.dataKey] ?? '')
          if (!value) actual = 'Optional field is blank; select action skipped.'
          else {
            const locatorTimeoutMs = fieldLocatorTimeout(page, app, actionTimeoutMs)
            const locator = await uniqueActionLocator(page, action, locatorTimeoutMs, testCase.test_data)
            if (action.optionLabel) {
              const tag = await locator.evaluate((element) => element.tagName.toLowerCase())
              if (tag === 'select') await locator.selectOption({ label: action.optionLabel }, { timeout: locatorTimeoutMs })
              else await selectWorkflowOption(page, locator, String(action.optionLabel), locatorTimeoutMs)
            } else await selectWorkflowOption(page, locator, value, locatorTimeoutMs)
            actual = 'Option selected; submitted data is not recorded.'
            expected = { locator: locatorDescription(action.locator), value: '[test data reference]' }
          }
        } else if (action.action === 'check' || action.action === 'uncheck') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator[action.action]({ timeout: actionTimeoutMs })
          actual = action.action === 'check' ? 'Checkbox checked.' : 'Checkbox unchecked.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'wait_visible') {
          const waitTimeout = Math.max(actionTimeoutMs, Number(action.timeoutMs) || 0)
          const locator = await uniqueActionLocator(page, action, waitTimeout, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: waitTimeout })
          actual = 'Element became visible.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'read_text') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: actionTimeoutMs })
          actual = safeText(await locator.innerText({ timeout: actionTimeoutMs }), testCase.test_data)
          expected = { resultKey: action.resultKey }
        } else if (action.action === 'assert_visible') {
          const assertTimeout = isOracleHcmApplication(app)
            ? Math.max(actionTimeoutMs, 30_000)
            : actionTimeoutMs
          const locator = await uniqueActionLocator(page, action, assertTimeout, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: assertTimeout })
          actual = 'Element is visible.'
          expected = locatorDescription(action.locator)
        } else if (action.action === 'assert_text') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: actionTimeoutMs })
          const observed = safeText(await locator.innerText({ timeout: actionTimeoutMs }), testCase.test_data)
          if (!observed.includes(action.expected)) throw new BrowserTestError('ASSERTION_FAILED', 'Visible text did not contain the expected text "' + action.expected + '".')
          actual = observed
          expected = { contains: action.expected }
        } else if (action.action === 'assert_url') {
          const observed = safePageUrl(page)
          const passed = action.operator === 'equals' ? new URL(page.url()).pathname === action.expected : new URL(page.url()).pathname.includes(action.expected)
          if (!passed) throw new BrowserTestError('ASSERTION_FAILED', 'URL ' + action.operator + ' "' + action.expected + '" — actual path was: ' + new URL(page.url()).pathname)
          actual = observed
          expected = { [action.operator]: action.expected }
        } else if (action.action === 'assert_value') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          await locator.waitFor({ state: 'visible', timeout: actionTimeoutMs })
          const observedValue = await locator.inputValue({ timeout: actionTimeoutMs }).catch(() => locator.innerText({ timeout: actionTimeoutMs }))
          const expectedValue = String(testCase.test_data[action.dataKey])
          if (observedValue !== expectedValue) throw new BrowserTestError('ASSERTION_FAILED', 'Field value did not match the expected test data value.')
          actual = 'Field value matches.'
          expected = { dataKey: action.dataKey }
        } else if (action.action === 'assert_count_gt') {
          const locator = await uniqueActionLocator(page, action, actionTimeoutMs, testCase.test_data)
          const count = await locator.count()
          if (count <= action.threshold) throw new BrowserTestError('ASSERTION_FAILED', 'Element count was ' + count + ', expected greater than ' + action.threshold + '.')
          actual = 'Count: ' + count
          expected = { greaterThan: action.threshold }
        } else {
          throw new BrowserTestError('UNSUPPORTED_ACTION', 'The saved plan contains an unsupported action: "' + action.action + '".', 'BLOCKED')
        }
        if (policyBlock) throw new BrowserTestError(policyBlock.code, 'A request was stopped by the registered application security policy.', 'BLOCKED')
        if (remoteHttpError) throw new BrowserTestError('REMOTE_HTTP_ERROR', 'The registered application returned HTTP ' + remoteHttpError.status + '.', 'FAILED')
        const completedAt = new Date()
        const result = { executionId: runId, stepNumber, action: action.action, status: 'PASSED', expected, actual, startedAt: stepStarted, completedAt, durationMs: Date.now() - stepStartedMs }
        await persistBrowserTestStepResult(result)
        stepResults.push(result)
        if (action.action.startsWith('assert_') && safeRecording) {
          const screenshot = await page.screenshot({ fullPage: false })
          await saveArtifact({ executionId: runId, kind: 'screenshot', bytes: screenshot, contentType: 'image/png', outputDirectory, artifactBase })
        }
      } catch (error) {
        const status = control.cancelled ? 'SKIPPED' : error instanceof BrowserTestError ? error.status : policyBlock ? 'BLOCKED' : 'FAILED'
        const code = control.cancelled ? 'USER_CANCELLED' : error instanceof BrowserTestError ? error.code : policyBlock?.code || (String(error?.message || '').toLowerCase().includes('timeout') ? 'ACTION_TIMEOUT' : 'ACTION_FAILED')
        const details = control.cancelled ? 'Execution was cancelled by the user. The in-flight action outcome may be uncertain; no retry was attempted.' : safeText(error instanceof BrowserTestError ? error.message : 'Browser action failed: ' + (error?.message || 'Unknown error.'), testCase.test_data)
        const completedAt = new Date()
        const result = { executionId: runId, stepNumber, action: action.action, status, expected, actual, errorCode: code, errorDetails: details, startedAt: stepStarted, completedAt, durationMs: Date.now() - stepStartedMs }
        await persistBrowserTestStepResult(result).catch(() => {})
        stepResults.push(result)
        if (options.captureScreenshotsOnFailure !== false && options.recordArtifacts !== false && page && app.application_auth_method !== 'manual') {
          if (recordingPolicy !== 'show-all-values') await maskInputsForScreenshot(page)
          const screenshot = await page.screenshot({ fullPage: false }).catch(() => null)
          if (screenshot) await saveArtifact({ executionId: runId, kind: 'screenshot', bytes: screenshot, contentType: 'image/png', outputDirectory, artifactBase }).catch(() => {})
        }
        throw new BrowserTestError(code, details, control.cancelled ? 'CANCELLED' : status)
      }
    }

    if (traceStarted) {
      if (traceSensitive) await context.tracing.stop()
      else {
        tracePath = resolve(outputDirectory, 'trace-' + randomUUID() + '.zip')
        await context.tracing.stop({ path: tracePath })
      }
      traceStarted = false
    }
    await context.close()
    context = null
    if (safeRecording && page.video()) {
      videoPath = await page.video().path().catch(() => null)
      if (videoPath) {
        await saveArtifact({ executionId: runId, kind: 'video', sourcePath: videoPath, contentType: 'video/webm', outputDirectory, artifactBase })
        videoPersisted = true
        videoStatus = 'AVAILABLE'
      }
    }
    if (tracePath) await persistBrowserTestArtifact({ id: 'bta-' + randomUUID(), executionId: runId, kind: 'trace', relativePath: relative(artifactBase, tracePath).split(sep).join('/'), contentType: 'application/zip', sizeBytes: (await stat(tracePath)).size })
      await updateBrowserTestExecution(runId, { status: 'PASSED', actualOutcome: 'All browser observations and assertions passed.', policyWarnings, diagnostics, videoStatus, videoError, completedAt: new Date(), durationMs: Date.now() - startedMs, errorCode: null, errorDetails: null })
  } catch (error) {
    const status = control.cancelled ? 'CANCELLED' : error instanceof BrowserTestError ? error.status : policyBlock ? 'BLOCKED' : 'FAILED'
    const code = control.cancelled ? 'USER_CANCELLED' : error instanceof BrowserTestError ? error.code : policyBlock?.code || 'EXECUTION_INFRASTRUCTURE_ERROR'
    const details = control.cancelled ? 'Execution was cancelled by the user. The in-flight action outcome may be uncertain; no retry was attempted.' : safeText(error instanceof BrowserTestError ? error.message : 'Browser execution failed: ' + (error?.message || 'Unknown error.'))
    if (traceStarted && context) {
      if (traceSensitive) await context.tracing.stop().catch(() => {})
      else {
        tracePath = resolve(outputDirectory, 'trace-' + randomUUID() + '.zip')
        await context.tracing.stop({ path: tracePath }).catch(() => {})
        const info = await stat(tracePath).catch(() => null)
        if (info) await persistBrowserTestArtifact({ id: 'bta-' + randomUUID(), executionId: executionId.id, kind: 'trace', relativePath: relative(artifactBase, tracePath).split(sep).join('/'), contentType: 'application/zip', sizeBytes: info.size }).catch(() => {})
      }
    }
    const fallbackStart = stepResults.length ? startedAt : null
    await updateBrowserTestExecution(executionId.id, {
      status,
      actualOutcome: status === 'CANCELLED' ? details : stepResults.length ? 'Execution stopped after ' + stepResults.length + ' completed steps.' : null,
      policyWarnings,
      diagnostics,
      errorCode: code,
      errorDetails: details,
      ...(fallbackStart ? { startedAt: fallbackStart } : {}),
      videoStatus,
      videoError,
      completedAt: new Date(),
      durationMs: Date.now() - startedMs,
    }).catch(() => {})
  } finally {
    if (!shouldRunHeadless && page) { await page.waitForTimeout(2500).catch(() => {}) }
    if (page) await page.close().catch(() => {})
    if (context) await context.close().catch(() => {})
    if (!videoPersisted && page?.video() && outputDirectory) videoPath = await page.video().path().catch(() => null)
    if (browser) await browser.close().catch(() => {})
    if (videoPath && !videoPersisted && outputDirectory) {
      try {
        await saveArtifact({ executionId: executionId.id, kind: 'video', sourcePath: videoPath, contentType: 'video/webm', outputDirectory, artifactBase })
        videoPersisted = true
        videoStatus = 'AVAILABLE'
      } catch {
        videoStatus = 'FAILED'
        videoError = 'The browser video could not be finalized or saved.'
      }
    }
    if (recordVideoRequested && safeRecording && !videoPersisted && videoStatus === 'PENDING') {
      videoStatus = 'FAILED'
      videoError = 'The browser did not produce a finalized video file.'
    }
    await updateBrowserTestExecution(runId, { videoStatus, videoError }).catch(() => {})
    if (proxy) await proxy.close().catch(() => {})
    cancellationControls.delete(runId)
  }
}

export async function startBrowserTestExecution(execution) {
  const task = { id: execution.id, caseId: execution.case_id, approvedInteractions: execution.approved_interactions }
  const executionOptions = execution.execution_options && typeof execution.execution_options === 'object' ? execution.execution_options : {}
  const control = { cancelled: false, page: null }
  cancellationControls.set(execution.id, control)
  setImmediate(() => { executeBrowserTest(task, { control, ...executionOptions }).catch(() => {}) })
}

export async function waitForBrowserTestLogin(executionId) {
  return resumeBrowserTestAfterLogin(executionId)
}
