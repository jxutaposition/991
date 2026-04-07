# Demo runbooks

Short checklists for proving the system end-to-end. Operational steps (credentials, which Clay workbook) live in **per-tenant uploaded knowledge**, not in agent bundles.

## 1. Clay break / fix (sandbox)

**Goal:** Show the Clay operator using real API tools against a **disposable** workbook.

**Prerequisites:**

- Clay session cookie configured for the demo client.
- A sandbox workbook + table created for demo (or permission to create/delete in that workbook only).

**Steps:**

1. Create a session whose plan includes a single `clay_operator` node (or orchestrator task): e.g. “List tables in workbook X, confirm table `demo_sandbox` exists.”
2. Manually delete `demo_sandbox` in the Clay UI (or via API in a controlled script).
3. Send a follow-up: “Table `demo_sandbox` is missing — recreate it with the same columns as before and confirm with `clay_list_tables` / `clay_get_table_schema`.”
4. **Pass criteria:** Inspector shows successful `clay_create_table` (and related) calls; schema read returns expected columns.

**Safety:** Never run delete/recreate against production tables; use a dedicated workbook.

---

## 2. Chat learning + observatory

**Goal:** Show learnings extracted from a session and visible **only for that workspace** in the Knowledge Observatory.

**Prerequisites:**

- Backend and DB running; user has a `tenant_id` / active client selected in the UI.

**Steps:**

1. Complete or pause an execution session that had real user ↔ agent chat.
2. Call `POST /api/chat-learnings/analyze/:session_id` (or trigger the same from your admin path if wrapped).
3. Open **Knowledge → Observatory** with that client selected.
4. Confirm **Chat Learning** counts and **All Learnings** drill-down show rows for sessions whose `client_id` matches (no cross-tenant leakage).
5. Optional: run `search_knowledge` in a session, then check **Retrieval activity** / retrieval drill-down for hits scoped to that tenant’s documents.

**Pass criteria:** New learnings appear with expected `status` (`pending`, `conflict`, `distilled`, etc.); observatory aggregates match drill-down totals for that tenant.

---

## 3. Dashboard: snapshot vs live (product choice)

- **Snapshot demo (current default):** Dashboard Builder writes a `dashboard_spec` with data baked into widget JSON; [`frontend/src/components/dashboard-renderer.tsx`](../frontend/src/components/dashboard-renderer.tsx) renders it statically. Enough for “agent queried Supabase once and published a spec.”
- **Live demo:** Requires implementing refresh using `supabaseUrl` / `supabaseAnonKey` / `refreshInterval` on the spec (not wired today). Track as a separate engineering task if the demo must show auto-updating tiles.

---

## 4. Automated check: dashboard numbers trace to Supabase

**Goal:** Prove (with real HTTP to PostgREST) that metric values in a minimal `dashboard_spec` match rows in Supabase — no mocked tool layer.

**Test:** [`backend/tests/dashboard_pipeline_e2e.rs`](../backend/tests/dashboard_pipeline_e2e.rs) (`#[ignore]` by default).

**Run:** Set `RUN_DASHBOARD_PIPELINE_E2E=1`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and create the table described in the test module doc; then:

`cargo test -p lele2-backend --test dashboard_pipeline_e2e -- --ignored --nocapture`

Extend this test when you have a stable Clay → n8n → Supabase sandbox to assert the full chain.

---

## Remaining product gaps (from audit)

| Item | Owner |
|------|--------|
| Lock demo env (Clay, n8n base URL + `projectId`, Supabase) | Operator + uploaded runbook |
| Re-upload tenant corpus (n8n layout, Lovable map, etc.) | Operator |
| Execute UI: Clay `_workspace_id`, workflow IDs, clearer tool timeline | Engineering |
| Observatory UI: explicit user / expert / project “buckets” beyond current layout | Engineering + design |
