# INV-024: tc-workflows Ingestion Loop CLOSED

**Date**: 2026-04-07
**Investigation**: INV-024
**Credit cost**: 0 (empty workflows fail in <500ms with `totalRuns=0`)

## HEADLINE

The full programmatic CSV → workflow batch flow now works end-to-end:
`csv-upload-url → S3 POST → createWorkflowRunBatch → poll → cleanup`.
Closes GAP-030.

```jsonc
// POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches
{
  "workflowSnapshotId": "latest",
  "type": "csv_import",
  "csvUploadToken": "<uuid from csv-upload-url>",
  "config": { "standaloneActions": [] }
}
// → { batch: {id (wfrb_...), workflowSnapshotId (wfs_...), workflowId,
//             status:'pending', config:{csvFile, parameterNames}, ...} }
```

## Endpoints Discovered

Confirmed (5):
1. `POST   .../tc-workflows/{wfId}/batches` (`createWorkflowRunBatch`)
2. `GET    .../tc-workflows/{wfId}/batches` (`getWorkflowRunBatches`)
3. `GET    .../tc-workflows/{wfId}/batches/{batchId}`
4. `DELETE .../tc-workflows/{wfId}/batches/{batchId}` (body `{}`)
5. `GET    .../tc-workflows/{wfId}/batches/{batchId}/runs`

Suspected (1, promoted later in INV-025):
6. `PATCH  .../tc-workflows/{wfId}/batches/{batchId}` body
   `{status?, config?, state?}` — body shape from bundle, hard to
   exercise because empty-step batches fail in <500ms.

## Mechanics

- `workflowSnapshotId: 'latest'` is a **client convention**. The
  server resolves it to a real `wfs_...` snapshot id and returns the
  resolved value on the batch object.
- The server **parses the CSV first row** and stores it as
  `config.parameterNames: string[]`.
- `state.lastOffsetProcessed: 0` is initialized — likely a cursor for
  the row processor.
- `BatchStatus`: `pending | running | completed | failed | cancelled`.
- `BatchType`: `csv_import | cpj_search` (cpj branch untested here;
  resolved-NYI in INV-025).
- **Empty workflows are credit-safe scratch resources**: zero defined
  steps → no work units → `totalRuns=0` → 0 credits. Useful pattern
  for all subsequent tc-workflows investigations.

## Gotchas

- Batches transitioned `pending → failed` in ~430ms on empty
  workflows. Polling loops should expect terminal status almost
  immediately.
- Empty body POST returns
  `BadRequest "Invalid discriminator value. Expected 'csv_import' |
  'cpj_search'"` — confirms the route exists.

## Bundle-Indexing Tip

For 8.4 MB minified single-line bundles, `grep -ob` (byte offset
mode) is the right tool. The ts-rest router schemas appear in
contiguous byte regions and are canonical: each sub-router's full
route set lives within a few KB of itself.

## Cross-reference

`investigations/INV-024_workflow-batch-run.md`
