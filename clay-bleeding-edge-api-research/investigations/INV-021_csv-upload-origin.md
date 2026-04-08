# INV-021: CSV Upload Origin (file → S3 presign flow)

**Status**: completed
**Priority**: P1
**Gap**: GAP-027 — find where Clay's UI uploads CSV files (origin of the S3 key consumed by `POST /v3/imports`)
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

INV-020 confirmed `POST /v3/imports` works but only accepts an S3 key for a CSV
already in Clay's S3 bucket. 17 candidate `/v3/*` upload paths returned 404, so
we expected the upload origin to live outside `/v3` (a non-`/v3` Express route,
a separate uploader host like `uploads.clay.com`, or a v3 path we hadn't tried).

## Method

**Phase 1 — HTTP probe** (`harness/scripts/investigate-csv-upload-origin.ts`):
- Probed ~30 non-`/v3` paths on `api.clay.com` (POST + GET): `/api/uploads`,
  `/api/files`, `/api/presign`, `/uploads`, `/files`, `/presign`,
  `/storage/presign`, `/v2/uploads`, `/upload-url`, `/api/v1/uploads`, etc.
  Distinguished 404 (no route) from 401/403/405 (route exists).
- Probed alternate hosts: `uploads.clay.com`, `files.clay.com`, `cdn.clay.com`,
  `storage.clay.com`, `s3.clay.com`, `static.clay.com`, `upload.clay.com`,
  `media.clay.com`, `assets.clay.com` (5 paths each, GET + POST).
- Fetched `https://app.clay.com/`, extracted `<script src=>` URLs (1 bundle:
  `/assets/index--X05HdGb.js`, ~8.4 MB), and grepped for: `presign`,
  `signedUrl`, `uploadUrl`, `getUploadUrl`, `createUpload`, `putObject`,
  `s3.amazonaws`, `x-amz-`, `S3_CSV`, `multipart/form-data`, `uploads.clay`,
  `csvUpload`, `importUpload`, `/api/upload`, `/api/files`, `/api/presign`.
- Saved raw results: `harness/results/inv-021-csv-upload-1775589924263.json`.

**Phase 2 — verify** (`harness/scripts/verify-multipart-upload.ts`): exercised
the discovered endpoint end-to-end with a 55-byte test CSV through to
`POST /v3/imports`, then deleted the scratch table.
Saved: `harness/results/inv-021-verify-multipart-1775590055913.json`.

Phase 2 (Playwright UI intercept) was not needed — the bundle scan resolved
the question conclusively.

## Findings

### Result of HTTP path probing
**Zero hits** on the 60+ non-`/v3` `api.clay.com` paths and the 9 alternate
hosts. Every alternate host failed DNS or returned 404. The CSV upload origin
is **not** on a separate host or a non-`/v3` prefix.

### Result of bundle scan
The Clay frontend bundle contains the exact upload code path. Key snippet
(de-minified):

```js
lgt = async (filename, workspaceId, fileSize, toS3CSVImportBucket = false) =>
  (await ch.post(`/imports/${workspaceId}/multi-part-upload`, {
    filename, fileSize, toS3CSVImportBucket
  })).data;

ugt = async (s3Key, uploadId, workspaceId, etags, toS3CSVImportBucket = false) =>
  ch.post(`/imports/${workspaceId}/multi-part-upload/complete`, {
    s3key: s3Key, uploadId, etags, toS3CSVImportBucket
  });
```

`ch` is an axios client with `baseURL: https://api.clay.com/v3` (set via
`'https://api.clay.com/v1'.replace('/v1','/v3')` — see byte 282493 of the
bundle). So the actual full endpoints are:

- `POST https://api.clay.com/v3/imports/{workspaceId}/multi-part-upload`
- `POST https://api.clay.com/v3/imports/{workspaceId}/multi-part-upload/complete`

**These ARE in the `/v3` namespace.** INV-020 missed them because it probed
`/v3/imports/{importId}/upload` (importId path param) but the real route uses
`{workspaceId}` as the path param — a different shape entirely.

The single-PUT-per-part S3 upload is performed by `fgt`:
```js
fgt = ({url, fileChunk, ...}) => {
  o.open('PUT', url);
  o.setRequestHeader('Content-Type', 'application/octet-stream');
  o.send(fileChunk);
}
```
S3 returns the part `Etag` header which is bubbled back to `multi-part-upload/complete`.

### Verified end-to-end (real responses)

**1) Initiate** — `POST /v3/imports/1080480/multi-part-upload`
```json
// request
{ "filename": "inv021-test.csv", "fileSize": 64, "toS3CSVImportBucket": true }
// response (200)
{
  "uploadId": "WJjMz_Cr43NFUDc7TjOPvN5yMAIBdUiM9z6T0rNELa...",
  "s3Key": "1080480/1282581/inv021_test-1775590033057.csv",
  "uploadUrls": [
    {
      "url": "https://clay-base-import-prod.s3.us-east-1.amazonaws.com/1080480/1282581/inv021_test-1775590033057.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&...",
      "partNumber": 1
    }
  ]
}
```

