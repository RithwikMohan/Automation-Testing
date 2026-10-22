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

## Phase 2.2 natural-language task planning

The Task Planner accepts an instruction for an active registered application and returns a structured plan for human review. Phase 2.2 does not execute approved plans or start a browser. Plans may only navigate to the selected application's saved Base URL, inspect a page, find a visible element by plain-language description, extract visible text, or verify a visible element. Arbitrary URLs, selectors, code, credentials, and state-changing actions are rejected server-side.

The default provider is local Ollama. Configure `LLM_PROVIDER=ollama`, `OLLAMA_MODEL`, and optionally `OLLAMA_BASE_URL` in the backend `.env`. An optional OpenAI-compatible provider can be selected with `LLM_PROVIDER=openai-compatible`, `LLM_MODEL`, and `LLM_API_KEY`; keep the key in the backend environment and never use a `VITE_*` variable for provider secrets. Provider errors and model output are validated on the backend. Planning does not require a database schema change.

## Phase 1 PostgreSQL integration tests

The mock-backed database CRUD tests run with `npm run test:backend`. Real PostgreSQL integration checks are separate and require a dedicated Neon branch:

1. Create a Neon branch named `chronos-test`; do not point integration tests at the production endpoint.
2. Set `TEST_DATABASE_URL` to that branch's connection URL in the ignored local `.env` file and set `CHRONOS_TEST_BRANCH_NAME=chronos-test`.
3. Run `npm run test:database-integration`.

The integration test refuses to write unless both URLs are configured, the branch confirmation matches, and the test endpoint hostname differs from `DATABASE_URL`. It uses generated IDs and removes only the exact test application and definitions it created. It does not initialize or alter the Oracle timesheet tables.

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

## Phase 2.1 Secure Generic Browser Exploration & Read-Only Inspection

Phase 2.1 enables secure, bounded, strictly read-only inspection of registered web applications through an enforced outbound network security boundary:

1. **Outbound Egress Security Proxy (`backend/exploration/networkSecurity.mjs`)**:
   - Pinned-IP proxy listening on loopback (`127.0.0.1`) with dynamic port allocation.
   - All Playwright browser traffic is routed through `--proxy-server`.
   - Comprehensive IP classification covering all reserved IPv4 and IPv6 CIDRs (RFC 1918, RFC 1122, RFC 3927 link-local/cloud metadata, RFC 6598 carrier-grade NAT, IPv4-mapped IPv6, 6to4, and cloud instance metadata).
   - Strict port policy (only standard web ports 80 and 443 permitted).
   - Destination scope enforcement: only exact registered domain or subdomains are permitted.
   - DNS answer validation: all returned IP addresses must be public; mixed public/private DNS answers are rejected immediately.
   - Pinned IP socket connection: avoids DNS rebinding and TOCTOU gaps by connecting directly to the validated IP address.

2. **Defense-in-Depth Request Interception & Redirect Gate**:
   - Playwright route interception validates every navigation and subresource request.
   - Rejects non-HTTP(S) protocols (`ftp:`, `file:`, `javascript:`, `data:`), embedded credentials, and out-of-scope targets.
   - Aborts malicious redirects and subresources attempting to reach internal or unapproved destinations.

3. **Strict Read-Only Inspection (`backend/exploration/explorationExtraction.mjs`)**:
   - Never clicks buttons, fills inputs, submits forms, uploads files, or runs user scripts.
   - Extracts page metadata: title, meta description, headings hierarchy, discovered links, forms summary, interactive elements count.
   - Detects authentication requirements (`AUTH_REQUIRED` status when login forms or password inputs are present).

4. **Persistence & UI**:
   - Stored in PostgreSQL `exploration_results` table and exposed via `/api/v1/applications/:id/explore` and `/api/v1/applications/:id/explorations`.
   - Frontend Applications view includes an active security banner, "Inspect" triggers, live inspection modal, and historical audit logs.

5. **Security Test Verification**:
   - Verified by dedicated test suites (`backend/networkSecurity.test.mjs` and `backend/exploration.test.mjs`), asserting that prohibited network requests (loopback, private IPs, malicious redirects, unsafe iframes) never reach internal endpoints.
