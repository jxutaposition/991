# INV-023: Verify suspected upload-URL endpoints (tc-workflows + documents)

**Status**: completed
**Priority**: P2
**Gap**: INV-021 next-step #1 — promote the two `suspected` upload-URL endpoints extracted from the bundle.
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

Two endpoints surfaced by the INV-021 bundle scan but never exercised:

1. `POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url`
2. `POST /v3/documents/{wsId}/upload-url`

Expected: both return an S3 POST policy (`{uploadUrl, fields, ...}`) rather
than the presigned PUT URLs used by `/v3/imports/{ws}/multi-part-upload`, so
the client-side flow is `multipart/form-data POST directly to S3` with fields
first and `file` last.

## Method

1. Re-downloaded `https://app.clay.com/assets/index--X05HdGb.js` (still the
   current bundle) and grep'd for the two endpoints to extract exact request
   schemas. Both are declared in ts-rest router objects — the zod bodies gave
   us authoritative request shapes:
   - tcw: `body: P({filename: L(), fileSize: F()})`
   - docs: `body: P({name: L().min(1).max(500), folderId: L().nullable().optional(), context: L().optional().default('agent_playground')})`
   The bundle also revealed a `confirmUpload` step for documents
   (`POST /v3/documents/{ws}/{documentId}/confirm-upload`), which the UI calls
   after the S3 POST succeeds.

2. Wrote `harness/scripts/verify-suspected-upload-endpoints.ts`:
   - `GET /v3/me` auth precheck (stop on 401).
   - Part 1: `GET /v3/workspaces/{ws}/tc-workflows` (empty array returned), then
     created a scratch workflow via `POST /v3/workspaces/{ws}/tc-workflows`
     with body `{name}`, exercised `csv-upload-url` with empty body (expect
     400) then correct `{filename, fileSize}`, did the S3 `multipart/form-data`
     POST with fields first and `file` last, deleted the scratch workflow.
   - Part 2: `POST /v3/documents/{ws}/upload-url` with empty body (expect 400),
     then correct `{name}`, S3 POST, `confirm-upload`, then an alt-shape probe
     with `{name, folderId: null, context: "agent_playground"}`, then
     `DELETE /v3/documents/{ws}/{documentId}?hard=true`.

3. Ran `npx tsx harness/scripts/verify-suspected-upload-endpoints.ts`. Saved
   `harness/results/inv-023-suspected-uploads-1775591339053.json`.

## Findings

### Both endpoints confirmed end-to-end

| Step | Status | Notes |
|------|--------|-------|
| `GET /v3/me` | 200 | session valid |
| `GET /v3/workspaces/1080480/tc-workflows` | 200 | `{workflows: []}` |
| `POST /v3/workspaces/1080480/tc-workflows` | 200 | `{workflow: {id: "wf_0td5...", ...}}` |
| `POST .../batches/csv-upload-url` (empty) | 400 | `BadRequest` with structured `details.bodyErrors` |
| `POST .../batches/csv-upload-url` `{filename, fileSize}` | 200 | `{uploadUrl, fields, uploadToken}` |
| S3 POST `clay-base-import-prod` | 204 | success |
| `DELETE .../tc-workflows/{wfId}` | 200 | `{success: true}` |
| `POST /v3/documents/{ws}/upload-url` (empty) | 400 | `BadRequest`, missing `name` |
| `POST /v3/documents/{ws}/upload-url` `{name}` | 200 | `{documentId, uploadUrl, fields}` |
| S3 POST `file-drop-prod` | 204 | success |
| `POST /v3/documents/{ws}/{docId}/confirm-upload` | 200 | returns full document record |
| `POST /v3/documents/{ws}/upload-url` (alt shape: `{name, folderId:null, context:"agent_playground"}`) | 200 | same response shape |
| `DELETE /v3/documents/{ws}/{docId}?hard=true` | 200 | `{success: true}` |

### Confirmed request/response shapes

