const MAX_SELECTOR_LENGTH = 240

function requiredSelector(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SELECTOR_LENGTH) {
    throw new Error(`Contextual target ${field} must be a non-empty CSS selector.`)
  }
  return value.trim()
}

function interpolate(value, variables) {
  return String(value ?? '').replace(/\$\{([a-z][a-z0-9_]*)\}/g, (_match, key) => {
    if (!Object.hasOwn(variables, key)) throw new Error(`Contextual target is missing variable "${key}".`)
    return String(variables[key] ?? '')
  }).trim()
}

/**
 * Resolve a cell from a reviewed table/row/column definition. Text must identify
 * exactly one row and header in exactly one table; this function never guesses.
 * Selectors are CSS configuration only and are never evaluated as JavaScript.
 */
export async function resolveContextualCell(page, target, variables = {}) {
  if (!target || target.strategy !== 'table_intersection') {
    throw new Error('Unsupported contextual target strategy.')
  }
  const tableSelector = requiredSelector(target.tableSelector, 'tableSelector')
  const rowSelector = requiredSelector(target.rowSelector, 'rowSelector')
  const rowLabelSelector = requiredSelector(target.rowLabelSelector, 'rowLabelSelector')
  const headerSelector = requiredSelector(target.headerSelector, 'headerSelector')
  const rowCellSelector = requiredSelector(target.rowCellSelector || 'th, td', 'rowCellSelector')
  const cellSelector = requiredSelector(target.cellSelector, 'cellSelector')
  const rowText = interpolate(target.rowText, variables)
  const headerText = interpolate(target.headerText, variables)
  const headerMatch = target.headerMatch || 'exact'
  if (!['exact', 'date'].includes(headerMatch)) throw new Error('Contextual target headerMatch must be exact or date.')
  if (!rowText || !headerText) throw new Error('Contextual target row and column values are required.')
  const cleanedHeaderDate = headerText.replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i, '')
  if (headerMatch === 'date' && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(headerText) && (!/\b\d{4}\b/.test(cleanedHeaderDate) || Number.isNaN(Date.parse(cleanedHeaderDate)))) {
    throw new Error('Contextual date header must be ISO (YYYY-MM-DD) or a recognized month/day/year date.')
  }

  const matches = await page.locator(tableSelector).evaluateAll((tables, config) => {
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    const dateKey = (value) => {
      const text = String(value || '').trim()
      let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
      if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
      const cleaned = text.replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i, '')
      if (!/\b\d{4}\b/.test(cleaned)) return null
      const parsed = Date.parse(cleaned)
      if (!Number.isNaN(parsed)) {
        const date = new Date(parsed)
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      }
      return null
    }
    const normalizeHeader = (value) => config.headerMatch === 'date' ? dateKey(value) : normalizeText(value)
    const expectedHeader = normalizeHeader(config.headerText)
    return tables.map((table, tableIndex) => {
      const rows = [...table.querySelectorAll(config.rowSelector)].filter((row) =>
        normalizeText(row.querySelector(config.rowLabelSelector)?.textContent) === normalizeText(config.rowText))
      const headers = [...table.querySelectorAll(config.headerSelector)]
      const columns = headers.map((header, index) => ({ header, index })).filter(({ header }) =>
        expectedHeader !== null && normalizeHeader(header.textContent) === expectedHeader)
      return { tableIndex, rows: rows.length, columns: columns.map(({ index }) => index), headerCount: headers.length }
    })
  }, { rowSelector, rowLabelSelector, headerSelector, rowText, headerText, headerMatch })

  const candidates = matches.filter((item) => item.rows && item.columns.length)
  if (!matches.length) throw Object.assign(new Error('No table matched the configured table selector.'), { code: 'CONTEXT_TABLE_NOT_FOUND' })
  if (candidates.length !== 1) {
    if (!candidates.length) {
      const hasRows = matches.some((item) => item.rows > 0)
      const hasColumns = matches.some((item) => item.columns.length > 0)
      const code = hasRows && !hasColumns ? 'CONTEXT_COLUMN_NOT_FOUND' : hasColumns && !hasRows ? 'CONTEXT_ROW_NOT_FOUND' : 'CONTEXT_ROW_NOT_FOUND'
      throw Object.assign(new Error(code === 'CONTEXT_COLUMN_NOT_FOUND' ? `No column header matched "${headerText}".` : `No row matched "${rowText}".`), { code })
    }
    throw Object.assign(new Error('Contextual target matches multiple tables.'), {
      code: 'CONTEXT_TARGET_AMBIGUOUS',
      tableCount: candidates.length,
    })
  }
  const match = candidates[0]
  if (match.rows !== 1 || match.columns.length !== 1) {
    throw Object.assign(new Error(`Contextual target must match one row and one column (found ${match.rows} rows and ${match.columns.length} columns).`), {
      code: 'CONTEXT_TARGET_AMBIGUOUS', rowCount: match.rows, columnCount: match.columns.length,
    })
  }

  const table = page.locator(tableSelector).nth(match.tableIndex)
  // The row was counted by its configured label selector above. Use the index
  // within the unique matching table to avoid a page-wide text locator collision.
  const rowIndex = await table.locator(rowSelector).evaluateAll((rows, config) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    return rows.findIndex((item) => normalize(item.querySelector(config.labelSelector)?.textContent) === normalize(config.text))
  }, { labelSelector: rowLabelSelector, text: rowText })
  if (rowIndex < 0) throw Object.assign(new Error('Contextual row changed while resolving the target.'), { code: 'CONTEXT_TARGET_NOT_FOUND' })
  const resolvedRow = table.locator(rowSelector).nth(rowIndex)
  const tableCell = resolvedRow.locator(rowCellSelector).nth(match.columns[0])
  const cell = cellSelector === rowCellSelector ? tableCell : tableCell.locator(cellSelector)
  const cellCount = await cell.count()
  if (cellCount !== 1) throw Object.assign(new Error(cellCount ? `The row and column intersection contains ${cellCount} matching targets.` : 'The row and column intersection has no matching target cell.'), { code: cellCount ? 'CONTEXT_TARGET_AMBIGUOUS' : 'CONTEXT_CELL_NOT_FOUND', cellCount })
  if (!(await cell.isVisible())) throw Object.assign(new Error('The resolved contextual target is not visible.'), { code: 'CONTEXT_TARGET_NOT_ACTIONABLE' })
  if (!(await cell.isEnabled())) throw Object.assign(new Error('The resolved contextual target is disabled.'), { code: 'CONTEXT_TARGET_NOT_ACTIONABLE' })
  return { locator: cell, rowText, headerText, columnIndex: match.columns[0], rowIndex }
}