Notes:
- S3 key format: `{workspaceId}/{userId}/{normalized_filename}-{epoch_ms}.{ext}`
- The server normalizes the filename (drops `-`, replaces with `_`).
- For tiny files, `uploadUrls` is a 1-element array. For large files Clay
  splits into multiple parts (uploaded in parallel with concurrency=5 per the
  bundle's `axt.PromisePool.withConcurrency(5)`).
- Bundle constant `mgt = 50*1024*1024` (50 MB) is the apparent part size.
- Bundle JS destructures `{uploadId, s3Key, uploadUrls}` — note **`uploadUrls`**, not
  `uploadParts`. The bundle aliases it to `uploadParts` locally.

**2) S3 PUT** — `PUT https://clay-base-import-prod.s3.us-east-1.amazonaws.com/...`
- `Content-Type: application/octet-stream`
- Body: raw file chunk (no auth header — presigned URL contains everything)
- Response: 200, `ETag: "fcc4537294f55876b43523cf6c536c8e"`

**3) Complete** — `POST /v3/imports/1080480/multi-part-upload/complete`
```json
// request
{
  "s3key": "1080480/1282581/inv021_test-1775590033057.csv",
  "uploadId": "WJjMz_Cr43...",
  "etags": [{ "partNumber": 1, "etag": "fcc4537294f55876b43523cf6c536c8e" }],
  "toS3CSVImportBucket": true
}
// response (200): {} (empty object)
```
Note: request key is `s3key` (lowercase k), not `s3Key`. Etags must be passed
**without** the surrounding double-quotes that S3 returns in the header
(`fcc4...`, not `"fcc4..."`).

**4) Create import** — `POST /v3/imports` with `source.key = s3Key`
Returns 200 with `{id: "ij_...", state: {totalSizeBytes: 55, status: "INITIALIZED"}}`,
matching the 55-byte test CSV. Confirms the freshly uploaded key is consumable
by `POST /v3/imports`.

### Two destination buckets
The `toS3CSVImportBucket` flag selects the S3 bucket:
- `true` → `clay-base-import-prod.s3.us-east-1.amazonaws.com` (CSV imports)
- `false` → `file-drop-prod.s3.us-east-1.amazonaws.com` (general file drop, e.g.
  PDFs/images for actions/documents)

Both go through the **same** `/v3/imports/{workspaceId}/multi-part-upload` route.
Only `toS3CSVImportBucket: true` is consumable by `POST /v3/imports` (S3_CSV
source); the other bucket is for action/document uploads.

### Other interesting findings from the bundle

The bundle also contains two unrelated upload-URL endpoints used elsewhere in
the app (NOT for table CSV import, but documented for completeness):

- `POST /v3/workspaces/:workspaceId/tc-workflows/:workflowId/batches/csv-upload-url`
  → `{uploadUrl, fields, uploadToken}`. This is a Workflows-team endpoint that
  returns an **S3 POST policy** (presigned POST + form fields), not multipart
  PUT URLs. Used for "create workflow run batch" CSV uploads, not table imports.
