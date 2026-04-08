# INV-020: Import Job Creation (POST /v3/imports)

**Status**: completed
**Priority**: P2
**Gap**: TODO-024 — `POST /v3/imports` returned 500, needed correct payload
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

`POST /v3/imports` would accept a payload mirroring the `config` shape returned by
existing records from `GET /v3/imports`. Once the right shape was found, we expected
either (a) immediate creation of an import job that pulled from an S3-hosted CSV, or
(b) a multi-step flow that first issued a presigned upload URL.

## Method

Direct HTTP probing via the harness. Four iterative scripts:

1. `harness/scripts/investigate-import-creation.ts` — generic payload sweep + 11
   sibling/alternate paths.
2. `harness/scripts/investigate-import-creation-2.ts` — used the `config` schema
   pulled from `GET /v3/imports` records, plus presign endpoint hunt.
3. `harness/scripts/investigate-import-creation-3.ts` — enumerated valid
   `source.type` values, alternate prefixes, and reused a real S3 key.
4. `harness/scripts/investigate-import-creation-4.ts` — full end-to-end:
   create scratch table → POST /v3/imports with reused key → poll
   `GET /v3/imports/{id}` → read rows from destination → cleanup.

All write tests went against scratch tables (`spreadsheet`-type) which were deleted
at end of run.

## Findings

### POST /v3/imports — confirmed working

**Required payload**:
```json
{
  "workspaceId": 1080480,
  "config": {
    "map": {
      "<fieldId>": "{{\"CSV Header Name\"}}"
    },
    "source": {
      "key": "<s3 object key>",
      "type": "S3_CSV",
      "filename": "creators_default_vie-1775337345813.csv",
      "hasHeader": true,
      "recordKeys": ["Name", "Email"],
      "uploadMode": "import",
      "fieldDelimiter": ","
    },
    "destination": {
      "type": "TABLE",
      "tableId": "t_xxx"
    },
    "isImportWithoutRun": true
  }
}
```

**Response** (200):
```json
{
  "id": "ij_0td4wql48mnXmfbmjqQ",
  "workspaceId": 1080480,
  "createdAt": "2026-04-07T17:32:45.657Z",
  "config": { /* echoed */ },
  "state": { "status": "INITIALIZED" }
}
```

The job runs **synchronously**. By the time we polled `GET /v3/imports/{id}` 2s
later, `state.status` was `FINISHED` and `numRowsSoFar=49`. The 49 rows were
visible in the destination table via `GET /v3/tables/{id}/views/{viewId}/records`.

### Error fingerprints (these were the keys to discovery)

| Payload                                  | Status | Body                                                                |
|------------------------------------------|--------|---------------------------------------------------------------------|
| `{}`                                     | 400    | `Must specify workspaceId`                                          |
| `{workspaceId}`                          | 500    | `InternalServerError` (no validator before destructuring `config`)  |
| `{workspaceId, config:{source:{key:"<bogus>"...}, ...}}` | 400 | `Bad source config: Could not locate file with key 1080480/...`     |
| `source.type:"INLINE_CSV"` (with config) | 400    | `Could not find source with type INLINE_CSV`                        |
| `source.type:"JSON" \| "RECORDS" \| ...` | 404    | "Table does not exist" — meaning ALL these source types passed source-type validation. Only `S3_CSV` is documented in history but the validator may accept others. Not verified end-to-end. |
| `multipart/form-data`                    | 400    | `Must specify workspaceId` — multipart parser is NOT wired up; only JSON. |

### Source types observed in import history (26 records)
- `source.type` values seen: **`S3_CSV` only**
- `destination.type` values seen: **`TABLE`**, **`NOOP`**
- `uploadMode` values seen: **`import`**

### S3 upload endpoint — NOT IN v3

Probed all of: `/v3/files`, `/v3/files/presign`, `/v3/uploads`, `/v3/uploads/presign`,
`/v3/imports/upload`, `/v3/imports/presign`, `/v3/imports/file`,
`/v3/imports/{id}/upload`, `/v3/imports/{id}/presign`, `/v3/imports/{id}/file`,
`/v3/imports/{id}/start`, `/v3/imports/{id}/run`, `/v3/storage/presign`,
`/v3/csv-upload`, `/v3/csv/upload`, `/v3/csv-imports/presign`, `PUT /v3/imports/{id}`.
**All returned 404 `NoMatchingURL`**. The CSV-upload step is not exposed in the
`/v3` namespace. Likely candidates for the upload origin (still TBD):
- A non-`/v3` Express route (e.g. `/api/upload`, `/upload`, `/api/internal/...`)
- A direct browser → S3 PUT using a presigned URL minted by a non-v3 endpoint
- A separate uploader service (e.g. `uploads.clay.com`)

### Other notes
- `map` keys must be Clay field IDs (`f_xxx`). Bogus IDs are accepted at 200 — Clay
  silently writes nothing for unmapped columns. (We hit this because our field
  creation 400'd; rows were imported but only system columns populated.)
- Field creation requires `typeSettings: {dataTypeSettings: {type: "text"}}` (NOT
  `dataTypeSettings` at top level — that returns 400 `Missing data type settings`).
  Documented in `knowledge/internal-v3-api.md`.
- POST /v3/imports has no rate limiting visible (single-call test, but consistent
  with INV-008 finding of no v3 rate limits at all).

## New Endpoints Discovered

- `POST /v3/imports` — promoted from `untested` → `confirmed` with full request
  shape.
- `GET /v3/imports/{importId}` — newly added; was implied by the
  `Import Job with id X not found` error pattern from INV-006/007 but never
  formally cataloged.

## Implications

1. **Programmatic CSV import is now possible** — but only for CSVs that already
   exist in Clay's S3 bucket under `{userId}/{filename}.csv`. The proprietary API
   layer can re-import existing files (e.g. for ETL re-runs against new tables) but
   cannot upload fresh CSVs via v3 alone.
2. **Upload step is the remaining blocker for end-to-end CSV ingestion**. Until
   that's found (likely via CDP intercept of the Clay UI's import flow), the
   workaround is to use `POST /v3/tables/{id}/records` for direct row insertion
   (which we already have).
3. **`isImportWithoutRun: true` is significant** — it imports rows without
   triggering enrichments, avoiding credit burn. Combined with row-level
   `PATCH /run` from INV-009, this gives full credit-controlled import.
4. **Synchronous execution** — no need to poll for completion in normal cases;
   the response from POST already reflects FINISHED state for small files.
5. The discovered field-mapping syntax `"{{\"Header\"}}"` is a Clay templating
   convention worth noting for any layer that wires CSV columns to fields.

## Next Steps

1. **TODO-024-followup**: Find the upload origin. Best path is a CDP/Playwright
   intercept of the Clay UI's "Import CSV" button. Alternatively, probe non-`/v3`
   prefixes: `/api/uploads`, `/api/files`, `/upload`, `https://uploads.clay.com`,
   and inspect the v1 deprecated namespace one more time.
2. Test whether `source.type` accepts values other than `S3_CSV` end-to-end (the
   404s for "Table not found" suggested several types passed the type validator).
3. Try `destination.type: "NOOP"` to understand what a NOOP destination does
   (possibly a dry-run mode for column-mapping preview).
4. Investigate import deletion — the existing records have a `deletedAt` field, so
   `DELETE /v3/imports/{id}` likely works.