**tc-workflows csv-upload-url**
```jsonc
// POST /v3/workspaces/{wsId}/tc-workflows/{workflowId}/batches/csv-upload-url
// request
{ "filename": "inv023-test.csv", "fileSize": 36 }
// response 200
{
  "uploadUrl": "https://clay-base-import-prod.s3.us-east-1.amazonaws.com/",
  "fields": {
    "bucket": "clay-base-import-prod",
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "...",
    "X-Amz-Date": "...",
    "X-Amz-Security-Token": "...",
    "key": "<s3-object-key>",
    "Policy": "<base64 policy>",
    "X-Amz-Signature": "..."
  },
  "uploadToken": "80e617ba-c57a-47ac-b19f-0523fa9a63ee"
}
```
The `uploadToken` is a server-generated UUID that's later passed to the
workflow-run-batch create endpoint to associate the uploaded CSV with a batch
run. (That create endpoint is still untested — next step.)

**documents upload-url**
```jsonc
// POST /v3/documents/{wsId}/upload-url
// request
{ "name": "inv023-test-1775591338165.txt" }
// response 200
{
  "documentId": "doc_0td531m9Z7tsq3a734n",
  "uploadUrl": "https://file-drop-prod.s3.us-east-1.amazonaws.com/",
  "fields": { "bucket": "file-drop-prod", "key": "...", "Policy": "...", "X-Amz-*": "..." }
}
```

**documents confirm-upload**
```jsonc
// POST /v3/documents/{wsId}/{documentId}/confirm-upload
// request: {} (empty, optional)
// response 200
{
  "id": "doc_0td531m9Z7tsq3a734n",
  "name": "inv023-test-1775591338165.txt",
  "folderId": null,
  "mimeType": "binary/octet-stream",
  "size": 42,
  "context": "agent_playground",
  "createdAt": "2026-04-07T19:48:58.224Z",
  "updatedAt": "2026-04-07T19:48:58.409Z"
}
```

### S3 POST policy upload mechanics (applies to both)

- `Content-Type` on the POST itself is set by `FormData`
  (`multipart/form-data; boundary=...`) — do NOT override.
- Order of fields matters for S3 POST policies: all form fields first, the
  actual `file` field LAST. The verification script uses `FormData.append` in
  that order.
- S3 returns `204 No Content` on success (not 200, unlike the PUT flow used by
  `/v3/imports/{ws}/multi-part-upload`).
- No `etag` collection is required — the POST policy upload is single-shot,
  so there's no `/complete` step on the Clay side for either endpoint.

### Bucket routing

- **tc-workflows CSV** → `clay-base-import-prod` bucket (SAME bucket the
  `toS3CSVImportBucket: true` flag of `/v3/imports/{ws}/multi-part-upload`
  uses). The two endpoints are alternate ingress paths into the same bucket.
- **documents** → `file-drop-prod` bucket (SAME bucket the
  `toS3CSVImportBucket: false` flag of `multi-part-upload` uses).

So Clay has TWO distinct upload mechanisms fronting the SAME pair of S3
buckets:
- presigned multipart PUT (`/v3/imports/{ws}/multi-part-upload[/complete]`)
- presigned POST policy (`.../csv-upload-url`, `/v3/documents/{ws}/upload-url`)

The POST policy flow is simpler (no multipart, no complete step) but caps at
S3's single-POST size limit (5 GB). The multipart PUT flow supports up to
Clay's advertised 15 GB max file size.

### Related endpoints confirmed in passing

While exercising the scratch workflow, three tc-workflows CRUD endpoints and
one documents delete endpoint were also verified:

- `GET /v3/workspaces/{ws}/tc-workflows` → `{workflows: []}`
- `POST /v3/workspaces/{ws}/tc-workflows` `{name, defaultModelId?}` → `{workflow}`
- `DELETE /v3/workspaces/{ws}/tc-workflows/{wfId}` (body `{}` required) → `{success}`
- `DELETE /v3/documents/{ws}/{docId}?hard=true` → `{success}`

Added to `endpoints.jsonl` with status `confirmed`.

## New Endpoints Discovered

