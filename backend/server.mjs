import 'dotenv/config'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { findTimesheetControl, waitForTimesheetGrid } from './timesheetNavigation.mjs'
import { extractTimesheet } from './timesheetExtraction.mjs'
import { parseCsvText, validateUpdateBatch } from './timesheetUpdates.mjs'

const port = Number(process.env.PORT || 8787)
const artifactRoot = resolve(process.env.ARTIFACT_DIR || 'backend/artifacts')
const loginUrl = process.env.ORACLE_LOGIN_URL || process.env.ORACLE_BASE_URL
const readOnly = process.env.AUTOMATION_READ_ONLY !== 'false'
const writeEnabled = process.env.ORACLE_WRITE_ENABLED === 'true'

if (!loginUrl) {
  throw new Error('ORACLE_LOGIN_URL or ORACLE_BASE_URL must be configured.')
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': 'http://localhost:5173',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  if (raw.length > 64 * 1024) throw new Error('Request body is too large.')
  return JSON.parse(raw)
}

function sanitizedError(error) {
  const message = error instanceof Error ? error.message : 'Automation failed.'
  return message
    .replace(/password|passwd|pwd/gi, '[redacted-field]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, 500)
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required.`)
  return value.trim()
}

function safeUrl(value) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[unavailable-url]'
  }
}

async function listArtifacts() {
  const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(() => [])
  const artifacts = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(artifactRoot, entry.name)
    try {
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      const files = await readdir(directory)
      const video = files.find((file) => file.toLowerCase().endsWith('.webm'))
      artifacts.push({
        artifactId: entry.name,
        caseId: result.caseId,
        status: result.status,
        readOnly: result.readOnly,
        navigationStatus: result.navigationStatus || null,
        timesheetPath: result.timesheetPath || null,
        gridEvidence: result.gridEvidence || null,
        extractionStatus: result.extractionStatus || null,
        timesheetData: result.timesheetData || null,
        timesheetScreenshotAvailable: Boolean(result.timesheetScreenshotAvailable),
        recordingAvailable: Boolean(video),
        videoUrl: video ? `/api/artifacts/${encodeURIComponent(entry.name)}/video` : null,
      })
    } catch {
      // Ignore incomplete artifact directories while a recording is being finalized.
    }
  }
  return artifacts.sort((a, b) => b.artifactId.localeCompare(a.artifactId))
}

async function serveVideo(request, response) {
  const match = request.url.match(/^\/api\/artifacts\/([^/]+)\/video$/)
  if (!match) return false
  const artifactId = decodeURIComponent(match[1])
  if (!/^[a-zA-Z0-9-]+$/.test(artifactId)) return false
  const files = await readdir(join(artifactRoot, artifactId))
  const video = files.find((file) => file.toLowerCase().endsWith('.webm'))
  if (!video) {
    json(response, 404, { error: 'Recording is not available.' })
    return true
  }
  const content = await readFile(join(artifactRoot, artifactId, video))
  response.writeHead(200, {
    'content-type': 'video/webm',
    'content-length': content.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': 'http://localhost:5173',
  })
  response.end(content)
  return true
}

async function validateLogin({ username, password, caseId }) {
  const safeCaseId = caseId ? String(caseId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) : 'case'
  const jobId = `${Date.now()}-${randomUUID()}`
  const artifactDir = join(artifactRoot, jobId)
  await mkdir(artifactDir, { recursive: true })

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    recordVideo: { dir: artifactDir, size: { width: 1440, height: 900 } },
    viewport: { width: 1440, height: 1000 },
    userAgent: process.env.ORACLE_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const networkEvents = []
  page.on('request', (request) => {
    if (/login|accept|ords/i.test(request.url())) networkEvents.push({ type: 'request', method: request.method(), url: safeUrl(request.url()) })
  })
  page.on('response', (response) => {
    if (/login|accept|ords/i.test(response.url())) networkEvents.push({ type: 'response', status: response.status(), url: safeUrl(response.url()) })
  })
  const result = {
    caseId: safeCaseId,
    status: 'FAILED',
    readOnly,
    recordingAvailable: false,
    artifactId: jobId,
  }

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const usernameSelector = process.env.ORACLE_USERNAME_SELECTOR || '#P9999_USERNAME, input[name="username"], input[name="p_username"], input[type="email"], input[placeholder="Username"], input[aria-label="Username"]'
    const passwordSelector = process.env.ORACLE_PASSWORD_SELECTOR || '#P9999_PASSWORD, input[name="password"], input[name="p_password"], input[type="password"], input[placeholder="Password"], input[aria-label="Password"]'
    const loginButtonSelector = process.env.ORACLE_LOGIN_BUTTON_SELECTOR || '#B39830766186461584754, button[type="submit"], input[type="submit"], button:has-text("Sign In"), input[value="Sign In"]'
    await page.locator(usernameSelector).first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(Number(process.env.ORACLE_FORM_READY_DELAY_MS || 3_000))
    await page.locator(usernameSelector).first().fill(username)
    await page.locator(passwordSelector).first().fill(password)
    await page.waitForTimeout(500)
    for (const selector of ['button:has-text("Accept")', 'button:has-text("OK")', '[aria-label="Close"]']) {
      const overlay = page.locator(selector).first()
      if (await overlay.isVisible().catch(() => false)) await overlay.evaluate((element) => element.click()).catch(() => {})
    }
    // Match the working Selenium flow: dispatch the DOM click without making
    // Playwright wait for APEX's long-running navigation request.
    await page.locator(loginButtonSelector).first().evaluate((element) => element.click())

    const successSelector = process.env.ORACLE_AUTHENTICATED_SELECTOR
    const authenticatedPaths = (process.env.ORACLE_AUTHENTICATED_PATHS || process.env.ORACLE_AUTHENTICATED_PATH || '').split(',').map((path) => path.trim()).filter(Boolean)
    const failureSelector = process.env.ORACLE_LOGIN_ERROR_SELECTOR
    const verificationDeadline = Date.now() + Number(process.env.LOGIN_VERIFICATION_TIMEOUT_MS || 15_000)
    let authenticated = false
    while (Date.now() < verificationDeadline) {
      const hasFailure = failureSelector ? await page.locator(failureSelector).isVisible().catch(() => false) : false
      const usernameVisible = await page.locator(usernameSelector).first().isVisible().catch(() => false)
      const passwordVisible = await page.locator(passwordSelector).first().isVisible().catch(() => false)
      const successMarkerVisible = successSelector
        ? await page.locator(successSelector).isVisible().catch(() => false)
        : !page.url().toLowerCase().includes('/login')
      const authenticatedPathReached = authenticatedPaths.length
        ? authenticatedPaths.some((path) => new URL(page.url()).pathname.startsWith(path))
        : true
      if (!hasFailure && successMarkerVisible && authenticatedPathReached && !usernameVisible && !passwordVisible) {
        authenticated = true
        break
      }
      await page.waitForTimeout(500)
    }

    if (!authenticated) {
      result.diagnostics = { finalUrl: safeUrl(page.url()), networkEvents: networkEvents.slice(-20) }
      throw new Error('Authentication could not be verified.')
    }
    result.status = 'AUTHENTICATED_READ_ONLY'
    result.message = 'Authentication verified. No timesheet page was modified.'
    await page.screenshot({ path: join(artifactDir, `${safeCaseId}-authenticated.png`), fullPage: true })
    result.successScreenshotAvailable = true
    await page.waitForTimeout(Number(process.env.POST_LOGIN_CAPTURE_MS || 3000))
    const navigateTimesheet = process.env.ORACLE_NAVIGATE_TIMESHEET !== 'false'
    if (navigateTimesheet) {
      const navigationDeadline = Date.now() + Number(process.env.TIMESHEET_NAVIGATION_TIMEOUT_MS || 15_000)
      const navButtonSelector = process.env.ORACLE_NAVIGATION_MENU_SELECTOR || '#t_Button_navControl'
      const link = await findTimesheetControl(page, navButtonSelector)
      if (!link) {
        result.status = 'FAILED_TIMESHEET_NAVIGATION'
        result.navigationStatus = 'FAILED'
        result.navigationMessage = 'My Timesheet navigation control was not found on the authenticated page.'
        result.navigationEvidence = await page.locator('a, button').evaluateAll((elements) => elements
          .filter((element) => {
            const style = window.getComputedStyle(element)
            return style.display !== 'none' && style.visibility !== 'hidden'
          })
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
            href: element instanceof HTMLAnchorElement ? `${element.origin}${element.pathname}` : null,
          }))
          .filter((item) => item.text || item.href)
          .slice(0, 40)).catch(() => [])
        throw new Error(result.navigationMessage)
      }
      const observedHref = await link.getAttribute('href')
      result.navigationControl = { text: (await link.innerText()).trim().slice(0, 80), hasObservedHref: Boolean(observedHref) }
      await link.evaluate((element) => element.click())

      const gridEvidence = await waitForTimesheetGrid(page, navigationDeadline - Date.now(), 500)
      if (!gridEvidence) {
        result.status = 'FAILED_TIMESHEET_GRID'
        result.navigationStatus = 'FAILED'
        result.navigationMessage = 'My Timesheet opened, but the timesheet grid could not be verified.'
        result.gridEvidence = await page.locator('body').evaluate((body) => ({
          urlPath: new URL(location.href).pathname,
          title: document.title.slice(0, 120),
          textExcerpt: body.innerText.slice(0, 500),
        })).catch(() => ({ }))
        throw new Error(result.navigationMessage)
      }
      result.navigationStatus = 'VERIFIED_READ_ONLY'
      result.timesheetPath = new URL(page.url()).pathname
      result.gridEvidence = gridEvidence
      await page.screenshot({ path: join(artifactDir, `${safeCaseId}-timesheet.png`), fullPage: true })
      result.timesheetScreenshotAvailable = true
      const timesheetData = await extractTimesheet(page)
      result.timesheetData = timesheetData
      result.extractionStatus = timesheetData.status
      if (timesheetData.status === 'FAILED') {
        result.status = 'FAILED_TIMESHEET_EXTRACTION'
        result.navigationStatus = 'FAILED'
        result.navigationMessage = 'The timesheet grid was visible, but usable timesheet data could not be extracted.'
        throw new Error(result.navigationMessage)
      }
    }
    if (readOnly) return result

    throw new Error('Write operations are disabled until explicit backend verification is complete.')
  } catch (error) {
    result.message = sanitizedError(error)
    await page.screenshot({ path: join(artifactDir, `${safeCaseId}-failure.png`), fullPage: true }).catch(() => {})
    return result
  } finally {
    await context.close().catch(() => {})
    result.recordingAvailable = true
    await browser.close().catch(() => {})
    await writeFile(join(artifactDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, {})
  if (request.method === 'GET' && request.url === '/api/artifacts') {
    return json(response, 200, await listArtifacts())
  }
  if (request.method === 'GET' && await serveVideo(request, response)) return
  if (request.method !== 'POST' || !['/api/automation/validate-login', '/api/v1/oracle/timesheet/read', '/api/v1/oracle/timesheet/read-batch', '/api/v1/oracle/timesheet/update'].includes(request.url)) {
    return json(response, 404, { error: 'Not found.' })
  }

  try {
    const body = await readJson(request)
    if (request.url === '/api/v1/oracle/timesheet/read-batch') {
      const rows = parseCsvText(requiredString(body.csvText, 'csvText'))
      const users = new Map()
      for (const row of rows) {
        const key = `${row['user name']}\u0000${row.password}`
        if (!users.has(key)) users.set(key, [])
        users.get(key).push(row)
      }
      const perRow = []
      for (const userRows of users.values()) {
        const loginResult = await validateLogin({ username: userRows[0]['user name'], password: userRows[0].password, caseId: body.caseId })
        if (loginResult.status !== 'AUTHENTICATED_READ_ONLY' || !loginResult.timesheetData) {
          for (const row of userRows) perRow.push({ row_number: row.row_number, status: 'NEEDS DATA', message: 'Read-only authentication or timesheet access failed.' })
          continue
        }
        const validation = validateUpdateBatch(userRows, loginResult.timesheetData)
        perRow.push(...validation.per_row)
      }
      return json(response, 200, {
        status: perRow.every((row) => row.status === 'READY') ? 'READY' : 'INVALID',
        read_only: true,
        per_row: perRow,
      })
    }
    if (request.url === '/api/v1/oracle/timesheet/update') {
      const rows = parseCsvText(requiredString(body.csvText, 'csvText'))
      if (!writeEnabled || readOnly) {
        return json(response, 409, {
          status: 'UPDATE FAILED',
          read_only: true,
          message: 'Live Oracle writes are disabled. No browser was launched and no timesheet data was changed.',
          diagnostics: { csv_rows_received: rows.length, writes_enabled: false },
        })
      }
      return json(response, 501, {
        status: 'UPDATE FAILED',
        read_only: false,
        message: 'The live Oracle write workflow is not enabled until its controls are explicitly verified.',
      })
    }
    const username = requiredString(body.username, 'username')
    const password = requiredString(body.password, 'password')
    const result = await validateLogin({ username, password, caseId: body.caseId })
    return json(response, result.status === 'AUTHENTICATED_READ_ONLY' ? 200 : 422, result)
  } catch (error) {
    return json(response, 400, { error: sanitizedError(error) })
  }
})

server.listen(port, () => {
  console.log(`Chronos automation service listening on http://localhost:${port}`)
  console.log(`Read-only mode: ${readOnly ? 'enabled' : 'disabled by configuration'}`)
})
