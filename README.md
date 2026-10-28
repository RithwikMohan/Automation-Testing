# Chronos — Intelligent Timesheet Automation

Vite/React/TypeScript dashboard with an opt-in local Node/Playwright service for read-only Oracle APEX login validation.

## Rule-Based Browser Test Suites

The Rule-Based Tests screen imports test cases for any active registered application. CSV import is previewed and validated before it creates a suite. Required columns are test_case_id, name, preconditions, steps, test_data, expected_result, and priority; tags is optional. Preconditions and test_data are JSON arrays/objects. Test steps may be newline or semicolon separated, including within a quoted multiline CSV field. Credential-like columns and test-data keys are rejected. Raw CSV text is not persisted.

Rule plan version 1.0 supports:

    navigate: /path
    Navigate to /login
    Open https://example.com/products
    click role=button[name="Continue"]
    Click the Sign In button
    create role=button[name="Create"]
    update role=button[name="Save"]
    delete role=button[name="Delete"]
    fill label="Email" <- ${test_data.email}
    select label="Country" <- ${test_data.country}
    check label="Accept terms"
    uncheck label="Subscribe"
    wait visible text="Ready" timeout=5000
    read text="Result" as result
    assert visible role=heading[name="Dashboard"]
    assert text text="Status" contains "Complete"
    assert url contains "/home"
    Verify that the Dashboard heading is visible
    Assert that the Email field has value ${test_data.email}
    Assert that the result count is greater than 0

Supported locators are role/name, exact text, label, placeholder, test ID, and simple ID/class CSS selectors. URL actions resolve against the registered application and must match the primary or explicitly approved navigation origin. Unknown instructions, missing data references, unsafe URLs, ambiguous locators, and cases over 50 actions are rejected during preview. The rule engine compiles recognized instructions to structured actions; it never evaluates CSV content as code.

Cases, suites, execution records, step results, and artifact metadata use separate browser_test_* tables created non-destructively by the existing database initializer. A unique active-execution index prevents duplicate concurrent runs. Step results and artifacts are written incrementally; interrupted work is marked INTERRUPTED when the backend restarts. Evidence files are stored under ARTIFACT_DIR/browser-tests; deployments should mount that directory on durable storage.

Every click or form-control change requires a per-run human approval in the UI. Create, update, and delete rules require explicit per-run approval and a same-origin POST form; the request is allowed only while that declared action is active and only to the form action path observed on the registered application. Every write must be followed by an assertion before another write. An uncertain write response is failed without retry. Other application POSTs and non-POST write methods remain blocked. For applications registered with manual authentication, the backend opens an isolated headed browser; a user can log in and resume the test. During that paused window only, a form-encoded POST to a same-origin login form action is allowed. Credential-reference authentication is reported as blocked until a vault provider is configured.

Successful read-only runs may include Playwright video and trace evidence. Failures include a screenshot with input controls masked. Video and traces are not recorded for manual-login or test-data-entry runs. Reports expose only sanitized step observations and artifact references; test-data values are not returned by the API.

Import endpoints are POST /api/browser-tests/import/preview and POST /api/browser-tests/import. Suite, case, execution, report, and artifact history is available below /api/browser-tests. Run npm run test:backend for CSV, interpreter, persistence, execution, policy, and existing application regression tests.

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

## Oracle HCM hiring CSV schema v1

The dedicated hiring schema draft is [examples/oracle-hcm-hiring-v1.csv](examples/oracle-hcm-hiring-v1.csv). It accepts one employee per row with `employee_id`, `first_name`, `last_name`, `legal_employer`, `action_reason`, `business_unit`, and `position`. Hire Date and Hire Action are omitted because Oracle supplies their defaults. `email`, `phone`, and `expected_outcome` are optional; expected outcomes are `success` or `validation_failure`. Credentials and browser instructions are not valid columns. The parser and row validator are in `backend/integrations/oracleHcm/hireEmployee.mjs`; the preview projection omits employee identifiers, names, and contact details.

The Oracle HCM Hiring page currently provides an authenticated, read-only wizard inspection session. Set backend-only `CHRONOS_HR_ACCESS_TOKEN` to a random value of at least 32 characters to enable it; the page holds this token in memory only. The inspection window uses the existing outbound proxy, TLS checks, origin approvals, and manual login gate. One session can run at a time and expires after ten minutes. Snapshots are returned to the local UI in memory only; the snapshot is withheld if a visible wizard text field contains data. Screenshots, video, traces, input values, cookies, and auth state are not collected or persisted. Any non-login POST remains blocked.