Promoted from `suspected` → `confirmed`:
1. `POST /v3/workspaces/{wsId}/tc-workflows/{workflowId}/batches/csv-upload-url`
2. `POST /v3/documents/{workspaceId}/upload-url`

Newly added as `confirmed`:
3. `POST /v3/documents/{wsId}/{documentId}/confirm-upload`
4. `GET /v3/workspaces/{wsId}/tc-workflows`
5. `POST /v3/workspaces/{wsId}/tc-workflows`
6. `DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}`
7. `DELETE /v3/documents/{wsId}/{documentId}`

## Implications

1. **Programmatic document ingestion is now possible.** Clay's Documents
   feature (used by agent playground / RAG) can be fed files from the
   proprietary API layer end-to-end using three calls: `upload-url` → S3
   POST → `confirm-upload`.
2. **Programmatic workflow CSV-batch runs are one step closer.** We can now
   land a CSV into the workflow-batch staging area and obtain an
   `uploadToken`. The final `createWorkflowRunBatch` endpoint (which consumes
   this token to kick off a batch run) is still untested — that's the natural
   follow-up.
3. **Two upload mechanisms, same buckets.** For the proprietary layer we can
   pick whichever is ergonomic per use case: POST policy for single-shot
   small-to-medium files (<5 GB), multipart PUT for large files (>5 GB).
4. **POST policy `fields` is an object, not an array.** The earlier
   `suspected` registry entries documented `fields` as `Array<string>` —
   incorrect, corrected during promotion.
5. **BadRequest error shape is structured** —
   `{type: "BadRequest", message, details: {pathParameterErrors, headerErrors,
   queryParameterErrors, bodyErrors}}`. Useful for all future verification
   scripts: hitting a valid route with a wrong body consistently returns this
   shape, which unambiguously distinguishes "route exists, body wrong" (400
   with this schema) from "route doesn't exist" (404 HTML or empty).

## Cleanup status

- Scratch workflow `wf_0td531lYWUJRHhv4GZz` — deleted (success).
- Document `doc_0td531m9Z7tsq3a734n` — hard-deleted (success).
- Document `doc_0td531mAWhrhgzXcufb` (created by the alt-shape probe) —
  NOT cleaned up automatically (script only tracked one documentId).
  **RESOLVED 2026-04-07**: cleaned up via one-shot
  `harness/scripts/cleanup-leaked-doc-inv023.ts` (one-row `DELETE
  /v3/documents/1080480/doc_0td531mAWhrhgzXcufb?hard=true`). Server returned
  `404 NotFound` — the doc had already aged out of retention before the
  cleanup ran, so the leak is confirmed gone either way.

## Files Updated

- `investigations/INV-023_suspected-upload-endpoints.md` (this file)
- `investigations/_index.md`
- `registry/endpoints.jsonl` (promoted 2 suspected → confirmed, added 5 new confirmed)
- `registry/capabilities.md` (Documents upload, tc-workflows CRUD)
- `registry/gaps.md` (closed follow-up from INV-021 next-steps)
- `registry/changelog.md` (2026-04-07 entry)
- `knowledge/internal-v3-api.md` (POST policy upload pattern section)
- `harness/scripts/verify-suspected-upload-endpoints.ts` (new)
- `harness/results/inv-023-suspected-uploads-1775591339053.json` (raw results)

## Next Steps

1. **Exercise `createWorkflowRunBatch`** — consume the `uploadToken` returned
   by `csv-upload-url` to actually kick off a workflow run batch. This is the
   natural closing of the loop. Likely free (depends on how workflow step
   execution is priced — probably free for empty scripts).
2. **Confirm the documents `context` enum** — the bundle defaults to
   `"agent_playground"` but might accept other values (e.g. for
   production/agent/ingest contexts). Probe a few likely values and observe
   which the server accepts.
3. **Test the `replace-upload-url` sibling** — the bundle also exposes
   `POST /v3/documents/{ws}/replace-upload-url` with the same body shape.
   Exercise it against the scratch document we left behind.
4. **Clean up doc_0td531mAWhrhgzXcufb** once the next documents investigation
   runs (or add it to a routine cleanup script).
