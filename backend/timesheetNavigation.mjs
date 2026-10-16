export function pathMatches(url, paths) {
  try {
    const pathname = new URL(url).pathname
    return paths.some((path) => pathname.startsWith(path))
  } catch {
    return false
  }
}

export function gridEvidenceFromHtml(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  const structuralGrids = (text.match(/<table\b|role=["']grid["']/gi) || []).length
  const dateHeaders = (text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b|\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/gi) || []).length
  const projectRowMarkers = (text.match(/>\s*(?:delete|remove)\s*</gi) || []).length
  const projectRows = projectRowMarkers || (text.match(/project|client|task|description/gi) || []).length
  const numericCells = (text.match(/>\s*\d+(?:\.\d+)?\s*</g) || []).length
  const hourCells = (text.match(/type=["'](?:number|text)["']|hours?|work.?hours?/gi) || []).length + numericCells
  const disabledCells = (text.match(/disabled|readonly|leave|holiday/gi) || []).length
  const isWeeklyTimesheet = /weekly\s+timesheet/i.test(text)
  const grids = structuralGrids || (isWeeklyTimesheet && dateHeaders >= 7 && projectRows > 0 && hourCells > 0 ? 1 : 0)
  return { grids, dateHeaders, projectRows, hourCells, disabledCells }
}

export function gridIsAccessible(evidence) {
  return evidence.grids > 0 && evidence.dateHeaders > 0 && evidence.projectRows > 0 && evidence.hourCells > 0
}

export async function findTimesheetControl(page, menuSelector = '#t_Button_navControl') {
  const menu = page.locator(`${menuSelector}, #t_Button_navControl, [aria-label*="navigation" i], [title*="navigation" i], .t-Button--navControl`).first()
  if (await menu.isVisible().catch(() => false)) {
    await menu.evaluate((element) => element.click()).catch(() => {})
  }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const candidates = page.locator('a, button')
    const count = await candidates.count()
    const matches = []
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index)
      if (!(await candidate.isVisible().catch(() => false))) continue
      const text = (await candidate.innerText().catch(() => '')).trim()
      const href = await candidate.getAttribute('href').catch(() => null)
      const normalizedText = text.replace(/\s+/g, ' ')
      const hasObservedTimesheetRoute = /\/home1(?:[/?#]|$)|\/my-timesheet(?:[/?#]|$)/i.test(href || '')
      const hasTimesheetLabel = /my\s*timesheet/i.test(normalizedText)
      const isBrand = /^timesheet application$/i.test(normalizedText)
      if ((hasObservedTimesheetRoute || hasTimesheetLabel) && !isBrand) {
        matches.push({
          candidate,
          priority: hasObservedTimesheetRoute ? 0 : 1,
        })
      }
    }
    if (matches.length) {
      matches.sort((left, right) => left.priority - right.priority)
      return matches[0].candidate
    }
    await page.waitForTimeout(200)
  }
  return null
}

export async function waitForTimesheetGrid(page, timeout = 15_000, interval = 100) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const evidence = await page.locator('body').evaluate((body) => {
      const html = body.innerHTML
      const text = body.innerText
      const dateHeaders = (text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b|\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/gi) || []).length
      const projectRowMarkers = Array.from(body.querySelectorAll('button, a')).filter((element) => /^\s*(?:delete|remove)\s*$/i.test(element.textContent || '')).length
      const tableRows = Array.from(body.querySelectorAll('table tbody tr')).filter((row) => !/daily\s+total|weekly\s+total|total\s+hours/i.test(row.textContent || '')).length
      const projectRows = projectRowMarkers || tableRows || (text.match(/project|client|task|description/gi) || []).length
      const hourInputs = body.querySelectorAll('input:not([type="hidden"]), [data-hour], [class*="hour" i], [contenteditable="true"]').length
      const numericCells = Array.from(body.querySelectorAll('*')).filter((element) => {
        if (element.children.length || /SCRIPT|STYLE|NOSCRIPT/.test(element.tagName)) return false
        return /^\d+(?:\.\d+)?$/.test((element.textContent || '').trim())
      }).length
      const hourCells = hourInputs + numericCells
      const isWeeklyTimesheet = /weekly\s+timesheet/i.test(text)
      return {
        grids: body.querySelectorAll('table, [role="grid"]').length || (isWeeklyTimesheet && dateHeaders >= 7 && projectRows > 0 && hourCells > 0 ? 1 : 0),
        dateHeaders,
        projectRows,
        hourCells,
        disabledCells: body.querySelectorAll(':disabled, [readonly], [aria-disabled="true"]').length + (html.match(/leave|holiday/gi) || []).length,
      }
    }).catch(() => null)
    if (evidence && gridIsAccessible(evidence)) return evidence
    await page.waitForTimeout(interval)
  }
  return null
}
