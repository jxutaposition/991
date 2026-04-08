# INV-021: CSV Upload Origin — The S3 Multipart PUT Flow

**Date**: 2026-04-07
**Investigation**: INV-021
**Credit cost**: 0

## HEADLINE

The upload origin IS in `/v3` after all. INV-020 missed it because the
path-param shape uses **`{workspaceId}`**, not `{importId}`. Two new
confirmed endpoints close the full file → S3 → import loop. Closes
GAP-027.

```
POST /v3/imports/{workspaceId}/multi-part-upload         → {uploadId, s3Key, uploadUrls[]}
PUT  <presigned S3 url>                                  → 200 + ETag header
POST /v3/imports/{workspaceId}/multi-part-upload/complete → {}
POST /v3/imports                                          (consume s3Key)
```

Verified end-to-end with a 55-byte test CSV.

## How We Found It

Phase 1 HTTP probe of ~60 non-`/v3` paths and 9 alternate hosts
(`uploads.clay.com`, `files.clay.com`, ...) → **zero hits**. Ruled out
all alternate origins conclusively.

Phase 2 was a bundle scan: fetched
`https://app.clay.com/assets/index--X05HdGb.js` (8.4 MB), grep'd for
`presign`, `signedUrl`, `uploadUrl`, etc. The de-minified `lgt`/`ugt`
axios wrappers exposed the exact routes. The axios baseURL is set via
`'https://api.clay.com/v1'.replace('/v1','/v3')` — a fun footgun.

## Endpoints Discovered

Confirmed:
1. `POST /v3/imports/{workspaceId}/multi-part-upload`
2. `POST /v3/imports/{workspaceId}/multi-part-upload/complete`

Suspected (extracted from bundle, not yet exercised — promoted later
in INV-023):
3. `POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url`
4. `POST /v3/documents/{wsId}/upload-url`

## Gotchas

- **Casing trap**: init returns `s3Key` (camelCase); `/complete`
  request body uses `s3key` (lowercase k).
- **ETag unwrapping**: S3 returns `ETag: "fcc4..."` with surrounding
  quotes. The `/complete` payload requires the etag **without** the
  quotes (`fcc4...`).
- **Two destination buckets**, same endpoint:
  `toS3CSVImportBucket: true` → `clay-base-import-prod` (consumable
  by `POST /v3/imports`); `false` → `file-drop-prod` (general file
  drop, e.g. action attachments / documents).
- Bundle constants: `mgt = 50*1024*1024` (50 MB part size),
  `axt.PromisePool.withConcurrency(5)`,
  `maxFileSizeBytes = 15 GB`.
- **S3 returns 200 on PUT** here (not 204). The POST-policy flow
  (INV-023) returns 204. Distinct mechanics.

## Cross-reference

`investigations/INV-021_csv-upload-origin.md`
