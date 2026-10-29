import 'dotenv/config'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { findTimesheetControl, waitForTimesheetGrid } from './timesheetNavigation.mjs'
import { extractTimesheet } from './timesheetExtraction.mjs'
import { phase1ErrorDetails } from './apiErrors.mjs'
import { parseCsvText, validateUpdateBatch } from './timesheetUpdates.mjs'
import {
  archiveApplication,
  archiveAutomationDefinition,
  createApplication,
  createAutomationDefinition,
  duplicateAutomationDefinition,
  findArtifact,
  getApplicationById,
  getApplicationWorkflowVersion,
  listApplicationWorkflowVersions,
  getAutomationDefinitionById,
  initializeDatabase,
  listApplications,
  listApplicationOriginAudit,
  listAutomationDefinitions,
  listPersistedRuns,
  persistArtifacts,
  persistBatchResult,
  persistResult,
  updateApplication,
  updateAutomationDefinition,
  listExplorationResults,
  getExplorationResultById,
  importBrowserTestSuite,
  listBrowserTestSuites,
  listBrowserTestCases,
  findBrowserTestCaseKeys,
  getBrowserTestCaseById,
  createBrowserTestExecution,
  listBrowserTestExecutions,
  getBrowserTestExecutionById,
  getBrowserTestArtifactById,
  listAllBrowserTestArtifacts,
  interruptOrphanedBrowserTestExecutions,
  getBrowserTestStats,
} from './database.mjs'
import { runExploration } from './exploration/explorationRunner.mjs'
import { generateTaskPlan, PlanningError } from './planning/taskPlanning.mjs'
import { parseTestCaseCsv } from './browserTests/csvImport.mjs'
import { compileTestCase } from './browserTests/interpreter.mjs'
import { applyReviewedWorkflowLocators } from './workflows/workflowDefinition.mjs'
import { saveWorkflowDefinition, validateForApplication, buildWorkflowStepText, actionToRuleText } from './workflows/workflowAuthoring.mjs'
import { generateWorkflowCsvTemplate } from './workflows/csvTemplate.mjs'
import { cancelBrowserTestExecution, startBrowserTestExecution, waitForBrowserTestLogin } from './browserTests/execution.mjs'
import { beginWorkflowCapture, cancelWorkflowCapture, finishWorkflowCapture, getWorkflowCapture, getWorkflowTemplateForApplication, navigateWorkflowCapture, pauseWorkflowCapture, resumeWorkflowCapture, saveReviewedWorkflowCapture, startWorkflowCaptureForApplication } from './browserTests/workflowRecorder.mjs'
import { isAuthorizedHrRequest, isRegisteredHcmApp } from './integrations/oracleHcm/hrAccess.mjs'
import { captureHcmInspection, closeHcmInspection, resumeHcmInspection, startHcmInspection } from './integrations/oracleHcm/inspection.mjs'
import {
  validateApplicationPayload,
  validateAutomationDefinitionPayload,
} from './validation.mjs'

const port = Number(process.env.PORT || 8787)
const artifactRoot = resolve(process.env.ARTIFACT_DIR || 'backend/artifacts')
const loginUrl = process.env.ORACLE_LOGIN_URL || process.env.ORACLE_BASE_URL
const readOnly = process.env.AUTOMATION_READ_ONLY !== 'false'
const writeEnabled = process.env.ORACLE_WRITE_ENABLED === 'true'
const autoUpdateOnUpload = process.env.AUTO_UPDATE_ON_UPLOAD === 'true'
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173'

// Oracle timesheet URL is optional — endpoints requiring it return a clear error if unconfigured.

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-headers': 'content-type, x-chronos-hr-token',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request, maxBytes = 64 * 1024) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Request body is too large.')
  }
  return JSON.parse(raw)
}

function sanitizedError(error) {
  const message = error instanceof Error ? error.message : 'Automation failed.'
  return message
    .replace(/password|passwd|pwd/gi, '[redacted-field]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, 500)
}

function phase1Error(response, error) {
  const details = phase1ErrorDetails(error)
  return json(response, details.status, { error: details.error })
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
    'access-control-allow-origin': corsOrigin,
  })
  response.end(content)
  return true
}

async function servePersistedArtifact(request, response) {
  const match = request.url.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/?]+)(?:\?(.+))?$/)
  if (!match) return false
  const runId = decodeURIComponent(match[1])
  const kind = decodeURIComponent(match[2])
  const caseId = new URL(`http://localhost${request.url}`).searchParams.get('case_id')
  if (!/^[a-zA-Z0-9-]+$/.test(runId) || !/^[a-zA-Z0-9_-]+$/.test(kind)) {
    json(response, 400, { error: 'Invalid artifact reference.' })
    return true
  }
  const artifact = await findArtifact(runId, kind, caseId)
  if (!artifact) {
    json(response, 404, { error: 'Artifact is not available.' })
    return true
  }
  const artifactPath = resolve(artifact.file_path)
  const rootPrefix = `${artifactRoot}${artifactRoot.endsWith('\\') ? '' : '\\'}`
  if (!artifactPath.startsWith(rootPrefix) || !(await stat(artifactPath).then(() => true).catch(() => false))) {
    json(response, 404, { error: 'Artifact is not available.' })
    return true
  }
  const content = await readFile(artifactPath)
  response.writeHead(200, {
    'content-type': artifact.content_type,
    'content-length': content.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': corsOrigin,
  })
  response.end(content)
  return true
}

async function persistArtifactResult(result, artifactDir) {
  const files = (await readdir(artifactDir)).filter((file) => file !== 'result.json').map((file) => ({
    kind: file.toLowerCase().endsWith('.webm') ? 'recording' : file.toLowerCase().endsWith('.png') ? 'screenshot' : 'result',
    path: join(artifactDir, file),
    contentType: file.toLowerCase().endsWith('.webm') ? 'video/webm' : file.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream',
  }))
  await persistResult(result, artifactDir, files)
}

