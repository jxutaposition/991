# INV-024: Close the tc-workflows ingestion loop — createWorkflowRunBatch

**Status**: completed
**Priority**: P2
**Gap**: GAP-030 — How does `csv-upload-url`'s `uploadToken` flow into an actual workflow batch run?
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

INV-023 confirmed `POST /v3/workspaces/{ws}/tc-workflows/{wf}/batches/csv-upload-url`
returns an `uploadToken` (UUID) that a sibling endpoint must consume. The
Clay JS bundle should expose a `createWorkflowRunBatch`-style mutation under
`/v3/workspaces/{ws}/tc-workflows/{wf}/batches` (POST).

## Method

### 1. Bundle scan

Re-downloaded `https://app.clay.com/assets/index--X05HdGb.js` (still the
current bundle, 8.4 MB). Grep'd for `csvUploadToken` — exactly two regions:
the `useCallback` site that calls the mutation (~offset 4.33 MB), and the
ts-rest router declaration `xwe` (~offset 388 KB).

The router gave authoritative shapes for the entire `batches` sub-router:

```js
var X_ = P({
  id: L(), workflowSnapshotId: L(), workflowId: L(), workflowName: L().nullable(),
  status: oa(['pending','running','completed','failed','cancelled']),
  type: oa(['csv_import','cpj_search']),
  createdBy: F(), config: wr().nullable(), state: wr().nullable(),
  createdAt: L().datetime(), updatedAt: L().datetime(),
  totalRuns: F(), completedRuns: F(), failedRuns: F(),
  pendingRuns: F(), runningRuns: F(),
});
var vwe = P({ workflowSnapshotId: L(), config: wr().optional() });
var ywe = lo('type', [
  vwe.extend({ type: I('csv_import'), csvUploadToken: L() }),
  vwe.extend({ type: I('cpj_search') }),
]);
var bwe = P({ status: gwe.optional(), config: wr().optional(), state: wr().optional() });
var xwe = {
  createWorkflowRunBatch:  POST   /workspaces/:workspaceId/tc-workflows/:workflowId/batches            body=ywe → {batch:X_}
  getWorkflowRunBatches:   GET    /workspaces/:workspaceId/tc-workflows/:workflowId/batches            query={limit,offset,status} → {batches:[X_], total}
  getWorkflowRunBatch:     GET    /workspaces/:workspaceId/tc-workflows/:workflowId/batches/:batchId   → {batch:X_}
  updateWorkflowRunBatch:  PATCH  /workspaces/:workspaceId/tc-workflows/:workflowId/batches/:batchId   body=bwe → {batch:X_}
  deleteWorkflowRunBatch:  DELETE /workspaces/:workspaceId/tc-workflows/:workflowId/batches/:batchId   body={} → {success}
  getWorkflowRunsForBatch: GET    /workspaces/:workspaceId/tc-workflows/:workflowId/batches/:batchId/runs query={limit,offset} → {runs:[Y_], total}
  getCsvUploadUrl:         POST   /workspaces/:workspaceId/tc-workflows/:workflowId/batches/csv-upload-url body={filename,fileSize} → {uploadUrl,fields,uploadToken}
};
```

The UI call site (CreateBatchModal.tsx) showed the body the React app sends:
```js
{ workflowSnapshotId: 'latest', type: e.type, csvUploadToken: n.uploadToken,
  config: { standaloneActions: e.standaloneActions } }
```

`workflowSnapshotId: 'latest'` is the convention to snapshot the workflow's
current definition at batch creation time (the server returns the resolved
snapshot id e.g. `wfs_0td53tdasiaXkDuHAMS`).

### 2. Verification script

`harness/scripts/verify-workflow-batch-run.ts`:

1. `GET /v3/me` auth precheck (stop on 401).
2. `GET /v3/workspaces/{ws}/tc-workflows`. Reuse any pre-existing
   `INV-*`-prefixed scratch workflow; otherwise create a fresh one via
   `POST /v3/workspaces/{ws}/tc-workflows {name}`. The created scratch
   workflow has **zero defined steps** — no enrichment configured.
3. `POST /v3/workspaces/{ws}/tc-workflows/{wf}/batches/csv-upload-url`
   with `{filename, fileSize}`.
4. S3 `multipart/form-data POST` of a 35-byte CSV (1 row) with fields first,
   `file` last.
5. **Empty-body probe** of the create endpoint (expect 400 BadRequest with
   discriminator error → confirms route exists).
6. **Full body** create with `{workflowSnapshotId: 'latest', type: 'csv_import',
   csvUploadToken, config: {standaloneActions: []}}`.
