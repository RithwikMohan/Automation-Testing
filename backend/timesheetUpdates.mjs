const REQUIRED_HEADERS = ['user name', 'password', 'date', 'project', 'log time', 'work description']

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function canonicalHeader(value) {
  return clean(value).toLowerCase()
}

export function parseCsvText(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('CSV content is required.')
  const records = []
  let row = []
  let value = ''
  let quoted = false
  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index]
    const next = csvText[index + 1]
    if (character === '"' && quoted && next === '"') {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(value)
      value = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1
      row.push(value)
      if (row.some((cell) => clean(cell))) records.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.')
  row.push(value)
  if (row.some((cell) => clean(cell))) records.push(row)
  if (records.length < 2) throw new Error('CSV must contain a header and at least one data row.')

  const headers = records[0].map(canonicalHeader)
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header))
  if (missing.length) throw new Error(`CSV is missing required headers: ${missing.join(', ')}.`)
  const positions = Object.fromEntries(REQUIRED_HEADERS.map((header) => [header, headers.indexOf(header)]))
  return records.slice(1).map((cells, index) => Object.fromEntries([
    ...REQUIRED_HEADERS.map((header) => [header, clean(cells[positions[header]])]),
    ['row_number', index + 2],
  ]))
}

export function normalizeDate(value) {
  const normalized = clean(value)
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const dayFirstMatch = normalized.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/)
  const year = isoMatch ? isoMatch[1] : dayFirstMatch?.[3]
  const month = isoMatch ? isoMatch[2] : dayFirstMatch?.[2]
  const day = isoMatch ? isoMatch[3] : dayFirstMatch?.[1]
  if (!year || !month || !day) return null
  const iso = `${year}-${month}-${day}`
  const date = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso
}

function parseLogTime(value) {
  const normalized = clean(value).replace(',', '.')
  if (!/^(?:\d+(?:\.\d+)?)$/.test(normalized)) return null
  const hours = Number(normalized)
  return Number.isFinite(hours) && hours >= 0 && hours <= 8 ? hours : null
}

function result(status, row, message) {
  return { row_number: row['row_number'], status, message }
}

export function validateUpdateBatch(rows, currentData) {
  const perRow = []
  const warnings = []
  const projects = currentData?.projects || []
  const dates = new Set((currentData?.dates || []).map((date) => date.date))
  const additions = new Map()
  const currentDailyTotals = new Map()
  for (const total of currentData?.daily_totals || []) {
    if (typeof total.hours === 'number' && Number.isFinite(total.hours)) currentDailyTotals.set(total.date, total.hours)
  }
  const extractedTotals = currentDailyTotals.size > 0
  for (const project of projects) {
    for (const day of project.days || []) {
      if (!extractedTotals && typeof day.hours === 'number' && Number.isFinite(day.hours)) {
        currentDailyTotals.set(day.date, (currentDailyTotals.get(day.date) || 0) + day.hours)
      }
    }
  }

  for (const row of rows || []) {
    const date = normalizeDate(row.date)
    const projectName = clean(row.project)
    const hours = parseLogTime(row['log time'])
    if (!date || !projectName || hours === null || !clean(row['user name']) || !clean(row.password)) {
      perRow.push(result('INVALID', row, 'Required row data is missing or invalid.'))
      continue
    }
    if (!dates.has(date)) {
      perRow.push(result('NEEDS DATA', row, 'Requested date is not visible in the current timesheet week.'))
      continue
    }
    const matches = projects.filter((project) => clean(project.project_name).toLowerCase() === projectName.toLowerCase())
    if (matches.length !== 1) {
      perRow.push(result('PROJECT MISMATCH', row, matches.length ? 'Project name is ambiguous.' : 'Project was not found in the current timesheet.'))
      continue
    }
    const day = matches[0].days.find((candidate) => candidate.date === date)
    if (!day || !['READ', 'EMPTY'].includes(day.hours_status) || typeof day.hours !== 'number') {
      perRow.push(result('NEEDS DATA', row, 'Current hours are not safely readable for the requested cell.'))
      continue
    }
    const key = date
    additions.set(key, (additions.get(key) || 0) + hours)
    perRow.push({ row_number: row['row_number'], status: 'READY', message: 'Validated against the current read-only timesheet.', date, project_name: matches[0].project_name, requested_hours: hours, current_hours: day.hours, projected_hours: day.hours + hours, work_description: clean(row['work description']) || null })
  }

  for (const [date, added] of additions) {
    const projectedTotal = (currentDailyTotals.get(date) || 0) + added
    if (projectedTotal > 8) {
      warnings.push(`Daily limit exceeded on ${date}.`)
      for (const item of perRow) {
        if (item.date === date && item.status === 'READY') {
          item.status = 'EXCEEDS LIMIT'
          item.message = `Projected daily total is ${projectedTotal.toFixed(1)} hours, above the 8-hour daily limit.`
        }
      }
    }
  }
  const readyCount = perRow.filter((item) => item.status === 'READY').length
  const status = readyCount === perRow.length ? 'READY' : readyCount > 0 ? 'PARTIAL' : 'INVALID'
  return { status, read_only: true, per_row: perRow, diagnostics: { warnings } }
}

