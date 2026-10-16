import assert from 'node:assert/strict'
import test from 'node:test'
import { extractTimesheet, normalizeTimesheetSnapshot, parseDateLabel } from './timesheetExtraction.mjs'

const dates = ['MON 12-Oct-2026', 'TUE 13-Oct-2026', 'WED 14-Oct-2026', 'THU 15-Oct-2026', 'FRI 16-Oct-2026', 'SAT 17-Oct-2026', 'SUN 18-Oct-2026']

function snapshot(rows = 3) {
  return {
    dates: dates.map((label) => ({ label, date: parseDateLabel(label) })),
    rows: Array.from({ length: rows }, (_, index) => ({
      project_id: `p-${index + 1}`,
      project_name: ['cloud spm', 'zoho application', 'project R'][index] || `project ${index + 1}`,
      cells: dates.map((_, day) => ({ raw_value: day === 0 ? '0' : String(index + day), disabled: false, leave: false })),
    })),
  }
}

test('extracts three project rows dynamically', () => {
  const result = normalizeTimesheetSnapshot(snapshot(3))
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.projects.length, 3)
  assert.deepEqual(result.projects.map((project) => project.project_name), ['cloud spm', 'zoho application', 'project R'])
})

test('handles a different number of project rows', () => {
  const result = normalizeTimesheetSnapshot(snapshot(2))
  assert.equal(result.projects.length, 2)
  assert.equal(result.diagnostics.project_rows_detected, 2)
})

test('maps date headers and week boundaries', () => {
  const result = normalizeTimesheetSnapshot(snapshot(3))
  assert.equal(result.week.start_date, '2026-10-12')
  assert.equal(result.week.end_date, '2026-10-18')
  assert.equal(result.projects[0].days[0].date, '2026-10-12')
})

test('parses numeric hours and preserves explicit zero', () => {
  const result = normalizeTimesheetSnapshot(snapshot(1))
  assert.equal(result.projects[0].days[0].hours, 0)
  assert.equal(result.projects[0].days[0].hours_status, 'READ')
  const decimal = normalizeTimesheetSnapshot({
    dates: [{ label: dates[0], date: '2026-10-12' }],
    rows: [{ project_name: 'p', cells: [{ raw_value: '1.5' }] }],
  })
  assert.equal(decimal.projects[0].days[0].hours, 1.5)
})

test('distinguishes empty, unavailable, disabled and leave cells', () => {
  const result = normalizeTimesheetSnapshot({
    dates: [{ label: dates[0], date: '2026-10-12' }, { label: dates[1], date: '2026-10-13' }, { label: dates[2], date: '2026-10-14' }, { label: dates[3], date: '2026-10-15' }, { label: dates[4], date: '2026-10-16' }, { label: dates[5], date: '2026-10-17' }, { label: dates[6], date: '2026-10-18' }],
    rows: [{ project_name: 'p', cells: [
      { raw_value: '', disabled: false },
      null,
      { raw_value: '0', disabled: true },
      { raw_value: 'L', disabled: true, leave: true },
      { raw_value: '2' },
      { raw_value: 'bad' },
      { raw_value: '25' },
    ] }],
  })
  const statuses = result.projects[0].days.map((day) => day.hours_status)
  assert.deepEqual(statuses, ['EMPTY', 'UNAVAILABLE', 'DISABLED', 'LEAVE', 'READ', 'AMBIGUOUS', 'AMBIGUOUS'])
  assert.equal(result.status, 'PARTIAL')
})

test('warns about missing and duplicate date headers', () => {
  const result = normalizeTimesheetSnapshot({
    dates: [{ label: dates[0], date: '2026-10-12' }, { label: dates[0], date: '2026-10-12' }],
    rows: [],
  })
  assert.equal(result.status, 'FAILED')
  assert.ok(result.diagnostics.warnings.some((warning) => /duplicate/i.test(warning)))
  assert.ok(result.diagnostics.warnings.some((warning) => /usual weekly count/i.test(warning)))
})

test('extracts project rows and visible inputs from a mock APEX page', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div class="header" style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label.replace('-', ' ')}</div>`).join('')
  const rows = ['cloud spm', 'zoho application', 'project R'].map((name, row) => `
    <div class="project-row" style="position:absolute;left:0;top:${100 + row * 60}px">
      <span>${name}</span><button>Delete</button>
      ${dates.map((_, index) => `<input style="position:absolute;left:${120 + index * 100}px;width:40px" value="${index === 0 ? '0' : row + index}">`).join('')}
    </div>
  `).join('')
  await page.setContent(`<main><h2>Weekly Timesheet</h2>${headers}${rows}</main>`)
  const result = await extractTimesheet(page)
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.projects.length, 3)
  assert.equal(result.projects[0].days[0].hours, 0)
  await browser.close()
})

test('extracts the authoritative daily total row', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label}</div>`).join('')
  const rows = ['cloud spm', 'zoho application', 'project R'].map((name, row) => `
    <div class="project-row" style="position:absolute;left:0;top:${100 + row * 60}px">
      <span>${name}</span><button>Delete</button>
      ${dates.map((_, index) => `<input style="position:absolute;left:${120 + index * 100}px;width:40px" value="${row === 0 && index === 3 ? '6' : '0'}">`).join('')}
    </div>
  `).join('')
  const totals = dates.map((_, index) => `<td style="position:absolute;left:${120 + index * 100}px;width:80px">${index === 3 ? '6' : '0'}</td>`).join('')
  await page.setContent(`<main>${headers}${rows}<table><tr><td>Daily Total</td>${totals}</tr></table></main>`)
  const result = await extractTimesheet(page)
  assert.equal(result.daily_totals.find((total) => total.date === '2026-10-15')?.hours, 6)
  await browser.close()
})

