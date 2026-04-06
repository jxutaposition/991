# Session 3: Reach Goals

**Date**: 2026-04-06 (immediately after Session 2)
**Investigation**: INV-009

## Key Discoveries

### 1. WEBHOOK URL IS IN `state.url` (GAP-010 RESOLVED)

Creating a webhook source returns the webhook URL in `state.url`, NOT as a top-level field:

```json
{
  "id": "s_...",
  "type": "webhook",
  "typeSettings": {"hasAuth": false, "iconType": "Webhook"},
  "state": {
    "url": "https://api.clay.com/v3/sources/webhook/0afdf92c-d1ec-4ab1-8e70-3b491b493363",
    "numSourceRecords": 0
  }
}
```

The URL is a stable UUID-based path. This means we can:
- Create webhook sources programmatically
- Read the webhook URL back immediately
- Pass it to n8n/external systems for integration
- Delete test webhooks cleanly (`DELETE /v3/sources/{id}` returns `{"success": true}`)

### 2. ENRICHMENT TRIGGER `runRecords` FORMAT MAPPED (GAP-021 RESOLVED)

Tested four different `runRecords` shapes. All returned 200 with different `runMode` values:

| runRecords value | Response | runMode |
|---|---|---|
| `{}` (empty object) | `{recordCount: 0, runMode: "NONE"}` | NONE — no records selected |
| `{all: true}` | `{recordCount: 0, runMode: "NONE"}` | NONE — `all` is not a valid key |
| `{recordIds: []}` | `{recordCount: 0, runMode: "INDIVIDUAL"}` | INDIVIDUAL — selects specific rows |
| `{allRecords: true}` | `{recordCount: 0, runMode: "NONE"}` | NONE — `allRecords` not valid either |

**Conclusion**: `runRecords: {recordIds: ["r_xxx", ...]}` is the correct format for targeting specific rows. The table had 0 rows so recordCount was 0, but `INDIVIDUAL` mode confirmed `recordIds` is the right key. For "run all rows", likely need to pass all row IDs explicitly (or there's a different key we haven't found).

### 3. TABLE TYPES ARE IDENTICAL IN SCHEMA (GAP-018 PARTIALLY RESOLVED)

Created `spreadsheet` and `company` type tables:
- Both start with exactly 2 fields: `Created At`, `Updated At`
- Both start with 5 views
- No structural difference in the API response

Table type likely affects the UI (default columns shown, onboarding flow) but not the API schema. For API purposes, all types are functionally equivalent.

### 4. CREDIT MONITORING WORKS (GAP-023 RESOLVED)

`GET /v3/workspaces/{id}` returns real-time credit data:
```json
{
  "credits": {"basic": 574, "longExpiry": 0, "actionExecution": 9553},
  "creditBudgets": {"basic": 2000, "longExpiry": 0, "actionExecution": 10000},
  "currentPeriodEnd": 1775766582,
  "centsPerCredit": 5
}
```

Two credit pools:
- **basic**: 574 / 2,000 remaining (general enrichment credits)
- **actionExecution**: 9,553 / 10,000 remaining (action execution credits)

This enables pre-flight credit checks before running enrichments.

### 5. SOURCE DELETE WORKS CLEANLY (GAP-024 RESOLVED)

`DELETE /v3/sources/{id}` returns `{"success": true}`. Clean deletion, no cascading errors observed.

### 6. TABLE LISTING VARIANTS ALL 404

`/v3/tables/recent`, `/v3/tables/list`, `/v3/tables/search`, `/v3/tables/all` all return 404 with "Table {x} does not exist" — they're being interpreted as table IDs, not endpoints. These paths NEVER existed as endpoints; the 401 responses in INV-006 were because any `/v3/tables/{something}` path returns 401 when unauthenticated (it tries to look up that table ID).

**Corrected understanding**: `/v3/workspaces/{id}/tables` is the ONLY table listing endpoint. The others were false positives.

### 7. IMPORT WEBHOOK/CSV ENDPOINTS ARE JOB IDs, NOT ENDPOINTS

`GET /v3/imports/webhook` returns "Import Job with id webhook not found" — it's treating "webhook" as a job ID. Same for "csv". These are NOT separate endpoints; `/v3/imports/{importJobId}` is the pattern.

### 8. RATE LIMIT: 50 REQUESTS, ZERO THROTTLING

50 rapid-fire requests to `/v3/me` with zero delays:
- 0 out of 50 rate-limited
- Average latency: 20ms
- All 200

Clay either has no rate limiting on the v3 API or the limits are extremely high (100+ req/s).

### 9. NO authAccountIds FOUND IN EXISTING TABLES

Scanned 5 tables — none had enrichment-type (action) columns with `authAccountId` in typeSettings. This is expected since the workspace is new and hasn't been used for enrichment yet. The extraction approach is correct; it just needs a table with actual enrichment columns.

## Resolved Gaps

- **GAP-010**: Webhook URL retrieval — in `state.url`
- **GAP-018**: Table type semantics — types are functionally identical in API
- **GAP-021**: runRecords format — `{recordIds: string[]}` for INDIVIDUAL mode
- **GAP-023**: Credit monitoring — real-time via workspace endpoint
- **GAP-024**: Source delete — clean deletion with `{success: true}`

## Corrected Misunderstandings

- `/v3/tables/recent`, `/v3/tables/list`, etc. are NOT endpoints — they were false positive 401s in INV-006 (table ID lookup). Updated to 404.
- `/v3/imports/csv`, `/v3/imports/webhook` are NOT separate endpoints — they're the import job ID pattern `/v3/imports/{jobId}`. Updated.
- `/v3/sources/list` is NOT an endpoint — use `GET /v3/sources?workspaceId=` instead.
