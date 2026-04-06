# Session 4: Gap Discovery & Programmatic Investigation

**Date**: 2026-04-06
**Duration**: ~30 minutes (5 parallel investigation scripts)
**Investigations**: INV-013 through INV-017

## Summary

Brainstormed 10 new gaps beyond the existing 8 TODOs, then ran 5 parallel investigation scripts against the live v3 API. Resolved or made major progress on 12 items.

## Key Discoveries

### BREAKTHROUGH: Table Duplication (INV-016)
- `POST /v3/tables/{id}/duplicate` — **WORKS!** Returns full table with "Copy of" prefix
- `POST /v3/tables` with `sourceTableId` or `duplicateFromTableId` — **BOTH WORK** as alternative duplication paths
- `POST /v3/workbooks/{id}/duplicate` — **WORKS!** Workbook-level duplication confirmed
- `POST /v3/workbooks` — **WORKS!** Workbook creation confirmed

### BREAKTHROUGH: View CRUD (INV-015)
- `POST /v3/tables/{id}/views` — **WORKS!** View creation confirmed. Returns full view object with id, name, fields, filter, sort
- `PATCH /v3/tables/{id}/views/{viewId}` — **WORKS!** View rename confirmed
- Filter/sort PATCH returns 200 but shows null — payload format may need refinement
- Only `/v3/tables/{id}/views/*` path works; `/v3/views`, `/v3/grid-views` all 404

### BREAKTHROUGH: Enrichment Cell Metadata States (INV-013)
Documented the full metadata state machine from existing enrichment tables:

**Observed `metadata.status` values:**
- `SUCCESS` — completed successfully, `value` contains result with preview text
- `ERROR_OUT_OF_CREDITS` — failed due to credit exhaustion
- `ERROR_BAD_REQUEST` — failed with bad request error
- `(no status)` — `isStale: true, staleReason: "TABLE_AUTO_RUN_OFF"` — not yet run

**Additional metadata fields:**
- `isPreview: boolean` ��� value is a summary/preview
- `imagePreview: string` — icon URL
- `isStale: boolean` — enrichment hasn't been triggered
- `staleReason: "TABLE_AUTO_RUN_OFF"` — auto-run disabled

**recordMetadata.runHistory:**
```json
{
  "f_fieldId": [
    {"time": 1775443230930, "runId": "run_0td1wrisJxroYsg5UxE"},
    {"time": 1775443585553, "runId": "run_0td1x1ddn8m87zK6S3g"}
  ]
}
```
Per-field array with unix timestamp + unique run ID. Multiple entries = multiple runs.

### Pagination (INV-014)
- `limit=10000` returns all rows (160 tested, 39ms). **Large limit is the workaround.**
- Default limit (no param) = 100 rows
- All cursor/page/offset params are silently ignored
- No row count in table schema
- No pagination metadata in response

### Formula Auto-Evaluation (INV-017)
- Formulas auto-evaluate immediately on row insert (no trigger needed)
- Formulas auto-re-evaluate when dependent cells are updated
- `PATCH /run` also works explicitly for formulas
- Formula cell metadata: `{"status": "SUCCESS"}` (same as enrichments)

### CSV Export Async Job (INV-017)
- `POST /v3/tables/{id}/export` — **WORKS!** Creates export job
- Response: `{id: "ej_xxx", status: "ACTIVE", fileName: "...", uploadedFilePath: null}`
- Async model: POST to create → poll for `uploadedFilePath` → download

### Other Findings
- Table history/restore/runs/jobs/stats endpoints — all 404 (UI-only)
- Row sorting via query params — all ignored (view-level only)
- Credit-specific endpoints — all 404 (only via workspace details)
- `GET /v3/api-keys` requires `?resourceType=user&resourceId=` params
- 42 workbooks found in workspace via `GET /v3/workspaces/{id}/workbooks`
- `GET /v3/workbooks/{id}` and `PATCH /v3/workbooks/{id}` — 404 (no individual workbook endpoints)

## TODOs Resolved

| TODO | Status | Resolution |
|------|--------|-----------|
| TODO-004 (enrichment completion) | **RESOLVED** | Poll rows, check `metadata.status` for SUCCESS/ERROR_* |
| TODO-005 (enrichment errors) | **RESOLVED** | Error types in `metadata.status`: ERROR_OUT_OF_CREDITS, ERROR_BAD_REQUEST |
| TODO-006 (formula re-eval) | **RESOLVED** | Formulas auto-evaluate. No trigger needed. |
| TODO-009 (pagination) | **RESOLVED** | Use `limit=10000` (or larger). No cursor/page/offset mechanism. |
| TODO-010 (view CRUD) | **PARTIALLY RESOLVED** | Create + rename work. Filter/sort update needs payload refinement. |
| TODO-011 (enrichment metadata) | **RESOLVED** | Full state machine documented |
| TODO-013 (duplication) | **RESOLVED** | POST /v3/tables/{id}/duplicate. Also POST /v3/workbooks/{id}/duplicate |
| TODO-014 (trigger response) | **RESOLVED** | Returns `{recordCount: N, runMode: "INDIVIDUAL"}`. No job ID. |
| TODO-017 (run history) | **RESOLVED** | recordMetadata.runHistory per field with {time, runId} |

## New Endpoints Confirmed

| Method | Path | Status |
|--------|------|--------|
| POST | /v3/tables/{id}/duplicate | confirmed |
| POST | /v3/tables/{id}/views | confirmed |
| PATCH | /v3/tables/{id}/views/{viewId} | confirmed |
| POST | /v3/workbooks/{id}/duplicate | confirmed |
| POST | /v3/workbooks | confirmed |
| POST | /v3/tables/{id}/export | confirmed |
