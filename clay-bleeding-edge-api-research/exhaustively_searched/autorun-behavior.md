# autoRun Behavior — CONFIRMED WORKING

**Status**: FULLY DOCUMENTED
**Investigated**: INV-023 (Session 8)

## How It Works

1. `PATCH /v3/tables/{id}` with `{tableSettings: {autoRun: true}}`
2. Insert rows via `POST /v3/tables/{id}/records`
3. Enrichment columns execute **automatically** — no `PATCH /run` needed
4. 500ms after insert, `metadata.status: "SUCCESS"` already visible on enrichment cells
5. Run history tracks autoRun entries with unique `runId`

## With Conditional Run

When enrichment column has `conditionalRunFormulaText: "{{f_score}} > 50"`:
- Score > 50 → auto-enrichment runs → `SUCCESS`
- Score <= 50 → auto-enrichment skipped → `ERROR_RUN_CONDITION_NOT_MET`

## Agent Pattern

Set autoRun=true on table → insert data → poll rows for metadata.status → all work is done automatically.