The employee creation workflow is not enabled. The current inspection session cannot advance a wizard step that requires POST, and the live tenant was not inspectable from this environment. No verified HCM locator map, wizard transitions, complete dropdown values, validation messages, final submission behavior, or Person Management search flow have been recorded. The screenshots referenced by the brief were not available among the files in this workspace, so no locator decisions were based on them. The shared local access token is not a multi-user identity system; do not deploy HR data persistence or recordings until named-user authorization, artifact access controls, and audit requirements are implemented and verified. Do not send employee CSV data to the generic browser-test importer; it persists test data and is not designed for HR records. No hiring database migration exists.

## Structure

The demo is intentionally compact while preserving separations between shell navigation, upload/validation, run inspection, recordings, reporting, settings, and the backend automation boundary.

## Phase 2.1 Secure Generic Browser Exploration & Read-Only Inspection

Phase 2.1 enables secure, bounded, strictly read-only inspection of registered web applications through an enforced outbound network security boundary:

1. **Outbound Egress Security Proxy (`backend/exploration/networkSecurity.mjs`)**:
   - Pinned-IP proxy listening on loopback (`127.0.0.1`) with dynamic port allocation.
   - All Playwright browser traffic is routed through `--proxy-server`.
   - Chromium QUIC, DNS prefetch, background network traffic, non-proxied WebRTC UDP, and the implicit loopback bypass are disabled for inspection sessions.
   - Comprehensive IP classification covering all reserved IPv4 and IPv6 CIDRs (RFC 1918, RFC 1122, RFC 3927 link-local/cloud metadata, RFC 6598 carrier-grade NAT, IPv4-mapped IPv6, 6to4, and cloud instance metadata).
   - Strict port policy (only standard web ports 80 and 443 permitted).
   - Destination enforcement uses exact normalized origins configured per registered application. No public suffix, CDN, or corporate-domain wildcard is trusted.
   - DNS answer validation: all returned IP addresses must be public; mixed public/private DNS answers are rejected immediately.
   - Pinned IP socket connection: avoids DNS rebinding and TOCTOU gaps by connecting directly to the validated IP address.

2. **Defense-in-Depth Request Interception & Redirect Gate**:
   - Playwright route interception validates every navigation and subresource request.
   - Separates primary navigation, explicitly approved authentication/navigation origins, and approved resource origins.
   - Rejects non-HTTP(S) protocols (`ftp:`, `file:`, `javascript:`, `data:`), non-read-only request methods, embedded credentials, and unapproved destinations.
   - Revalidates redirect destinations; resource approval never grants top-level navigation permission.

3. **Strict Read-Only Inspection (`backend/exploration/explorationExtraction.mjs`)**:
   - Never clicks buttons, fills inputs, submits forms, uploads files, or runs user scripts.
   - Extracts page metadata: title, meta description, headings hierarchy, discovered links, forms summary, interactive elements count.
   - Detects authentication requirements (`AUTH_REQUIRED` status when login forms or password inputs are present).

4. **Persistence & UI**:
   - Stored in PostgreSQL `exploration_results` table and exposed via `/api/v1/applications/:id/explore` and `/api/v1/applications/:id/explorations`.
   - Frontend Applications view includes an active security banner, "Inspect" triggers, live inspection modal, and historical audit logs.

5. **Security Test Verification**:
   - Verified by dedicated test suites (`backend/networkSecurity.test.mjs` and `backend/exploration.test.mjs`), asserting that prohibited network requests (loopback, private IPs, malicious redirects, unsafe iframes) never reach internal endpoints.

### Configuring origins for a registered application

The Base URL defines the primary origin for initial navigation. In Applications, edit the application to configure **Approved resource origins** (images, stylesheets, fonts, scripts, and other page requests) separately from **Approved top-level navigation origins** (for example, a reviewed identity provider used during an authentication redirect). Enter complete origins such as `https://static.example.net`, one per line. Wildcards, path-based approvals, credentials, and non-standard ports are rejected. Resource hosts are never approved automatically when observed. Additions and removals are recorded in `application_origin_audit`.

Existing application rows remain compatible: new JSONB allowlists are added with non-destructive defaults, so existing records retain primary-origin-only behavior. `audit_summary` is also added non-destructively to exploration results. A blocked optional resource produces a partial result when the main document remains inspectable. Diagnostics contain normalized host/port and policy outcomes; query values, cookies, authorization headers, and form values are not included.
