# Chronos — Intelligent Timesheet Automation

Vite/React/TypeScript dashboard with an opt-in local Node/Playwright service for read-only Oracle APEX login validation.

## Run locally

```bash
npm install
npm run dev
```

The frontend parses CSV files locally in the browser and sends the CSV to the local backend when processing is requested. CSV uploads are limited to 25 MB. The dashboard contains no seeded run data; runs and case results come from PostgreSQL.

PostgreSQL is configured with `DATABASE_URL` in the local `.env`. The backend uses it only for application data persistence; never commit the connection string or share it in chat.

## Read-only Playwright service

Copy `.env.example` to `.env` and keep `AUTOMATION_READ_ONLY=true` (the default). The Oracle login URL is configured through `ORACLE_LOGIN_URL` (or `ORACLE_BASE_URL`):

```bash
npm install
npx playwright install chromium
npm run backend
```

The service exposes `POST /api/automation/validate-login` for a single test case:

```json
{ "caseId": "TC-001", "username": "provided-at-runtime", "password": "provided-at-runtime" }
```

Each request creates a new browser context and navigates to the configured login URL. It verifies authentication using `ORACLE_AUTHENTICATED_SELECTOR` when configured, otherwise it requires that the login URL is no longer present and no configured login error is visible. It never logs or returns credentials, reuses sessions, or modifies timesheet data. Failed cases are sanitized and retain a screenshot/video artifact under `backend/artifacts/` when possible.

The default selector configuration is intentionally conservative and can be overridden in `.env` for the deployed APEX page. After authentication, the service opens the APEX navigation control, discovers a visible `My Timesheet` link from the live DOM, follows its observed control without constructing a URL, and verifies a read-only grid containing a table/grid, date headers, project/task text, and hour-like cells. It also records disabled/readonly/leave/holiday evidence. It does not enter, change, save, or submit timesheet data.

For the current Oracle APEX application, the authenticated content marker is configured as:

```env
ORACLE_AUTHENTICATED_SELECTOR=main#mainContent
```

After the marker is detected, the service captures an authenticated-page screenshot and keeps the page open for `POST_LOGIN_CAPTURE_MS` (3 seconds by default) before closing the isolated context. This makes the successful login visible in the Playwright recording without entering or modifying timesheet data. After Sign In, the service polls the URL and DOM for at most `LOGIN_VERIFICATION_TIMEOUT_MS` instead of waiting for all network activity to finish.

The current application also verifies the stable authenticated paths:

```env
ORACLE_AUTHENTICATED_PATHS=/ords/r/drmworkspace/timesheet-application/home,/ords/r/drmworkspace/timesheet-application/home1
```

These paths are based on the APEX navigation flow. Session query parameters are intentionally excluded and are never hardcoded or reused.

The Sign In click does not wait for all APEX network activity to settle. The service polls the URL and DOM instead, matching the successful Selenium flow and preventing the APEX loading screen from blocking the request.

The Playwright context also waits for the exact APEX form to be visible, allows the form to finish initializing, dismisses common overlays, uses a fresh browser context with no stored session, and records sanitized login request/response diagnostics when verification fails. Session query parameters are never written to diagnostics.

Navigation failures are bounded by `TIMESHEET_NAVIGATION_TIMEOUT_MS` and return `FAILED_TIMESHEET_NAVIGATION` or `FAILED_TIMESHEET_GRID` with sanitized evidence. The backend captures both `<case>-authenticated.png` and `<case>-timesheet.png` when those stages succeed.

### Read-only timesheet extraction

`POST /api/v1/oracle/timesheet/read` uses the same request shape and isolated browser workflow as the login validator:

```json
{ "caseId": "TC-001", "username": "provided-at-runtime", "password": "provided-at-runtime" }
```

After Phase 2 navigation succeeds, the service reads only visible DOM values from the weekly timesheet. It returns `timesheetData` with:

- `status`: `SUCCESS`, `PARTIAL`, or `FAILED`
- `week.start_date` and `week.end_date`
- `dates`: observed labels and normalized dates
- `projects`: dynamically detected project rows with IDs, names, and per-day values
- `days[].hours_status`: `READ`, `EMPTY`, `UNAVAILABLE`, `AMBIGUOUS`, `DISABLED`, or `LEAVE`
- `diagnostics`: detected row/column counts and sanitized warnings

Explicit numeric zero is preserved as `0`; unavailable, ambiguous, disabled, and leave cells are never converted to zero. The endpoint does not fill inputs or click Save, Submit, Apply, navigation date controls, or other write controls. A `PARTIAL` extraction is returned with warnings rather than being presented as complete.

Run backend tests with:

```bash
npm run test:backend
```

The tests use local APEX-like HTML fixtures for successful menu discovery, missing navigation controls, navigation/grid timeouts, and grid evidence checks. They do not contact Oracle.

## Phase 4 update safeguards

The update foundation is intentionally disabled by default:

```env
ORACLE_WRITE_ENABLED=false
AUTOMATION_READ_ONLY=true
AUTO_UPDATE_ON_UPLOAD=false
```

When `AUTO_UPDATE_ON_UPLOAD=true`, the upload page starts the backend update workflow immediately after parsing a CSV. This does not bypass safety controls: live changes still require `ORACLE_WRITE_ENABLED=true` and `AUTOMATION_READ_ONLY=false`. With the default read-only configuration, the backend returns a sanitized disabled result and does not launch a browser for the update request.

CSV updates require these normalized headers: `user name`, `password`, `date`, `project`, `log time`, and `work description`. The backend preflight validator matches projects case-insensitively, validates visible dates and current hours, aggregates same-day additions, and enforces the eight-hour daily limit. Invalid, unmatched, ambiguous, disabled, leave, and unreadable cells are rejected before any write.

Live Oracle writes are not enabled or exercised. The mock persistence tests verify the update and post-write comparison shape without clicking Save or changing production data. Enabling writes requires explicit application-owner approval and separate verification of the live input and Save controls.

The guarded update route is `POST /api/v1/oracle/timesheet/update` with `{ "csvText": "..." }`. While writes are disabled it validates only that the CSV is well-formed, returns `UPDATE FAILED` for every row, and launches no browser. It never returns parsed passwords or CSV row contents. Each batch is persisted as one upload-level PostgreSQL run, including invalid, rejected, and failed rows, while isolated browser recordings and screenshots are attached to that run. When explicitly enabled, the route performs a complete per-user read-only preflight before opening fresh write contexts, re-reads each target cell immediately before editing, adds hours, appends descriptions, saves through the verified controls, and independently verifies the persisted hour values. An uncertain save is not retried automatically.

## CSV format

The upload preview accepts either the legacy headers `username`, `date`, `hours`, and `workdescription`, or the Phase 4 headers `user name`, `password`, `date`, `project`, `log time`, and `work description`. Existing hours are shown as unavailable until read-only Oracle validation or processing; the frontend never fabricates current timesheet values. Passwords are parsed only as part of the upload operation and are not displayed or stored.

Do not commit real credentials or production CSV files. Use [examples/phase4-sanitized.csv](examples/phase4-sanitized.csv) as a template and provide credentials only at runtime.

## Structure

The demo is intentionally compact while preserving separations between shell navigation, upload/validation, run inspection, recordings, reporting, settings, and the backend automation boundary.
