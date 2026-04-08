# INV-020: POST /v3/imports Unlocked

**Date**: 2026-04-07
**Investigation**: INV-020
**Credit cost**: 0 (`isImportWithoutRun: true` plus scratch tables)

## HEADLINE

`POST /v3/imports` is now confirmed working end-to-end. Synchronous —
small CSVs (49 rows) transition `INITIALIZED → FINISHED` before the
first poll. Closes TODO-024.

## Required Payload

```json
{
  "workspaceId": 1080480,
  "config": {
    "map": { "<f_xxx>": "{{\"CSV Header Name\"}}" },
    "source": {
      "key": "<existing s3 object key>",
      "type": "S3_CSV",
      "filename": "...csv",
      "hasHeader": true,
      "recordKeys": ["Name", "Email"],
      "uploadMode": "import",
      "fieldDelimiter": ","
    },
    "destination": { "type": "TABLE", "tableId": "t_..." },
    "isImportWithoutRun": true
  }
}
```

The error fingerprints were the keys to discovery: `{}` → 400 "Must
specify workspaceId"; `{workspaceId}` alone → 500 (no validator before
destructuring `config`); bogus key → 400 "Could not locate file with
key ...". `multipart/form-data` body returns 400 "Must specify
workspaceId" — the multipart parser is NOT wired up; only JSON works.

## Endpoints Promoted / Added

- `POST /v3/imports` — promoted **untested → confirmed**, full request
  shape documented.
- `GET /v3/imports/{importId}` — newly cataloged.

## Gotchas

- `map` keys must be real field IDs. Bogus IDs accepted at 200 — Clay
  silently writes nothing for unmapped columns.
- `map` value templating uses Clay's `{{"Header"}}` literal-string
  syntax — not a JS template.
- `isImportWithoutRun: true` lands rows without firing enrichments,
  pairing nicely with INV-009's per-row `PATCH /run` for
  credit-controlled import.
- Source-type validator accepts strings beyond `S3_CSV` (`JSON`,
  `RECORDS`, `INLINE_CSV`) — they progress past type validation but
  fail later. Only `S3_CSV` was verified end-to-end.

## What's Still Missing

The CSV upload step. Probed 17 candidate `/v3/*` upload paths — all
404. Sub-gap opened: GAP-027 (later resolved by INV-021).

## Cross-reference

`investigations/INV-020_import-job-creation.md`
