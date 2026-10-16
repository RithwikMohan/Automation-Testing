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

function parseDate(value) {
  const normalized = clean(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null
  const date = new Date(`${normalized}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? null : normalized
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

  for (const row of rows || []) {
    const date = parseDate(row.date)
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
    const key = `${matches[0].project_name.toLowerCase()}|${date}`
    additions.set(key, (additions.get(key) || 0) + hours)
    perRow.push({ row_number: row['row_number'], status: 'READY', message: 'Validated against the current read-only timesheet.', date, project_name: matches[0].project_name, requested_hours: hours, current_hours: day.hours, projected_hours: day.hours + hours, work_description: clean(row['work description']) || null })
  }

  for (const [key, added] of additions) {
    const [projectName, date] = key.split('|')
    const project = projects.find((candidate) => clean(candidate.project_name).toLowerCase() === projectName)
    const day = project.days.find((candidate) => candidate.date === date)
    if (day.hours + added > 8) {
      warnings.push(`Daily limit exceeded for ${project.project_name} on ${date}.`)
      for (const item of perRow) {
        if (item.project_name === project.project_name && item.date === date) {
          item.status = 'EXCEEDS LIMIT'
          item.message = `Projected total is ${projectedHours(project, date, added).toFixed(1)} hours, above the 8-hour daily limit.`
        }
      }

      function projectedHours(project, date, added) {
        const day = project.days.find((candidate) => candidate.date === date)
        return day.hours + added
      }
    }
  }
  const status = perRow.some((item) => item.status !== 'READY') ? 'INVALID' : 'READY'
  return { status, read_only: true, per_row: perRow, diagnostics: { warnings } }
}

export function prepareMockPersistence(currentData, validation) {
  if (validation.status !== 'READY') return { status: 'INVALID', persisted: false, per_row: validation.per_row }
  const next = structuredClone(currentData)
  for (const row of validation.per_row) {
    const project = next.projects.find((candidate) => candidate.project_name === row.project_name)
    const day = project.days.find((candidate) => candidate.date === row.date)
    day.hours += row.requested_hours
    day.hours_status = 'READ'
    if (row.work_description) day.description = row.work_description
  }
  return { status: 'UPDATED', persisted: true, data: next, per_row: validation.per_row }
}
