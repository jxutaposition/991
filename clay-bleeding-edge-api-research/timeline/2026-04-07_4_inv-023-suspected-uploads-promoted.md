# INV-023: Suspected Upload-URL Endpoints PROMOTED

**Date**: 2026-04-07
**Investigation**: INV-023
**Credit cost**: 0

## HEADLINE

The two `suspected` endpoints from INV-021's bundle scan are real.
Both return an **S3 POST policy** (not a presigned PUT), so the client
does a single `multipart/form-data POST` directly to S3 with form
fields first and `file` last. Closes GAP-029.

## Endpoints Promoted suspected → confirmed

1. `POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url`
   → `{uploadUrl, fields, uploadToken}`
2. `POST /v3/documents/{wsId}/upload-url`
   → `{documentId, uploadUrl, fields}`

## Newly Confirmed (free side-effects of the verification script)

3. `POST /v3/documents/{wsId}/{documentId}/confirm-upload` (empty body)
   → returns the full document record with `mimeType`, `size`, `context`.
4. `GET /v3/workspaces/{wsId}/tc-workflows`
5. `POST /v3/workspaces/{wsId}/tc-workflows` body `{name, defaultModelId?}`
6. `DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}` (body `{}` required)
7. `DELETE /v3/documents/{wsId}/{documentId}?hard=true`

## Mechanics

- POST policy `fields` is an **object**, not an array. INV-021's
  registry entries had `fields: Array<string>` — wrong, corrected
  during promotion.
- `Content-Type` on the POST is `multipart/form-data; boundary=...`
  (set by `FormData`). Do NOT override.
- Form-field order matters: all fields first, `file` LAST.
- S3 returns **204 No Content** on success (POST policy flow), unlike
  the 200 returned by the multipart PUT flow in INV-021.
- No `etag` collection, no `/complete` step on the Clay side — single
  shot.
- Documents has a `confirm-upload` step before the document is
  visible.

## Bucket Routing (Two Mechanisms, Same Buckets)

- tc-workflows CSV → `clay-base-import-prod` (same as
  `multi-part-upload` with `toS3CSVImportBucket: true`).
- documents → `file-drop-prod` (same as `multi-part-upload` with
  `toS3CSVImportBucket: false`).

So Clay has TWO ingress mechanisms fronting the SAME pair of S3
buckets: presigned PUT multipart (15 GB cap) and POST policy
(5 GB single-shot cap).

## Gotchas

- The `uploadToken` UUID returned by `csv-upload-url` is consumed by a
  sibling endpoint that wasn't yet exercised at INV-023 time —
  followed up in INV-024.
- BadRequest error shape is structured everywhere on the
  tc-workflows/documents routers:
  `{type:"BadRequest", message, details:{pathParameterErrors,
  headerErrors, queryParameterErrors, bodyErrors}}`. Useful: lets you
  unambiguously distinguish "route exists, body wrong" (400 with this
  schema) from "route doesn't exist" (404 plain HTML).
- One scratch document leaked (`doc_0td531mAWhrhgzXcufb`) — only the
  primary `documentId` was tracked in the cleanup logic.

## Cross-reference

`investigations/INV-023_suspected-upload-endpoints.md`
