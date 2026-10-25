# Workflow capture architecture and integration inventory

## Existing Chronos components

- `src/App.tsx` contains the Applications page, Oracle HCM inspection UI, Task Planner, and Rule-Based Tests CSV import, approval, execution history, and recording views.
- `backend/server.mjs` owns the HTTP API and routes. It validates registered applications and compiles CSV rows before importing suites.
- `backend/database.mjs` owns additive PostgreSQL schema initialization and application, suite, case, execution, and artifact persistence.
- `backend/browserTests/csvImport.mjs`, `interpreter.mjs`, and `actionRegistry.mjs` parse the legacy test-case CSV format, compile deterministic steps, and enforce an action/locator allowlist.
- `backend/browserTests/execution.mjs` executes imported cases with isolated Playwright contexts, per-case recording, manual login/session reuse, explicit action approval, and persistence.
- `backend/exploration/networkSecurity.mjs` implements the outbound proxy, DNS/IP validation, registered-origin policy, manual-login POST gate, and approved write gate.
- `backend/exploration/*` implements read-only website inspection. `backend/integrations/oracleHcm/*` implements the separately gated Oracle HCM wizard inspection.

## New workflow modules

- `backend/browserTests/workflowRecorder.mjs` owns headed manual-capture sessions, action normalization, login gating, pause/resume, review, and save/cancel cleanup.
- `backend/workflows/workflowDefinition.mjs` validates structured definitions, registered navigation scope, action/locator allowlists, and variable references.
- `backend/workflows/locatorResolution.mjs` resolves ordered locator candidates and fails on ambiguity rather than guessing.
- `backend/workflows/variableDetection.mjs` derives stable field keys. It excludes tokens and other secrets; only a manually observed password input may be explicitly included as a `password` CSV variable.
- `backend/workflows/csvTemplate.mjs` serializes quoted CSV with one column per included variable.
- `backend/browserTests/workflowRecorder.test.mjs` and `backend/workflows/workflows.test.mjs` test recording normalization, review/save, auth gating, variable/CSV generation, locator resolution, and scope validation.

## Persistence and API integration

Schema changes are additive. `application_workflow_templates` stores the current reviewed definition and template; `application_workflow_versions` retains immutable per-application versions; `browser_test_cases.workflow_version` associates imported cases with their source version. Existing application, exploration, suite, execution, and artifact rows are not dropped.

Capture APIs are under `/api/applications/:id/workflow-recordings` and `/api/workflow-recordings/:id` (`begin`, `pause`, `resume`, `finish`, `save`, and cancel). Saved definitions/templates are read at `/api/applications/:id/workflow-template` and `/api/applications/:id/workflow-versions`. Existing `/api/browser-tests/import/preview` and `/import` accept workflow CSV headers only when a saved workflow version is explicitly selected; legacy `test_data` CSV remains supported.

## Current boundaries

The attended capture browser can navigate to public HTTP(S) origins and load their resources through the outbound proxy; DNS/IP validation remains enforced, and private/internal destinations still need explicit approval. A business POST is permitted only for an exact same-origin form path tied to a captured click and remains subject to per-run approval on replay. Other SPA/API mutations remain blocked. Login field names and locators can be captured, but typed values are not; a reviewed workflow can generate blank username/password columns. Password values entered into uploaded CSVs are stored in browser test case data in PostgreSQL and are never returned by the case-list APIs or included in diagnostics. Protect the CSV and database accordingly. Browser-run integration still depends on an installed Playwright browser; deterministic unit fixtures do not substitute for live-browser verification.