7. List batches, poll the created batch's status, list runs.
8. Cleanup: DELETE the batch, then DELETE the scratch workflow.

Result file: `harness/results/inv-024-workflow-batch-1775592335777.json`.

## Findings

### End-to-end success

| Step | Status | Notes |
|------|--------|-------|
| `GET /v3/me` | 200 | session valid |
| `GET .../tc-workflows` | 200 | empty array |
| `POST .../tc-workflows` `{name}` | 200 | scratch workflow `wf_0td53tcB7umSGm777g5` created |
| `POST .../batches/csv-upload-url` `{filename,fileSize}` | 200 | `uploadToken=30223f0c-...` |
| S3 POST `clay-base-import-prod` | 204 | 35-byte CSV uploaded |
| `POST .../batches` (empty body) | 400 | `BadRequest` `Invalid discriminator value. Expected 'csv_import' \| 'cpj_search'` — route exists |
| `POST .../batches` (full body) | 200 | `batch.id=wfrb_0td53tdpsJJPJvU4JVQ`, `status='pending'`, `workflowSnapshotId=wfs_0td53tdasiaXkDuHAMS` |
| `GET .../batches` | 200 | returns the batch we just created, `status` already `failed`, `total=1` |
| `GET .../batches/{batchId}` | 200 | `status='failed'`, transitioned within ~430ms |
| `GET .../batches/{batchId}/runs` | 200 | `{runs: [], total: 0}` |
| `DELETE .../batches/{batchId}` (body `{}`) | 200 | `{success:true}` |
| `DELETE .../tc-workflows/{wfId}` (body `{}`) | 200 | `{success:true}` |

### Confirmed request/response shapes

**createWorkflowRunBatch**
```jsonc
// POST /v3/workspaces/{wsId}/tc-workflows/{workflowId}/batches
// request (csv_import variant)
{
  "workflowSnapshotId": "latest",
  "type": "csv_import",
  "csvUploadToken": "30223f0c-9e54-433a-a2cc-a73bfdbf8160",
  "config": { "standaloneActions": [] }
}
// response 200
{
  "batch": {
    "id": "wfrb_0td53tdpsJJPJvU4JVQ",
    "workflowSnapshotId": "wfs_0td53tdasiaXkDuHAMS",
    "workflowId": "wf_0td53tcB7umSGm777g5",
    "workflowName": "INV-024 scratch 1775592336293",
    "status": "pending",
    "type": "csv_import",
    "createdBy": 1282581,
    "config": {
      "csvFile": { "fileSize": 35, "filename": "inv024-test.csv" },
      "parameterNames": ["Name", "Email"]
    },
    "state": { "lastOffsetProcessed": 0 },
    "createdAt": "2026-04-07T20:05:37.296Z",
    "updatedAt": "2026-04-07T20:05:37.296Z",
    "totalRuns": 0, "completedRuns": 0, "failedRuns": 0,
    "pendingRuns": 0, "runningRuns": 0
  }
}
```

**Server-side enrichments to the batch object**:
- `workflowSnapshotId: 'latest'` is replaced with a real `wfs_...` snapshot id
- `config.csvFile = {fileSize, filename}` is reconstructed from the upload metadata
- `config.parameterNames = string[]` is parsed from the CSV's first row
- `state.lastOffsetProcessed: 0` is initialized (used by the cursor-based row processor)

### Status enum + lifecycle

The `BatchStatus` enum is `pending | running | completed | failed | cancelled`.
A batch transitions `pending → failed` within ~430ms when the snapshotted
workflow has **zero defined steps**. The list-batches and get-by-id calls
both already showed `status: 'failed'`. `runs` array is empty
(`total: 0`) — the executor never spawned any rows because there was nothing
to execute.

This confirms the credit-safety hypothesis: **batches with no enrichment
steps consume zero credits** because no work units (`Y_` workflow runs) are
created. `totalRuns=0` in the saved result is the smoking gun.

### BatchType enum

`csv_import | cpj_search`. The `cpj_search` variant takes no `csvUploadToken`
and is presumably "create from a Company People Jobs search query"
(saved-search → batch). Not exercised in this investigation.

### Bundle indexing tip

When grepping a 8.4 MB minified bundle, `grep -ob` is the right tool because
the file is essentially three giant lines. Byte offsets pointed straight at
two distinct regions: the ts-rest router schema (offsets ~388 KB) and the
React mutation callsite (~4.33 MB). The schema region is canonical — it
encodes all routes for a sub-router contiguously.

## New Endpoints Discovered

