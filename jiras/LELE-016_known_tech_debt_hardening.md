# LELE-016: Known Tech Debt & Hardening — Post-Audit Fixes

## Problem
An end-to-end audit of the platform revealed several systemic issues that are not security-critical today (UUIDs constrain injection surface, no public exposure yet) but will become blockers as we move toward production, multi-tenant usage, and external integrations like Slack.

## Issues

### 1. SQL String Interpolation (no parameterized queries)
Every SQL query in `routes.rs`, `work_queue.rs`, `narrator.rs` uses `format!()` string interpolation instead of `sqlx::query!()` parameterized queries. UUIDs are validated via `.parse::<Uuid>()` before interpolation which constrains the injection surface, but any future endpoint accepting free-text user input is vulnerable.

**Files**: `routes.rs` (12+ queries), `work_queue.rs` (8 queries), `narrator.rs` (3 queries)

### 2. Hardcoded `http://localhost:3001` in Chrome Extension
The extension's `background.ts` and `SidePanel.tsx` hardcode the backend URL. No mechanism exists to switch between dev/staging/prod environments.

**Files**: `extension/src/background.ts:3`, `extension/src/sidepanel/SidePanel.tsx:16`

### 3. Missing Extension Icon Assets
`manifest.json` references `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` but no `icons/` directory exists. Extension loads with broken icon.

**Files**: `extension/manifest.json:43-53`

### 4. Frontend Fetch Calls Don't Check `response.ok`
All 7 client-side pages use `.then(r => r.json())` without checking `r.ok` first. If the API returns a 4xx/5xx with HTML or non-JSON body, the UI silently fails with no error feedback to the user.

**Files**: `catalog/page.tsx`, `catalog/[slug]/page.tsx`, `execute/[session_id]/page.tsx`, `observe/page.tsx`, `observe/[session_id]/page.tsx`, `agent-prs/page.tsx`, `agent-prs/[pr_id]/page.tsx`

### 5. `distillation_count` Never Incremented
`observation_sessions.distillation_count` column is never updated when narrations are inserted into the `distillations` table. The column always reads 0. Either add an explicit UPDATE in `persist_narration()` or use a Postgres trigger.

**Files**: `narrator.rs:persist_narration()`, `migrations/002_observation.sql`

## Design Decisions
- **SQL parameterization**: Migrate to `sqlx::query!()` with compile-time checked queries. This is the idiomatic sqlx approach and catches schema drift at build time. Do it file-by-file starting with `routes.rs` (highest exposure).
- **Extension config**: Add a `config.ts` that reads from `chrome.storage.sync` with a dev-mode fallback to `localhost:3001`. Expose a settings input in the popup.
- **Frontend error handling**: Create a shared `apiFetch()` wrapper in `lib/api.ts` that checks `response.ok`, parses JSON, and returns `{ data, error }`. Replace all raw `fetch()` calls.
- **Distillation count**: Add `UPDATE observation_sessions SET distillation_count = distillation_count + 1 WHERE id = '{session_id}'` to `persist_narration()`.

## Acceptance Criteria
- [ ] All SQL queries in `routes.rs` use parameterized queries (`sqlx::query!` or `sqlx::query_as!`)
- [ ] All SQL queries in `work_queue.rs` use parameterized queries
- [ ] All SQL queries in `narrator.rs` use parameterized queries
- [ ] Extension backend URL is configurable (not hardcoded)
- [ ] Extension icon assets exist and render correctly
- [ ] All frontend fetch calls check `response.ok` and show user-facing error states
- [ ] `distillation_count` increments correctly when narrations are created