test('keeps project names and hours isolated to their own rows', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label}</div>`).join('')
  const rows = [['cloud', 'spm', '2'], ['zoho', 'application', '4'], ['project', 'R', '6']].map(([first, second, value], row) => `
    <div class="project-row" style="position:absolute;left:0;top:${100 + row * 60}px">
      <span>${first}</span><span>${second}</span><button>Delete</button>
      ${dates.map((_, index) => `<input style="position:absolute;left:${120 + index * 100}px;width:40px" value="${index === 0 ? value : '0'}">`).join('')}
    </div>
  `).join('')
  await page.setContent(`<main><div>Project</div><h2>Weekly Timesheet</h2>${headers}${rows}</main>`)
  const result = await extractTimesheet(page)
  assert.equal(result.status, 'SUCCESS')
  assert.deepEqual(result.projects.map((project) => project.project_name), ['cloud spm', 'zoho application', 'project R'])
  assert.deepEqual(result.projects.map((project) => project.days[0].hours), [2, 4, 6])
  await browser.close()
})

test('recognizes nested and value-based delete controls', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label}</div>`).join('')
  const rows = ['cloud spm', 'zoho application', 'project R'].map((name, row) => `
    <div class="project-row" style="position:absolute;left:0;top:${100 + row * 60}px">
      <span>${name}</span><button><span>Delete</span></button>
      ${dates.map((_, index) => `<input style="position:absolute;left:${120 + index * 100}px;width:40px" value="${row + index}">`).join('')}
    </div>
  `).join('')
  await page.setContent(`<main><h2>Weekly Timesheet</h2>${headers}${rows}<input type="button" value="Remove"></main>`)
  const result = await extractTimesheet(page)
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.projects.length, 3)
  assert.deepEqual(result.projects.map((project) => project.project_name), ['cloud spm', 'zoho application', 'project R'])
  await browser.close()
})

test('extracts rows when the grid has no detectable delete controls', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label}</div>`).join('')
  const rows = ['cloud spm', 'zoho application', 'project R'].map((name, row) => `
    <div class="project-row" style="position:absolute;left:0;top:${100 + row * 60}px">
      <span>${name}</span>
      ${dates.map((_, index) => `<input style="position:absolute;left:${120 + index * 100}px;width:40px" value="${row + index}">`).join('')}
    </div>
  `).join('')
  await page.setContent(`<main><h2>Weekly Timesheet</h2>${headers}${rows}</main>`)
  const result = await extractTimesheet(page)
  assert.equal(result.status, 'SUCCESS')
  assert.deepEqual(result.projects.map((project) => project.project_name), ['cloud spm', 'zoho application', 'project R'])
  assert.deepEqual(result.projects.map((project) => project.days[0].hours), [0, 1, 2])
  await browser.close()
})

test('extracts rendered text cells when inputs and delete controls are absent', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label}</div>`).join('')
  const rows = [['cloud spm', '2'], ['zoho application', '4'], ['project R', '6']].map(([name, value], row) => `
    <div style="position:absolute;left:0;top:${100 + row * 60}px">${name}
      ${dates.map((_, index) => `<span style="position:absolute;left:${120 + index * 100}px;top:0;width:40px">${index === 2 ? 'L' : index === 0 ? value : '0'}</span>`).join('')}
    </div>
  `).join('')
  await page.setContent(`<main><h2>Weekly Timesheet</h2>${headers}${rows}</main>`)
  const result = await extractTimesheet(page)
  assert.equal(result.status, 'SUCCESS')
  assert.deepEqual(result.projects.map((project) => project.project_name), ['cloud spm', 'zoho application', 'project R'])
  assert.deepEqual(result.projects.map((project) => project.days[0].hours), [2, 4, 6])
  await browser.close()
})

test('does not report controls or total rows as projects', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label}</div>`).join('')
  const row = (name, value, top) => `<div style="position:absolute;left:0;top:${top}px">${name}<button>Delete</button>${dates.map((_, index) => `<span style="position:absolute;left:${120 + index * 100}px;top:0;width:40px">${index === 0 ? value : '0'}</span>`).join('')}</div>`
  await page.setContent(`<main><h2>Weekly Timesheet</h2>${headers}${row('cloud spm', '2', 100)}${row('zoho application', '0', 160)}${row('project R', '3', 220)}${row('Daily Total', '5', 280)}</main>`)
  const result = await extractTimesheet(page)
  assert.equal(result.projects.length, 3)
  assert.deepEqual(result.projects.map((project) => project.project_name), ['cloud spm', 'zoho application', 'project R'])
  await browser.close()
})

test('does not report an application shell as a project row', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const headers = dates.map((label, index) => `<div style="position:absolute;left:${120 + index * 100}px;top:20px;width:80px">${label}</div>`).join('')
  const row = `<div style="position:absolute;left:0;top:100px">zoho application<button>Delete</button>${dates.map((_, index) => `<span style="position:absolute;left:${120 + index * 100}px;top:0;width:40px">0</span>`).join('')}</div>`
  const shell = `<div style="position:absolute;left:0;top:500px">Skip to Main Content application Home Leave Management Weekly Timesheet Save Timesheet Daily Total Release 1.0${dates.map((_, index) => `<span style="position:absolute;left:${120 + index * 100}px;top:0;width:40px">0</span>`).join('')}</div>`
  await page.setContent(`<main><h2>Weekly Timesheet</h2>${headers}${row}${shell}</main>`)
  const result = await extractTimesheet(page)
  assert.deepEqual(result.projects.map((project) => project.project_name), ['zoho application'])
  await browser.close()
})
