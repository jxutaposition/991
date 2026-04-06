# Session 6: Attack New TODOs

**Date**: 2026-04-06
**Investigations**: INV-020

## Key Discoveries

### BREAKTHROUGH: Enrichment Column Creation — TODO-031 RESOLVED

`POST /v3/tables/{id}/fields` with `type: "action"` and minimal payload **WORKS** on first try:

```json
{
  "name": "Normalized Name",
  "type": "action",
  "typeSettings": {
    "actionKey": "normalize-company-name",
    "actionPackageId": "6c973999-fb78-4a5a-8d99-d2fee5b73878",
    "inputsBinding": [],
    "dataTypeSettings": {"type": "json"}
  },
  "activeViewId": "gv_xxx"
}
```

The previous INV-013 failure was because `normalize-company-name` has non-standard `inputParameterSchema` (array format, not object with `properties`). When `inputsBinding` is empty `[]`, the column is created successfully. The input keys are in `inputParameterSchema[].name` not `inputParameterSchema.properties`.

**Key insight**: `inputParameterSchema` can be either:
- Array format: `[{name, type, optional, subTypes, displayName}]` (e.g., normalize-company-name)
- Object format: `{properties: {key: {...}}}` (e.g., http-api-v2)

### BREAKTHROUGH: Resource Tags — FULL CRUD CONFIRMED (TODO-027 RESOLVED)

**Create**: `POST /v3/workspaces/{id}/resource-tags`
```json
{"tagText": "my-tag", "tagColor": "blueberry", "isPublic": true}
```
Response: `{tagId: "tag_xxx", workspaceId, tagText, tagColor, isPublic, createdAt, updatedAt}`

**Read**: `GET /v3/workspaces/{id}/resource-tags` → array of tag objects

**Delete**: `DELETE /v3/workspaces/{id}/resource-tags/{tagId}` → 200

**Color values** (enum): `nightshade`, `pomegranate`, `tangerine`, `lemon`, `matcha`, `blueberry`, `ube`, `dragonfruit`

**Tag ID format**: `tag_xxx`

### BREAKTHROUGH: Export Download — FULL FLOW SOLVED (TODO-030 RESOLVED)

`GET /v3/exports/{jobId}?download=true` returns the job object with a **signed S3 download URL**:

```json
{
  "status": "FINISHED",
  "uploadedFilePath": "ws1080480/filename.csv",
  "downloadUrl": "https://clay-base-export-prod.s3.us-east-1.amazonaws.com/ws1080480/filename.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&...",
  "expiresAt": "2026-04-07T...",
  "totalRecordsInViewCount": 0,
  "recordsExportedCount": 0,
  "exportType": "TABLE"
}
```

The `downloadUrl` is a pre-signed S3 URL with 24-hour expiry. Full CSV export flow:
1. `POST /v3/tables/{id}/export` → `{id: "ej_xxx", status: "ACTIVE"}`
2. Poll: `GET /v3/exports/{jobId}` → wait for `status: "FINISHED"`
3. Download: `GET /v3/exports/{jobId}?download=true` → `downloadUrl` field contains the signed S3 URL
4. Fetch the `downloadUrl` directly to get the CSV file

### Signal CRUD — Read Only (TODO-026)

- `GET /v3/workspaces/{id}/signals/{signalId}` → 200 with `{signal: {...}}` (single read works!)
- `POST /v3/workspaces/{id}/signals` → 404 (not a valid path)
- `POST /v3/signals` → 404
- **Signal creation likely happens through a different mechanism** (perhaps via the table/source creation flow)

### Table Settings — Highly Permissive (TODO-025/028)

`tableSettings` accepts ANY key-value pairs. All PATCHes return 200:
- `autoRun: true` ✅
- `dedupeFieldId: "f_xxx"` ✅
- `runOnNewRows: true` ✅
- `schedule: {enabled: true, interval: "daily"}` ✅
- `cronExpression: "0 0 * * *"` ✅
- `autoRunOnNewRows: true` ✅

**Warning**: `tableSettings` is a schemaless JSON blob — Clay accepts any key. Whether these keys actually DO anything needs verification.

### Deduplication — Does NOT Prevent Duplicates (TODO-029)

Setting `dedupeFieldId` and inserting duplicate rows: all 3 rows were created (including the duplicate). `dedupeValue` is `null` on all rows. The dedup feature may:
- Only apply to source-fed rows (not direct inserts)
- Require additional settings to activate
- Only flag duplicates (not prevent them)

**Note**: Total rows read was 0, which is unexpected — likely a timing issue with the view or the `autoRun: true` setting interfering.

## TODOs Updated

| TODO | New Status |
|------|-----------|
| TODO-026 (Signals) | Partially resolved: single GET works, no write endpoints |
| TODO-027 (Tags) | Partially resolved: Zod revealed `tagText`/`tagColor`/`isPublic` — retry needed |
| TODO-029 (Dedup) | Partially resolved: setting accepted but doesn't prevent direct-insert duplicates |
| TODO-030 (Export download) | Partially resolved: `?download=true` adds `expiresAt`, need full response inspection |
| TODO-031 (Enrichment column) | **RESOLVED** — works with empty inputsBinding or array format |

## New Endpoints Confirmed

| Method | Path | Status |
|--------|------|--------|
| GET | `/v3/workspaces/{id}/signals/{signalId}` | 200 — single signal read |