async function writeValidatedTimesheet(page, rows, currentData) {
  const validation = validateUpdateBatch(rows, currentData)
  const readyRows = validation.per_row.filter((item) => item.status === 'READY')
  if (readyRows.length === 0) return { status: 'INVALID', per_row: validation.per_row, diagnostics: validation.diagnostics }
  const targets = []
  for (const row of readyRows) {
    const projectCell = page.locator('.project-name-cell').filter({ has: page.locator('.project-name-text', { hasText: new RegExp(`^${String(row.project_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first()
    if (await projectCell.count() !== 1) return { status: 'PROJECT MISMATCH', per_row: validation.per_row }
    const projectId = await projectCell.locator('[data-project-id]').getAttribute('data-project-id')
    const input = page.locator(`input.hours-input.ts-cell[data-project="${projectId}"][data-date="${row.date}"]`)
    if (!projectId || await input.count() !== 1) return { status: 'NEEDS DATA', per_row: validation.per_row }
    const raw = await input.inputValue()
    const currentHours = Number(raw)
    if (!Number.isFinite(currentHours) || currentHours < 0) return { status: 'NEEDS DATA', per_row: validation.per_row }
    targets.push({ row, input, currentHours, projectedHours: currentHours + row.requested_hours })
  }
  if (targets.some((target) => target.projectedHours > 8)) {
    return { status: 'EXCEEDS LIMIT', per_row: targets.map((target) => ({ row_number: target.row.row_number, status: target.projectedHours > 8 ? 'EXCEEDS LIMIT' : 'READY', message: target.projectedHours > 8 ? `Projected total is ${target.projectedHours.toFixed(1)} hours, above the 8-hour daily limit.` : 'Validated.' })) }
  }
  for (const target of targets) {
    const reread = Number(await target.input.inputValue())
    if (reread !== target.currentHours) return { status: 'VERIFICATION FAILED', per_row: validation.per_row }
    await target.input.fill(String(target.projectedHours))
    if (target.row.work_description) {
      await target.input.dblclick()
      const description = page.locator('#wd-description')
      await description.waitFor({ state: 'visible' })
      const existing = (await description.inputValue()).trim()
      await description.fill(existing ? `${existing}; ${target.row.work_description}` : target.row.work_description)
      await page.locator('#wd-save').click()
      await description.waitFor({ state: 'hidden' }).catch(() => {})
    }
  }
  await page.locator('#save-timesheet-btn').click()
  await page.waitForTimeout(1_000)
  for (const target of targets) {
    const persisted = Number(await target.input.inputValue())
    if (persisted !== target.projectedHours) return { status: 'VERIFICATION FAILED', per_row: validation.per_row }
  }
  return {
    status: 'UPDATED',
    persisted: true,
    per_row: validation.per_row.map((item) => {
      const target = targets.find((t) => t.row.row_number === item.row_number)
      if (target) return { row_number: item.row_number, status: 'UPDATED', message: 'Hours and work description were saved and verified.', current_hours: target.currentHours, updated_hours: target.projectedHours }
      return item
    }),
  }
}

async function validateLogin({ username, password, caseId, updateRows, persist = true, artifactRunId }) {
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
    if (!updateRows) return result
    if (readOnly || !writeEnabled) throw new Error('Live writes are disabled by configuration.')
    const updateResult = await writeValidatedTimesheet(page, updateRows, result.timesheetData)
    result.status = updateResult.status
    result.updateResult = updateResult
    result.readOnly = false
    result.message = updateResult.status === 'UPDATED' ? 'Validated updates were saved and independently verified.' : 'No live update was confirmed.'
    return result
  } catch (error) {
    result.message = sanitizedError(error)
    await page.screenshot({ path: join(artifactDir, `${safeCaseId}-failure.png`), fullPage: true }).catch(() => {})
    return result
  } finally {
    await context.close().catch(() => {})
    result.recordingAvailable = true
    await browser.close().catch(() => {})
    await writeFile(join(artifactDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
    if (persist) {
      try {
        await persistArtifactResult(result, artifactDir)
      } catch (databaseError) {
        console.error(`Failed to persist run ${jobId}:`, sanitizedError(databaseError))
      }
    } else if (artifactRunId) {
      const files = (await readdir(artifactDir)).filter((file) => file !== 'result.json').map((file) => ({
        kind: file.toLowerCase().endsWith('.webm') ? 'recording' : file.toLowerCase().endsWith('.png') ? 'screenshot' : 'result',
        path: join(artifactDir, file),
        contentType: file.toLowerCase().endsWith('.webm') ? 'video/webm' : file.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream',
      }))
      await persistArtifacts(artifactRunId, result.caseId, files).catch((databaseError) => {
        console.error(`Failed to persist artifacts for ${artifactRunId}:`, sanitizedError(databaseError))
      })
    }
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-headers': 'content-type, x-chronos-hr-token',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    })
    return response.end()
  }

  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  const pathname = parsedUrl.pathname
  const searchParams = parsedUrl.searchParams

  if (request.method === 'GET' && pathname === '/api/artifacts') {
    return json(response, 200, await listArtifacts())
  }
  if (request.method === 'GET' && pathname === '/api/runs') {
    try {
      return json(response, 200, await listPersistedRuns())
    } catch (error) {
      return json(response, 503, { error: sanitizedError(error) })
    }
  }
  if (request.method === 'GET' && pathname === '/api/config') {
    return json(response, 200, {
      auto_update_on_upload: autoUpdateOnUpload,
      read_only: readOnly,
      writes_enabled: writeEnabled && !readOnly,
    })
  }
  if (request.method === 'GET' && await servePersistedArtifact(request, response)) return
  if (request.method === 'GET' && await serveVideo(request, response)) return

  /* -------------------------------------------------------------------------
     Phase 1: Applications Endpoints
     ------------------------------------------------------------------------- */
  if (pathname === '/api/applications') {
    if (request.method === 'GET') {
      try {
        const apps = await listApplications({
          search: searchParams.get('search') || undefined,
          environment: searchParams.get('environment') || undefined,
          authMethod: searchParams.get('authMethod') || undefined,
          status: searchParams.get('status') || undefined,
          sortBy: searchParams.get('sortBy') || undefined,
          sortOrder: searchParams.get('sortOrder') || undefined,
        })
        return json(response, 200, apps)
      } catch (error) {
        return phase1Error(response, error)
      }
    }
    if (request.method === 'POST') {
      try {
        const body = await readJson(request)
        const validated = validateApplicationPayload(body, false)
        const app = await createApplication(validated)
        return json(response, 201, app)
      } catch (error) {
        return phase1Error(response, error)
      }
    }
  }

  const workflowTemplateMatch = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)\/workflow-template$/)
  if (workflowTemplateMatch && request.method === 'GET') {
    try {
      const application = await getApplicationById(workflowTemplateMatch[1])
      if (!application || application.status !== 'Active') return json(response, 404, { error: 'Active registered application not found.' })
      const requestedVersion = searchParams.get('version')
      if (requestedVersion !== null && (!/^\d+$/.test(requestedVersion) || Number(requestedVersion) < 1)) return json(response, 400, { error: 'Workflow version must be a positive integer.' })
      const template = requestedVersion ? await getApplicationWorkflowVersion(application.id, Number(requestedVersion)) : await getWorkflowTemplateForApplication(application.id)
      return template ? json(response, 200, template) : json(response, 404, { error: 'No workflow has been recorded for this application yet.' })
    } catch (error) { return phase1Error(response, error) }
  }
  const workflowAuthoringMatch = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)\/workflow-template\/(validate|preview|save)$/)
  if (workflowAuthoringMatch && request.method === 'POST') {
    const [, applicationId, operation] = workflowAuthoringMatch
    try {
      const body = await readJson(request)
      const { definition, stepsText } = await validateForApplication(applicationId, body)
      if (operation === 'validate') return json(response, 200, { valid: true, actionCount: definition.actions.length, variableCount: definition.variables.length, hasAssertion: definition.actions.some((action) => action.action.startsWith('assert_')), stepsText })
      if (operation === 'preview') {
        const actions = definition.actions.map((action) => ({ ...action, ruleText: actionToRuleText(action) }))
        return json(response, 200, { csv_template: generateWorkflowCsvTemplate({ name: definition.name, variables: definition.variables, actions }, definition.version || 1), stepsText })
      }
      return json(response, 200, await saveWorkflowDefinition(applicationId, body))
    } catch (error) { return json(response, 400, { error: sanitizedError(error), code: error.code || 'WORKFLOW_VALIDATION_ERROR' }) }
  }
  const workflowVersionsMatch = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)\/workflow-versions$/)
  if (workflowVersionsMatch && request.method === 'GET') {
    try {
      const application = await getApplicationById(workflowVersionsMatch[1])
      if (!application || application.status !== 'Active') return json(response, 404, { error: 'Active registered application not found.' })
      return json(response, 200, await listApplicationWorkflowVersions(application.id))
    } catch (error) { return phase1Error(response, error) }
  }
  const workflowRecordStart = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)\/workflow-recordings$/)
  if (workflowRecordStart && request.method === 'POST') {
    try { return json(response, 201, await startWorkflowCaptureForApplication(workflowRecordStart[1])) }
    catch (error) { return json(response, 400, { error: sanitizedError(error) }) }
  }
  const workflowNavigateMatch = pathname.match(/^\/api\/workflow-recordings\/([a-f0-9-]+)\/navigate$/)
  if (workflowNavigateMatch && request.method === 'POST') {
    try { const body = await readJson(request); return json(response, 200, await navigateWorkflowCapture(workflowNavigateMatch[1], body.url)) }
    catch (error) { return json(response, 400, { error: sanitizedError(error) }) }
  }
  const workflowRecordMatch = pathname.match(/^\/api\/workflow-recordings\/([a-f0-9-]+)(?:\/(begin|pause|resume|finish|save))?$/)
  if (workflowRecordMatch) {
    const [, recordingId, operation] = workflowRecordMatch
    if (request.method === 'GET' && !operation) {
      const capture = getWorkflowCapture(recordingId)
      return capture ? json(response, 200, capture) : json(response, 404, { error: 'Workflow recording expired or is no longer active.' })
    }
    if (request.method === 'POST' && operation === 'begin') {
      return await beginWorkflowCapture(recordingId) ? json(response, 200, getWorkflowCapture(recordingId)) : json(response, 400, { error: 'Confirm login is complete and close any remaining password prompt before starting capture.' })
    }
    if (request.method === 'POST' && operation === 'pause') return pauseWorkflowCapture(recordingId) ? json(response, 200, getWorkflowCapture(recordingId)) : json(response, 409, { error: 'Capture is not currently active.' })
    if (request.method === 'POST' && operation === 'resume') return resumeWorkflowCapture(recordingId) ? json(response, 200, getWorkflowCapture(recordingId)) : json(response, 409, { error: 'Capture cannot resume because it is not paused or the browser has closed.' })
    if (request.method === 'POST' && operation === 'finish') {
      try {
        const body = await readJson(request)
        return json(response, 200, await finishWorkflowCapture(recordingId, { reuseAuthenticatedSession: body.reuseAuthenticatedSession === true }))
      } catch (error) { return json(response, 400, { error: sanitizedError(error) }) }
    }
    if (request.method === 'POST' && operation === 'save') {
      try { return json(response, 200, await saveReviewedWorkflowCapture(recordingId, await readJson(request))) }
      catch (error) { return json(response, 400, { error: sanitizedError(error) }) }
    }
    if (request.method === 'DELETE' && !operation) {
      await cancelWorkflowCapture(recordingId)
      return json(response, 200, { state: 'CANCELLED' })
    }
  }

  const appArchiveMatch = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)\/archive$/)
  if (appArchiveMatch && request.method === 'POST') {
    try {
      const archived = await archiveApplication(appArchiveMatch[1])
      if (!archived) return json(response, 404, { error: 'Application not found.' })
      return json(response, 200, archived)
    } catch (error) {
      return phase1Error(response, error)
    }
  }

  const appItemMatch = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)$/)
  if (appItemMatch) {
    const appId = appItemMatch[1]
    if (request.method === 'GET') {
      try {
        const app = await getApplicationById(appId)
        if (!app) return json(response, 404, { error: 'Application not found.' })
        return json(response, 200, app)
      } catch (error) {
        return phase1Error(response, error)
      }
    }
    if (request.method === 'PATCH') {
      try {
        const body = await readJson(request)
        const validated = validateApplicationPayload(body, true)
        const updated = await updateApplication(appId, validated)
        if (!updated) return json(response, 404, { error: 'Application not found.' })
        return json(response, 200, updated)
      } catch (error) {
        return phase1Error(response, error)
      }
    }
  }

  const appOriginAuditMatch = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)\/origin-audit$/)
  if (appOriginAuditMatch && request.method === 'GET') {
    try {
      const app = await getApplicationById(appOriginAuditMatch[1])
      if (!app) return json(response, 404, { error: 'Application not found.' })
      return json(response, 200, await listApplicationOriginAudit(appOriginAuditMatch[1]))
    } catch (error) {
      return phase1Error(response, error)
    }
  }

  /* -------------------------------------------------------------------------
     Phase 2.2: Natural-Language Task Planning (review only)
     ------------------------------------------------------------------------- */
  const planMatch = pathname.match(/^\/api\/applications\/([a-zA-Z0-9_-]+)\/plan$/)
  if (planMatch && request.method === 'POST') {
    try {
      let body
      try {
        body = await readJson(request)
      } catch {
        return json(response, 400, { error: 'Request body must be valid JSON and within the allowed size.' })
      }
      const plan = await generateTaskPlan({
        applicationId: planMatch[1],
        instruction: body?.instruction,
      })
      return json(response, 200, plan)
    } catch (error) {
      const status = error instanceof PlanningError ? error.status : 500
      const message = error instanceof PlanningError ? error.message : 'Task planning failed. Please retry.'
      return json(response, status, { error: message })
    }
  }

  /* -------------------------------------------------------------------------
     Oracle HCM read-only wizard inspection. Sessions remain memory-only.
     Every route is separately gated by the locally configured HR token.
     ------------------------------------------------------------------------- */
  if (pathname.startsWith('/api/oracle-hcm/inspection')) {
    if (!process.env.CHRONOS_HR_ACCESS_TOKEN || process.env.CHRONOS_HR_ACCESS_TOKEN.length < 32) {
      return json(response, 503, { error: 'The protected HR inspection feature is not configured.' })
    }
    if (!isAuthorizedHrRequest(request.headers['x-chronos-hr-token'], process.env.CHRONOS_HR_ACCESS_TOKEN)) {
      return json(response, 401, { error: 'HR authorization is required.' })
    }
  }
  if (pathname === '/api/oracle-hcm/inspection' && request.method === 'POST') {
    try {
      const body = await readJson(request)
      const applicationId = requiredString(body.applicationId, 'applicationId')
      const application = await getApplicationById(applicationId)
      if (!isRegisteredHcmApp(application)) return json(response, 400, { error: 'Select the active, manually authenticated registered Oracle HCM demo application.' })
      const inspection = await startHcmInspection(application)
      return json(response, 201, inspection)
    } catch {
      return json(response, 422, { error: 'The protected inspection session could not start. Check the registered origin approvals and browser availability.' })
    }
  }
  const hcmInspectionMatch = pathname.match(/^\/api\/oracle-hcm\/inspection\/([a-f0-9-]+)(?:\/(resume|snapshot|close))?$/i)
  if (hcmInspectionMatch) {
    const [, inspectionId, operation] = hcmInspectionMatch
    if (operation === 'resume' && request.method === 'POST') {
      const resumed = await resumeHcmInspection(inspectionId)
      return resumed ? json(response, 200, { state: 'AUTHENTICATED_READ_ONLY' }) : json(response, 409, { error: 'Manual authentication is not confirmed or the current page is outside approved origins.' })
    }
    if (operation === 'snapshot' && request.method === 'GET') {
      const snapshot = await captureHcmInspection(inspectionId)
      return snapshot ? json(response, 200, snapshot) : json(response, 409, { error: 'Inspection is not authenticated or the page is outside approved origins.' })
    }
    if (operation === 'close' && request.method === 'POST') {
      const closed = await closeHcmInspection(inspectionId)
      return closed ? json(response, 200, { state: 'CLOSED' }) : json(response, 404, { error: 'Inspection session is unavailable.' })
    }
  }

  /* -------------------------------------------------------------------------
     Phase 2.1: Generic Browser Exploration Endpoints
     ------------------------------------------------------------------------- */
  const exploreMatch = pathname.match(/^(?:\/api\/v1)?\/applications\/([a-zA-Z0-9_-]+)\/explore$/)
  if (exploreMatch && request.method === 'POST') {
    try {
      const body = await readJson(request).catch(() => ({}))
      const result = await runExploration({
        applicationId: exploreMatch[1],
        targetUrl: body.targetUrl,
        timeoutMs: body.timeoutMs,
      })
      const isOk = result.status === 'SUCCESS' || result.status === 'AUTH_REQUIRED'
      return json(response, isOk ? 200 : 422, result)
    } catch (error) {
      return json(response, 400, { error: sanitizedError(error) })
    }
  }

  const appExplorationsMatch = pathname.match(/^(?:\/api\/v1)?\/applications\/([a-zA-Z0-9_-]+)\/explorations$/)
  if (appExplorationsMatch && request.method === 'GET') {
    try {
      const results = await listExplorationResults(appExplorationsMatch[1])
      return json(response, 200, results)
    } catch (error) {
      return phase1Error(response, error)
    }
  }

  const singleExplorationMatch = pathname.match(/^(?:\/api\/v1)?\/explorations\/([a-zA-Z0-9_-]+)$/)
  if (singleExplorationMatch && request.method === 'GET') {
    try {
      const result = await getExplorationResultById(singleExplorationMatch[1])
      if (!result) return json(response, 404, { error: 'Exploration result not found.' })
      return json(response, 200, result)
    } catch (error) {
      return phase1Error(response, error)
    }
  }

  /* -------------------------------------------------------------------------
     Phase 1 Rule-Based Browser Tests
     ------------------------------------------------------------------------- */
  const browserTestPreview = pathname === '/api/browser-tests/import/preview'
  const browserTestImport = pathname === '/api/browser-tests/import'
  if ((browserTestPreview || browserTestImport) && request.method === 'POST') {
    try {
      const body = await readJson(request, 2_200_000)
      const applicationId = requiredString(body.applicationId, 'applicationId')
      const application = await getApplicationById(applicationId)
      if (!application || application.status !== 'Active') return json(response, 404, { error: 'An active registered application is required.' })
      let selectedWorkflow = null
      if (body.workflowVersion !== undefined && body.workflowVersion !== null) {
        const version = Number(body.workflowVersion)
        if (!Number.isInteger(version) || version < 1) return json(response, 400, { error: 'Workflow version must be a positive integer.' })
        selectedWorkflow = await getApplicationWorkflowVersion(applicationId, version)
        if (!selectedWorkflow) return json(response, 409, { error: 'The selected workflow version is no longer available. Reload the application workflow and template.' })
      }
      const parsed = parseTestCaseCsv(body.csvText, selectedWorkflow ? { workflowVariables: selectedWorkflow.data_fields, workflowVersion: selectedWorkflow.workflow_version } : undefined)
      const rowErrors = []
      const existing = await findBrowserTestCaseKeys(applicationId, parsed.rows.map((row) => row.testCaseId).filter(Boolean))
      const existingKeys = new Set(existing.map((key) => key.toLowerCase()))
      const compiled = parsed.rows.map((row) => {
        const errors = [...row.errors]
        if (existingKeys.has(row.testCaseId.toLowerCase())) errors.push('This test case ID already exists for the selected application.')
        let plan = null
        if (!errors.length) {
          try {
            plan = compileTestCase(row, application)
            if (selectedWorkflow) applyReviewedWorkflowLocators(plan, selectedWorkflow, row.testData)
          } catch (error) { errors.push(error.message || 'Test steps could not be interpreted.') }
        }
        if (errors.length) rowErrors.push({ rowNumber: row.rowNumber, testCaseId: row.testCaseId || null, errors })
        return {
          rowNumber: row.rowNumber,
          testCaseId: row.testCaseId,
          name: row.name,
          priority: row.priority,
          tags: row.tags,
          preconditions: row.preconditions,
          expectedResult: row.expectedResult,
          testDataKeys: Object.keys(row.testData),
          stepCount: plan?.actions.length || 0,
          plan,
          errors,
          caseData: row,
        }
      })
      const globalErrors = [...parsed.errors]
      if (compiled.length === 0 && globalErrors.length === 0) globalErrors.push('CSV must include at least one test case row.')
      if (browserTestPreview) {
        return json(response, 200, {
          valid: globalErrors.length === 0 && rowErrors.length === 0 && compiled.length > 0,
          rows: compiled.map(({ caseData, ...item }) => item),
          errors: globalErrors,
          rowErrors,
        })
      }
      const requestedCaseIds = Array.isArray(body.selectedCaseIds) ? new Set(body.selectedCaseIds.map((id) => String(id).toLowerCase())) : null
      const selectedCases = requestedCaseIds
        ? compiled.filter((item) => requestedCaseIds.has(String(item.testCaseId).toLowerCase()))
        : compiled
      const selectedErrors = selectedCases.filter((item) => item.errors.length)
      if (globalErrors.length || selectedErrors.length || !selectedCases.length) {
        return json(response, 422, { error: 'CSV import has validation errors. Fix the preview before importing.', errors: globalErrors, rowErrors })
      }
      const safeName = String(body.name || body.filename || 'Imported browser tests').replace(/[^a-zA-Z0-9 ._-]/g, '').trim().slice(0, 120) || 'Imported browser tests'
      const sourceFilename = String(body.filename || '').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || null
      const suiteId = randomUUID()
      const testCases = selectedCases.map((item) => ({
        id: randomUUID(),
        caseKey: item.caseData.testCaseId,
        name: item.caseData.name,
        preconditions: item.caseData.preconditions,
        plan: item.plan,
        testData: item.caseData.testData,
        expectedResult: item.caseData.expectedResult,
        priority: item.caseData.priority,
        tags: item.caseData.tags,
      }))
      const suite = await importBrowserTestSuite({ id: suiteId, applicationId, name: safeName, sourceFilename, workflowVersion: selectedWorkflow?.workflow_version || null, cases: testCases })
      return json(response, 201, suite)
    } catch (error) {
      return phase1Error(response, error)
    }
  }

  if (pathname === '/api/browser-tests/suites' && request.method === 'GET') {
    try { return json(response, 200, await listBrowserTestSuites()) } catch (error) { return phase1Error(response, error) }
  }

  const browserSuiteCases = pathname.match(/^\/api\/browser-tests\/suites\/([a-zA-Z0-9-]+)\/cases$/)
  if (browserSuiteCases && request.method === 'GET') {
    try {
      const cases = await listBrowserTestCases(browserSuiteCases[1])
      return json(response, 200, cases.map(({ test_data: testData, ...item }) => ({ ...item, test_data_keys: Object.keys(testData || {}) })))
    } catch (error) { return phase1Error(response, error) }
  }

  const browserCaseMatch = pathname.match(/^\/api\/browser-tests\/cases\/([a-zA-Z0-9-]+)$/)
  if (browserCaseMatch && request.method === 'GET') {
    try {
      const item = await getBrowserTestCaseById(browserCaseMatch[1])
      if (!item) return json(response, 404, { error: 'Browser test case not found.' })
      const { test_data: testData, ...safeCase } = item
      return json(response, 200, { ...safeCase, test_data_keys: Object.keys(testData || {}) })
    } catch (error) { return phase1Error(response, error) }
  }

  const executeBrowserCase = pathname.match(/^\/api\/browser-tests\/cases\/([a-zA-Z0-9-]+)\/execute$/)
  if (executeBrowserCase && request.method === 'POST') {
    try {
      const item = await getBrowserTestCaseById(executeBrowserCase[1])
      if (!item) return json(response, 404, { error: 'Browser test case not found.' })
      if (item.application_status !== 'Active') return json(response, 409, { error: 'The registered application is not active.' })
      const body = await readJson(request).catch(() => ({}))
      const defaultTimeoutMs = Number(body.defaultTimeoutMs ?? 10_000)
      if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs < 1_000 || defaultTimeoutMs > 60_000) {
        return json(response, 400, { error: 'Default timeout must be an integer from 1,000 to 60,000 milliseconds.' })
      }
      const executionOptions = {
        defaultTimeoutMs,
        recordVideo: body.recordVideo !== false,
        captureScreenshotsOnFailure: body.captureScreenshotsOnFailure !== false,
        recordingPolicy: ['disabled', 'mask-form-values', 'show-non-password-values', 'show-all-values'].includes(body.recordingPolicy) ? body.recordingPolicy : 'mask-form-values',
        reuseAuthenticatedSession: body.reuseAuthenticatedSession === true,
        allowWrites: body.allowWrites === true,
        headless: typeof body.headless === 'boolean' ? body.headless : (process.env.HEADLESS === 'true'),
      }
      const requiresApproval = item.plan.actions.some((action) => action.requiresApproval === true)
      if (requiresApproval && body.approveInteractions !== true) return json(response, 403, { error: 'Explicit approval is required because this test contains interactive actions.' })
      const hasWrites = item.plan.actions.some((action) => ['create', 'update', 'delete'].includes(action.action))
      if (hasWrites && body.allowWrites !== true) return json(response, 403, { error: 'Enable and explicitly approve write actions for this run.' })
      const execution = await createBrowserTestExecution({
        id: randomUUID(),
        suiteId: item.suite_id,
        caseId: item.id,
        applicationId: item.application_id,
        approvedInteractions: body.approveInteractions === true,
        expectedOutcome: item.expected_result,
        executionOptions,
      })
      startBrowserTestExecution(execution)
      return json(response, 202, { id: execution.id, status: execution.status, approved_interactions: execution.approved_interactions })
    } catch (error) { return phase1Error(response, error) }
  }

  const skipBrowserCase = pathname.match(/^\/api\/browser-tests\/cases\/([a-zA-Z0-9-]+)\/skip$/)
  if (skipBrowserCase && request.method === 'POST') {
    try {
      const item = await getBrowserTestCaseById(skipBrowserCase[1])
      if (!item) return json(response, 404, { error: 'Browser test case not found.' })
      const body = await readJson(request).catch(() => ({}))
      const execution = await createBrowserTestExecution({
        id: randomUUID(), suiteId: item.suite_id, caseId: item.id, applicationId: item.application_id,
        approvedInteractions: false, expectedOutcome: item.expected_result, executionOptions: { recordVideo: false },
      })
      const completedAt = new Date()
      await updateBrowserTestExecution(execution.id, {
        status: 'SKIPPED', actualOutcome: String(body.reason || 'Skipped by the selected stop-on-failure policy.').slice(0, 500),
        errorCode: 'STOP_ON_FAILURE', errorDetails: 'This case was not started because an earlier selected case failed and stop-on-failure is enabled.',
        completedAt, durationMs: 0, videoStatus: 'NOT_REQUESTED',
      })
      return json(response, 201, { id: execution.id, status: 'SKIPPED' })
    } catch (error) { return phase1Error(response, error) }
  }

  if (pathname === '/api/browser-tests/all-artifacts' && request.method === 'GET') {
    try {
      const limit = Number(searchParams.get('limit') || 100)
      return json(response, 200, await listAllBrowserTestArtifacts(limit))
    } catch (error) { return phase1Error(response, error) }
  }

  if (pathname === '/api/browser-tests/executions' && request.method === 'GET') {
    try { return json(response, 200, await listBrowserTestExecutions(Number(searchParams.get('limit') || 100))) } catch (error) { return phase1Error(response, error) }
  }

  if (pathname === '/api/browser-tests/stats' && request.method === 'GET') {
    try {
      const stats = await getBrowserTestStats()
      return json(response, 200, stats)
    } catch (error) { return phase1Error(response, error) }
  }

  const browserExecutionMatch = pathname.match(/^\/api\/browser-tests\/executions\/([a-zA-Z0-9-]+)$/)
  if (browserExecutionMatch && request.method === 'GET') {
    try {
      const execution = await getBrowserTestExecutionById(browserExecutionMatch[1])
      return execution ? json(response, 200, execution) : json(response, 404, { error: 'Browser test execution not found.' })
    } catch (error) { return phase1Error(response, error) }
  }

  const resumeBrowserExecution = pathname.match(/^\/api\/browser-tests\/executions\/([a-zA-Z0-9-]+)\/resume$/)
  if (resumeBrowserExecution && request.method === 'POST') {
    const resumed = await waitForBrowserTestLogin(resumeBrowserExecution[1])
    return resumed ? json(response, 202, { status: 'RUNNING', message: 'Manual login confirmation received.' }) : json(response, 409, { error: 'This execution is not waiting for manual login.' })
  }

  const cancelBrowserExecution = pathname.match(/^\/api\/browser-tests\/executions\/([a-zA-Z0-9-]+)\/cancel$/)
  if (cancelBrowserExecution && request.method === 'POST') {
    try {
      const execution = await getBrowserTestExecutionById(cancelBrowserExecution[1])
      if (!execution) return json(response, 404, { error: 'Browser test execution not found.' })
      if (!['QUEUED', 'RUNNING'].includes(execution.status)) return json(response, 409, { error: 'This execution is no longer active.' })
      const cancelled = cancelBrowserTestExecution(execution.id)
      return cancelled ? json(response, 202, { status: 'CANCEL_REQUESTED' }) : json(response, 409, { error: 'The execution is not active in this worker.' })
    } catch (error) { return phase1Error(response, error) }
  }

  const browserTestArtifact = pathname.match(/^\/api\/browser-tests\/artifacts\/([a-zA-Z0-9-]+)$/)
  if (browserTestArtifact && request.method === 'GET') {
    try {
      const artifact = await getBrowserTestArtifactById(browserTestArtifact[1])
      if (!artifact) return json(response, 404, { error: 'Browser test artifact not found.' })
      const artifactRoot = resolve(process.env.ARTIFACT_DIR || 'backend/artifacts', 'browser-tests')
      const filePath = resolve(artifactRoot, ...artifact.relative_path.split('/'))
      if (!filePath.startsWith(artifactRoot + '\\')) return json(response, 404, { error: 'Browser test artifact not found.' })
      const content = await readFile(filePath)
      response.writeHead(200, { 'content-type': artifact.content_type, 'content-length': content.length, 'cache-control': 'no-store', 'access-control-allow-origin': corsOrigin })
      return response.end(content)
    } catch (error) { return json(response, 404, { error: 'Browser test artifact is unavailable.' }) }
  }

  const browserReport = pathname.match(/^\/api\/browser-tests\/executions\/([a-zA-Z0-9-]+)\/report$/)
  if (browserReport && request.method === 'GET') {
    try {
      const execution = await getBrowserTestExecutionById(browserReport[1])
      if (!execution) return json(response, 404, { error: 'Browser test execution not found.' })
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="browser-test-' + execution.id + '.json"', 'cache-control': 'no-store', 'access-control-allow-origin': corsOrigin })
      return response.end(JSON.stringify(execution, null, 2))
    } catch (error) { return phase1Error(response, error) }
  }

  /* -------------------------------------------------------------------------
     Phase 1: Task Definitions (Automations) Endpoints
     ------------------------------------------------------------------------- */
  if (pathname === '/api/automations') {
    if (request.method === 'GET') {
      try {
        const definitions = await listAutomationDefinitions({
          search: searchParams.get('search') || undefined,
          applicationId: searchParams.get('applicationId') || undefined,
          category: searchParams.get('category') || undefined,
          status: searchParams.get('status') || undefined,
          sortBy: searchParams.get('sortBy') || undefined,
          sortOrder: searchParams.get('sortOrder') || undefined,
        })
        return json(response, 200, definitions)
      } catch (error) {
        return phase1Error(response, error)
      }
    }
    if (request.method === 'POST') {
      try {
        const body = await readJson(request)
        const validated = validateAutomationDefinitionPayload(body, false)
        const definition = await createAutomationDefinition(validated)
        return json(response, 201, definition)
      } catch (error) {
        return json(response, 400, { error: sanitizedError(error) })
      }
    }
  }

  const taskDupMatch = pathname.match(/^\/api\/automations\/([a-zA-Z0-9_-]+)\/duplicate$/)
  if (taskDupMatch && request.method === 'POST') {
    try {
      const duplicated = await duplicateAutomationDefinition(taskDupMatch[1])
      if (!duplicated) return json(response, 404, { error: 'Task definition not found.' })
      return json(response, 201, duplicated)
    } catch (error) {
      return phase1Error(response, error)
    }
  }

  const taskArchiveMatch = pathname.match(/^\/api\/automations\/([a-zA-Z0-9_-]+)\/archive$/)
  if (taskArchiveMatch && request.method === 'POST') {
    try {
      const archived = await archiveAutomationDefinition(taskArchiveMatch[1])
      if (!archived) return json(response, 404, { error: 'Task definition not found.' })
      return json(response, 200, archived)
    } catch (error) {
      return phase1Error(response, error)
    }
  }

  const taskItemMatch = pathname.match(/^\/api\/automations\/([a-zA-Z0-9_-]+)$/)
  if (taskItemMatch) {
    const taskId = taskItemMatch[1]
    if (request.method === 'GET') {
      try {
        const definition = await getAutomationDefinitionById(taskId)
        if (!definition) return json(response, 404, { error: 'Task definition not found.' })
        return json(response, 200, definition)
      } catch (error) {
        return phase1Error(response, error)
      }
    }
    if (request.method === 'PATCH') {
      try {
        const body = await readJson(request)
        const validated = validateAutomationDefinitionPayload(body, true)
        const updated = await updateAutomationDefinition(taskId, validated)
        if (!updated) return json(response, 404, { error: 'Task definition not found.' })
        return json(response, 200, updated)
      } catch (error) {
        return phase1Error(response, error)
      }
    }
  }

  /* -------------------------------------------------------------------------
     Oracle Timesheet Automation Endpoints
     ------------------------------------------------------------------------- */
  if (request.method !== 'POST' || !['/api/automation/validate-login', '/api/v1/oracle/timesheet/read', '/api/v1/oracle/timesheet/read-batch', '/api/v1/oracle/timesheet/update'].includes(pathname)) {
    return json(response, 404, { error: 'Not found.' })
  }

  if (!loginUrl) {
    return json(response, 503, { error: 'Oracle timesheet endpoints require ORACLE_LOGIN_URL or ORACLE_BASE_URL to be configured.' })
  }

  try {
    const body = await readJson(request)
    if (pathname === '/api/v1/oracle/timesheet/read-batch') {
      const rows = parseCsvText(requiredString(body.csvText, 'csvText'))
      const runId = `upload-${Date.now()}-${randomUUID()}`
      await persistBatchResult({ runId, source: body.caseId, status: 'RUNNING', readOnly: true, rows: [], perRow: [] })
      const perRow = []
      for (const row of rows) {
        const caseId = `TC-${String(row.row_number - 1).padStart(3, '0')}`
        if (!row['user name'] || !row.password) {
          perRow.push({ row_number: row.row_number, status: 'INVALID', message: 'Username and password are required.' })
          continue
        }
        const loginResult = await validateLogin({ username: row['user name'], password: row.password, caseId, persist: false, artifactRunId: runId })
        if (loginResult.status !== 'AUTHENTICATED_READ_ONLY' || !loginResult.timesheetData) {
          perRow.push({ row_number: row.row_number, status: 'NEEDS DATA', message: 'Read-only authentication or timesheet access failed.' })
          continue
        }
        perRow.push(...validateUpdateBatch([row], loginResult.timesheetData).per_row)
      }
      const status = perRow.every((row) => row.status === 'READY') ? 'READY' : perRow.some((row) => row.status === 'READY') ? 'PARTIAL' : 'INVALID'
      await persistBatchResult({ runId, source: body.caseId, status, readOnly: true, rows, perRow })
      return json(response, 200, {
        status,
        read_only: true,
        run_id: runId,
        per_row: perRow,
      })
    }
    if (pathname === '/api/v1/oracle/timesheet/update') {
      const rows = parseCsvText(requiredString(body.csvText, 'csvText'))
      if (!writeEnabled || readOnly) {
        const perRow = rows.map((row) => ({
          row_number: row.row_number,
          status: 'UPDATE FAILED',
          message: 'Live Oracle writes are disabled by server configuration.',
        }))
        const runId = `upload-${Date.now()}-${randomUUID()}`
        await persistBatchResult({ runId, source: body.caseId, status: 'UPDATE FAILED', readOnly: true, rows, perRow })
        return json(response, 409, {
          status: 'UPDATE FAILED',
          read_only: true,
          message: 'Live Oracle writes are disabled. No browser was launched and no timesheet data was changed.',
          diagnostics: { csv_rows_received: rows.length, writes_enabled: false },
          run_id: runId,
          per_row: perRow,
        })
      }
      const runId = `upload-${Date.now()}-${randomUUID()}`
      await persistBatchResult({ runId, source: body.caseId, status: 'RUNNING', readOnly: false, rows: [], perRow: [] })
      const perRow = []
      for (const row of rows) {
        const caseId = `TC-${String(row.row_number - 1).padStart(3, '0')}`
        let result
        if (!row['user name'] || !row.password || !row.date || !row.project || !row['log time']) {
          result = { updateResult: { status: 'INVALID', per_row: [{ row_number: row.row_number, status: 'INVALID', message: 'Required row data is missing or invalid.' }] } }
        } else {
          result = await validateLogin({
            username: row['user name'],
            password: row.password,
            caseId,
            updateRows: [row],
            persist: false,
            artifactRunId: runId,
          })
        }
        const item = result.updateResult?.per_row?.[0] || {
          row_number: row.row_number,
          status: result.status === 'AUTHENTICATED_READ_ONLY' ? 'UPDATE FAILED' : 'UPDATE FAILED',
          message: result.message || 'No update result was returned.',
        }
        perRow.push(item)
      }
      const status = perRow.every((item) => item.status === 'UPDATED')
        ? 'UPDATED'
        : perRow.some((item) => item.status === 'UPDATED')
          ? 'PARTIAL'
          : 'UPDATE FAILED'
      await persistBatchResult({ runId, source: body.caseId, status, readOnly: false, rows, perRow })
      return json(response, status === 'UPDATED' || status === 'PARTIAL' ? 200 : 422, {
        status,
        read_only: false,
        run_id: runId,
        per_row: perRow,
        message: status === 'UPDATED' ? 'All validated updates were saved and verified.' : status === 'PARTIAL' ? 'Valid test cases were updated; failed cases were not changed.' : 'No test case update was confirmed.',
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

initializeDatabase()
  .then(async () => {
    await interruptOrphanedBrowserTestExecutions().catch(() => {})
    server.listen(port, '127.0.0.1', () => {
      console.log(`Chronos automation service listening on http://localhost:${port}`)
      console.log(`Read-only mode: ${readOnly ? 'enabled' : 'disabled by configuration'}`)
      console.log('PostgreSQL persistence: enabled')
    })
  })
  .catch((error) => {
    console.error(`Database initialization failed: ${sanitizedError(error)}`)
    process.exitCode = 1
  })