- `POST /v3/documents/:workspaceId/upload-url` → `{uploadUrl, fields, documentId}`.
  Similar S3 POST policy shape, used by the Documents feature.

These are different upload patterns (single POST with form fields vs. multipart
PUT) and are NOT the table CSV import path. Listed in `endpoints.jsonl` as
`suspected` since we did not exercise them end-to-end.

## New Endpoints Discovered

1. `POST /v3/imports/{workspaceId}/multi-part-upload` — **confirmed**
2. `POST /v3/imports/{workspaceId}/multi-part-upload/complete` — **confirmed**
3. `POST /v3/workspaces/{workspaceId}/tc-workflows/{workflowId}/batches/csv-upload-url`
   — **suspected** (extracted from bundle, not exercised)
4. `POST /v3/documents/{workspaceId}/upload-url` — **suspected** (extracted from
   bundle, not exercised)

Plus the implicit S3 PUT step (presigned URL on `clay-base-import-prod` /
`file-drop-prod`) — not a Clay endpoint per se, but part of the documented flow.

## Implications

1. **Full programmatic CSV ingestion is now possible** — no more S3-key-reuse
   workaround. The proprietary API layer can take a raw CSV file from a user,
   execute the 4-step flow (init → S3 PUT → complete → create import), and
   land rows in any Clay table without touching the UI or `/v3/tables/{id}/records`.
2. **The `/v3` namespace IS the upload origin.** The reason INV-020 missed it
   is the path-param shape: we probed `/v3/imports/{importId}/...` (importId
   first) but the route is `/v3/imports/{workspaceId}/multi-part-upload`
   (workspaceId first, no import ID involved). This is a useful pattern for
   future endpoint discovery: try multiple ID positions.
3. **No new auth surface** — same session cookie. No new hosts. No new SDK.
4. **Multipart strategy** — Clay splits files into 50 MB parts and uploads
   with concurrency 5. For files <50 MB the response contains a single
   `uploadUrls[0]`. The proprietary layer should mirror this for files >50 MB
   (Clay's max is 15 GB per the `maxFileSizeBytes: 1024*1024*1024*15` constant
   in the bundle).
5. **`s3key` casing trap** — the `complete` endpoint uses `s3key` (all lowercase)
   in the request body, while the init response returns `s3Key` (camelCase).
   Easy footgun. ETags must also be unwrapped from S3's surrounding quotes.

## Files Updated

- `investigations/INV-021_csv-upload-origin.md` (this file)
- `investigations/_index.md`
- `registry/endpoints.jsonl` (added 4 endpoints)
- `registry/capabilities.md` (CSV upload now confirmed)
- `registry/gaps.md` (GAP-027 closed)
- `registry/changelog.md` (2026-04-07 entry)
- `knowledge/internal-v3-api.md` (multipart upload section added)
- `harness/scripts/investigate-csv-upload-origin.ts` (Phase 1 probe)
- `harness/scripts/verify-multipart-upload.ts` (Phase 2 E2E verify)
- `harness/results/inv-021-csv-upload-1775589924263.json`
- `harness/results/inv-021-verify-multipart-1775590055913.json`

## Next Steps

1. Verify the Workflows + Documents upload-URL endpoints end-to-end (they're
   `suspected` in the registry; exercise them and promote to `confirmed`).
2. Test multi-part behavior with a >50 MB file to confirm the part-split logic
   and the concurrency model. The `complete` endpoint accepts an `etags` array,
   so all parts should be uploaded before completion.
3. Document the field-creation 400 we hit during E2E — the test script used
   `typeSettings.dataTypeSettings.type: "text"` but the field create returned
   400 anyway. INV-020 had the same issue documented; worth a 5-minute confirm
   that the field-create payload is now `{name, type: "text"}` (or whatever
   the current shape is). Not a blocker for INV-021.
