const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
])

const WEEKDAY = /^(sun|mon|tue|wed|thu|fri|sat)(?:day)?$/i

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function isNonProjectLabel(value) {
  const normalized = clean(value)
  return !normalized
    || /^(?:project|delete|remove|daily total|weekly total|total hours|timesheet|weekly timesheet|save timesheet)$/i.test(normalized)
    || /(?:daily total|weekly total|total hours|skip to main content|save timesheet|release \d)/i.test(normalized)
    || /^(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+\d{1,2}/i.test(normalized)
    || /^(?:L|\d+(?:[.,]\d+)?)$/i.test(normalized)
}

function isoDate(day, month, year) {
  if (!day || !month || !year) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

export function parseDateLabel(label, fallbackYear = null) {
  const value = clean(label)
  const match = value.match(/(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+(\d{1,2})[-/. ]([A-Za-z]{3,9}|\d{1,2})(?:[-/. ](\d{2,4}))?/i)
  if (!match) return null
  const day = Number(match[1])
  const month = /^\d+$/.test(match[2]) ? Number(match[2]) : MONTHS.get(match[2].slice(0, 3).toLowerCase())
  const parsedYear = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : fallbackYear
  return isoDate(day, month, parsedYear)
}

function parseHours(raw) {
  const value = clean(raw)
  if (value === '') return { hours: null, hours_status: 'EMPTY', raw_value: '' }
  const match = value.match(/^-?\d+(?:[.,]\d+)?$/)
  if (!match) return { hours: null, hours_status: 'AMBIGUOUS', raw_value: value }
  const hours = Number(match[0].replace(',', '.'))
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    return { hours: null, hours_status: 'AMBIGUOUS', raw_value: value }
  }
  return { hours, hours_status: 'READ', raw_value: value }
}

export function normalizeTimesheetSnapshot(snapshot) {
  const warnings = []
  const dates = (snapshot?.dates || []).map((date) => ({
    label: clean(date.label),
    date: date.date || null,
  }))
  const validDates = dates.filter((date) => date.date)
  const dateKeys = validDates.map((date) => date.date)
  const duplicateDates = dateKeys.filter((date, index) => dateKeys.indexOf(date) !== index)
  if (!validDates.length) warnings.push('No readable date headers were found.')
  if (duplicateDates.length) warnings.push('Duplicate date headers were detected.')
  if (dates.length !== 7) warnings.push(`Detected ${dates.length} visible date columns; the usual weekly count is 7.`)

  const projects = (snapshot?.rows || []).map((row) => {
    const name = clean(row.project_name)
    if (!name) warnings.push('A project row has no readable name or identifier.')
    const days = validDates.map((date, index) => {
      const cell = row.cells?.[index]
      if (!cell) {
        warnings.push(`A cell for ${name || 'an unnamed project'} on ${date.date} could not be mapped.`)
        return { date: date.date, hours: null, hours_status: 'UNAVAILABLE', description: null, cell_type: 'UNAVAILABLE' }
      }
      const cellType = cell.leave ? 'LEAVE' : cell.disabled ? 'DISABLED' : 'STANDARD'
      if (cell.leave) return { date: date.date, hours: null, hours_status: 'LEAVE', description: cell.description || null, cell_type: cellType, raw_value: cell.raw_value ?? null }
      if (cell.disabled) return { date: date.date, hours: null, hours_status: 'DISABLED', description: cell.description || null, cell_type: cellType, raw_value: cell.raw_value ?? null }
      const parsed = parseHours(cell.raw_value)
      return { date: date.date, ...parsed, description: cell.description || null, cell_type: cellType }
    })
    return {
      project_id: row.project_id || null,
      project_name: name || null,
      days,
    }
  })
  if (!projects.length) warnings.push('No project rows were extracted.')
  const status = warnings.length ? (projects.length && validDates.length ? 'PARTIAL' : 'FAILED') : 'SUCCESS'
  return {
    status,
    source: 'oracle_apex',
    read_only: true,
    week: {
      start_date: validDates[0]?.date || null,
      end_date: validDates.at(-1)?.date || null,
    },
    dates,
    projects,
    diagnostics: {
      project_rows_detected: projects.length,
      date_columns_detected: dates.length,
      warnings,
    },
  }
}

export async function extractTimesheet(page) {
  const snapshot = await page.locator('body').evaluate((body) => {
    const isNonProjectLabel = (value) => {
      const normalized = String(value || '').replace(/\s+/g, ' ').trim()
      return !normalized
        || /^(?:project|delete|remove|daily total|weekly total|total hours|timesheet|weekly timesheet|save timesheet)$/i.test(normalized)
        || /(?:daily total|weekly total|total hours|skip to main content|save timesheet|release \d)/i.test(normalized)
        || /^(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+\d{1,2}/i.test(normalized)
        || /^(?:L|\d+(?:[.,]\d+)?)$/i.test(normalized)
    }
    const text = body.innerText || ''
    const yearMatch = text.match(/\b(20\d{2})\b/)
    const fallbackYear = yearMatch ? Number(yearMatch[1]) : null
    const dateCandidates = Array.from(body.querySelectorAll('th, [role="columnheader"], *')).filter((element) => {
      const value = (element.innerText || '').replace(/\s+/g, ' ').trim()
      return value.length <= 30 && /^(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+\d{1,2}[-/. ](?:[A-Za-z]{3,9}|\d{1,2})/i.test(value)
    })
    const dates = []
    for (const element of dateCandidates) {
      const label = (element.innerText || '').replace(/\s+/g, ' ').trim()
      const match = label.match(/^(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+\d{1,2}[-/. ](?:[A-Za-z]{3,9}|\d{1,2})(?:[-/. ]\d{2,4})?/i)
      if (match && !dates.some((date) => date.label === match[0])) dates.push({ label: match[0], date: null, x: element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2 })
    }
    const rows = []
    const isDeleteControl = (element) => {
      const content = [
        element.textContent || '',
        element.getAttribute('value') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
      ].join(' ').replace(/\s+/g, ' ')
      return /\b(?:delete|remove)\b/i.test(content)
    }
    const controls = Array.from(body.querySelectorAll('button, a, input, [role="button"]')).filter(isDeleteControl)
    const rowRoots = []
    for (const control of controls) {
      let row = control.parentElement
      while (row && row !== body) {
        const rowControls = Array.from(row.querySelectorAll('button, a, input, [role="button"]')).filter(isDeleteControl)
        const rowInputs = row.querySelectorAll('input:not([type="hidden"])')
        if (rowControls.length === 1 && rowInputs.length > 0) break
        row = row.parentElement
      }
      if (!row || row === body || rowRoots.includes(row)) continue
      rowRoots.push(row)
    }
    const minimumInputs = Math.max(3, Math.min(dates.length - 1, 5))
    for (const input of Array.from(body.querySelectorAll('input:not([type="hidden"])'))) {
      let row = input.parentElement
      while (row && row !== body) {
        const inputCount = row.querySelectorAll('input:not([type="hidden"])').length
        if (inputCount >= minimumInputs && inputCount <= dates.length + 2) break
        row = row.parentElement
      }
      if (row && row !== body && !rowRoots.includes(row)) rowRoots.push(row)
    }
    for (const row of rowRoots) {
      const control = controls.find((candidate) => row.contains(candidate)) || null
      const inputs = Array.from(row.querySelectorAll('input:not([type="hidden"])'))
      const rowRect = row.getBoundingClientRect()
      if (rowRect.width > 0 && rowRect.height > 300) continue
      const lines = (row.innerText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const deleteIndex = lines.findIndex((line) => /\b(?:delete|remove)\b/i.test(line))
      const directChildren = Array.from(row.children)
      const controlIndex = directChildren.indexOf(control)
      const directName = controlIndex > 0
        ? directChildren.slice(0, controlIndex).map((element) => (element.innerText || '').trim()).filter(Boolean).join(' ')
        : ''
      const nameLines = (directName ? [directName] : (deleteIndex >= 0 ? lines.slice(0, deleteIndex) : lines))
        .map((line) => line.replace(/(?:delete|remove)/gi, '').trim())
        .filter((line) => !isNonProjectLabel(line))
      const projectName = nameLines.join(' ') || ''
      const projectId = row.getAttribute('data-project-id') || row.getAttribute('data-id') || null
      const cells = dates.map((date) => {
        const input = inputs.reduce((best, candidate) => {
          const distance = Math.abs((candidate.getBoundingClientRect().left + candidate.getBoundingClientRect().width / 2) - date.x)
          return !best || distance < best.distance ? { element: candidate, distance } : best
        }, null)
        if (input && input.distance < 100) {
          return {
            raw_value: input.element.value,
            disabled: input.element.disabled || input.element.readOnly || input.element.getAttribute('aria-disabled') === 'true',
            leave: false,
            description: null,
          }
        }
        const nearby = Array.from(row.querySelectorAll('*')).find((element) => {
          const value = (element.textContent || '').trim()
          const rect = element.getBoundingClientRect()
          return !element.children.length && value && value.length <= 20 && /^(?:L|leave|holiday)$/i.test(value) && Math.abs((rect.left + rect.width / 2) - date.x) < 100
        })
        return nearby ? { raw_value: nearby.textContent.trim(), disabled: true, leave: true, description: null } : null
      })
      if (!isNonProjectLabel(projectName) && !rows.some((existing) => existing.project_name === projectName)) {
        rows.push({ project_id: projectId, project_name: projectName, cells })
      }
    }
    if (!rows.length && dates.length) {
      const visibleLeaves = Array.from(body.querySelectorAll('*')).filter((element) => {
        if (element.children.length || /SCRIPT|STYLE|NOSCRIPT/.test(element.tagName)) return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      const cellLeaves = visibleLeaves.map((element) => {
        const value = ((element.value ?? element.textContent) || '').replace(/\s+/g, ' ').trim()
        const rect = element.getBoundingClientRect()
        return { element, value, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }).filter((cell) => /^(?:\d+(?:[.,]\d+)?|L|leave|holiday)$/i.test(cell.value))
      const groups = []
      for (const cell of cellLeaves) {
        let group = groups.find((candidate) => Math.abs(candidate.y - cell.y) < 14)
        if (!group) {
          group = { y: cell.y, cells: [] }
          groups.push(group)
        }
        group.cells.push(cell)
      }
      for (const group of groups) {
        const mappedCells = dates.map((date) => group.cells
          .map((cell) => ({ cell, distance: Math.abs(cell.x - date.x) }))
          .sort((left, right) => left.distance - right.distance)[0])
        if (mappedCells.filter((mapped) => mapped && mapped.distance < 100).length < Math.min(3, dates.length)) continue
        const rowLabel = visibleLeaves
          .map((element) => {
            const value = (element.textContent || '').replace(/\s+/g, ' ').trim()
            const rect = element.getBoundingClientRect()
            return { value, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          })
          .filter((item) => !isNonProjectLabel(item.value) && item.value.length <= 60 && item.x < Math.min(...dates.map((date) => date.x)) - 20 && Math.abs(item.y - group.y) < 24)
          .sort((left, right) => right.x - left.x)[0]
        let fallbackLabel = rowLabel?.value || ''
        if (!fallbackLabel && group.cells[0]) {
          let container = group.cells[0].element.parentElement
          while (container && container !== body) {
            const rect = container.getBoundingClientRect()
            if (rect.left < Math.min(...dates.map((date) => date.x)) - 20 && Math.abs((rect.top + rect.height / 2) - group.y) < 24) break
            container = container.parentElement
          }
          fallbackLabel = (container?.innerText || '')
          for (const cell of group.cells) fallbackLabel = fallbackLabel.replace(cell.value, ' ')
          fallbackLabel = fallbackLabel
            .replace(/(?:weekly timesheet|timesheet|delete|remove)/gi, ' ')
            .replace(/\b(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+\d{1,2}[-/. ]\w+(?:[-/. ]\d{2,4})?/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        }
        const cells = mappedCells.map((mapped) => {
          if (!mapped || mapped.distance >= 100) return null
          const value = mapped.cell.value
          const leave = /^(?:L|leave|holiday)$/i.test(value)
          return { raw_value: value, disabled: leave, leave, description: null }
        })
        if (isNonProjectLabel(fallbackLabel)) continue
        rows.push({
          project_id: null,
          project_name: fallbackLabel,
          cells,
        })
      }
    }
    return { fallbackYear, dates, rows }
  })
  return normalizeTimesheetSnapshot({
    ...snapshot,
    dates: snapshot.dates.map((date) => ({
      ...date,
      date: (() => {
        const value = date.label.match(/^(sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+\d{1,2}[-/. ](?:[A-Za-z]{3,9}|\d{1,2})(?:[-/. ]\d{2,4})?/i)?.[0]
        if (!value) return null
        const match = value.match(/(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+(\d{1,2})[-/. ]([A-Za-z]{3,9}|\d{1,2})(?:[-/. ](\d{2,4}))?/i)
        const day = Number(match[1])
        const month = /^\d+$/.test(match[2]) ? Number(match[2]) : MONTHS.get(match[2].slice(0, 3).toLowerCase())
        const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : snapshot.fallbackYear
        return isoDate(day, month, year)
      })(),
    })),
  })
}