export function prepareMockPersistence(currentData, validation) {
  const readyRows = validation.per_row.filter((item) => item.status === 'READY')
  if (readyRows.length === 0) return { status: 'INVALID', persisted: false, per_row: validation.per_row }
  const next = structuredClone(currentData)
  for (const row of readyRows) {
    const project = next.projects.find((candidate) => candidate.project_name === row.project_name)
    const day = project.days.find((candidate) => candidate.date === row.date)
    day.hours += row.requested_hours
    day.hours_status = 'READ'
    if (row.work_description) {
      day.description = day.description
        ? `${day.description}; ${row.work_description}`
        : row.work_description
    }
  }
  return { status: 'UPDATED', persisted: true, data: next, per_row: validation.per_row }
}

export function executeMockUpdate({ validatedData, latestData, validation, saveOutcome = 'success' }) {
  const readyRows = validation.per_row.filter((item) => item.status === 'READY')
  if (readyRows.length === 0) {
    return { status: 'INVALID', persisted: false, retried: false, per_row: validation.per_row }
  }

  const staleValidation = validateUpdateBatch(
    readyRows.map((row) => ({
      'row_number': row.row_number,
      'user name': 'validated-user',
      password: 'validated-secret',
      date: row.date,
      project: row.project_name,
      'log time': String(row.requested_hours),
      'work description': row.work_description || '',
    })),
    latestData,
  )
  if (staleValidation.status !== 'READY') {
    return { status: 'VERIFICATION FAILED', persisted: false, retried: false, reason: 'Timesheet changed after preflight validation.', per_row: staleValidation.per_row }
  }
  if (saveOutcome === 'failure') {
    return { status: 'UPDATE FAILED', persisted: false, retried: false, reason: 'Mock Save returned an error.', per_row: validation.per_row }
  }
  if (saveOutcome === 'uncertain') {
    return { status: 'UPDATE IN PROGRESS', persisted: false, retried: false, reason: 'Mock Save outcome was uncertain; no retry was attempted.', per_row: validation.per_row }
  }
  if (saveOutcome !== 'success') {
    throw new Error(`Unsupported mock save outcome: ${saveOutcome}`)
  }

  const persisted = prepareMockPersistence(validatedData, validation)
  const verification = validateUpdateBatch(
    readyRows.map((row) => ({
      'row_number': row.row_number,
      'user name': 'validated-user',
      password: 'validated-secret',
      date: row.date,
      project: row.project_name,
      'log time': '0',
      'work description': row.work_description || '',
    })),
    persisted.data,
  )
  const valuesVerified = readyRows.every((row) => {
    const project = persisted.data.projects.find((candidate) => candidate.project_name === row.project_name)
    const day = project?.days.find((candidate) => candidate.date === row.date)
    return day?.hours === row.projected_hours && day?.hours_status === 'READ'
  })
  if (verification.status !== 'READY' || !valuesVerified) {
    return { status: 'VERIFICATION FAILED', persisted: false, retried: false, reason: 'Mock persisted values could not be re-read.', per_row: verification.per_row }
  }
  return { status: 'UPDATED', persisted: true, retried: false, data: persisted.data, per_row: validation.per_row }
}