Added to `endpoints.jsonl` (status `confirmed` unless noted):

1. `POST /v3/workspaces/{workspaceId}/tc-workflows/{workflowId}/batches` — createWorkflowRunBatch
2. `GET /v3/workspaces/{workspaceId}/tc-workflows/{workflowId}/batches` — getWorkflowRunBatches
3. `GET /v3/workspaces/{workspaceId}/tc-workflows/{workflowId}/batches/{batchId}` — getWorkflowRunBatch
4. `PATCH /v3/workspaces/{workspaceId}/tc-workflows/{workflowId}/batches/{batchId}` — updateWorkflowRunBatch (status `suspected`; body shape from bundle, not exercised)
5. `DELETE /v3/workspaces/{workspaceId}/tc-workflows/{workflowId}/batches/{batchId}` — deleteWorkflowRunBatch
6. `GET /v3/workspaces/{workspaceId}/tc-workflows/{workflowId}/batches/{batchId}/runs` — getWorkflowRunsForBatch

## Implications

1. **Programmatic workflow batch ingestion is now end-to-end-feasible.** Three
   API calls + one S3 POST land a CSV in a workflow as a batch:
   `csv-upload-url` → S3 POST → `createWorkflowRunBatch` → poll `getWorkflowRunBatch`.
   For the proprietary API layer this is a clean drop-in for "kick off a
   workflow over an uploaded CSV".
2. **The tc-workflows API surface is broader than previously documented.**
   `endpoints.jsonl` now lists 6 batch endpoints in addition to the 3 workflow
   CRUD endpoints from INV-023. We still have not enumerated:
   - Workflow step CRUD (how to define what the workflow actually does)
   - Workflow snapshot semantics (`workflowSnapshotId='latest'` resolution)
   - The `cpj_search` batch type (sibling to `csv_import`)
   - Workflow run lifecycle (the `Y_` schema has its own status enum, see bundle
     `getWorkflowRunsForBatch` response)
3. **`workflowSnapshotId: 'latest'` is the documented client convention.** The
   server resolves it to the workflow's current definition snapshot. This
   matches the workflow snapshotting pattern in similar pipeline products.
4. **Empty workflows are credit-safe scratch resources.** Useful pattern for
   future tc-workflows investigations: create empty workflow → exercise
   batches/runs/snapshots → delete. Zero credit risk.

## Cleanup status

- Scratch batch `wfrb_0td53tdpsJJPJvU4JVQ` — DELETE 200
- Scratch workflow `wf_0td53tcB7umSGm777g5` — DELETE 200
- No residue. (Note: doc `doc_0td531mAWhrhgzXcufb` from INV-023 still leftover —
  not in scope here.)

## Files Updated

- `investigations/INV-024_workflow-batch-run.md` (this file)
- `investigations/_index.md`
- `registry/endpoints.jsonl` (+6 endpoints; 5 confirmed, 1 suspected)
- `registry/capabilities.md` (workflow batch ingestion section)
- `registry/gaps.md` (closed GAP-030)
- `registry/changelog.md` (2026-04-07 entry)
- `knowledge/internal-v3-api.md` (tc-workflows batch ingestion flow)
- `harness/scripts/verify-workflow-batch-run.ts` (new)
- `harness/results/inv-024-workflow-batch-1775592335777.json` (raw results)

## Next Steps

1. **Workflow step CRUD** — How does one define the actual steps of a
   tc-workflow? The bundle's `xwe` router covers batches; there must be a
   sibling router for steps/nodes. Probably under
   `/v3/workspaces/{ws}/tc-workflows/{wf}/steps` or similar. Required to make
   batches do useful work.
2. **`cpj_search` batch type** — Exercise the second discriminant of
   `createWorkflowRunBatch`. Find what `cpj_search` config requires (probably
   a saved search id or query DSL).
3. **Workflow run semantics** — When a batch DOES spawn runs (i.e. against a
   non-empty workflow with 1-2 cheap steps), document the `Y_` run schema,
   the run status enum, and per-run cost. Plan a credit-safe probe with the
   cheapest possible action (e.g. `normalize-company-name`, ~1 credit).
4. **`updateWorkflowRunBatch` PATCH** — Verify against an in-flight batch
   (hard to test reliably with empty workflows since they fail in <500ms).
   Likely useful for cancellation: PATCH `{status: 'cancelled'}`.
5. **Workflow snapshot listing** — `wfs_...` ids appear in batch responses
   but no GET endpoint surfaced them yet. Likely
   `/v3/workspaces/{ws}/tc-workflows/{wf}/snapshots` exists.
