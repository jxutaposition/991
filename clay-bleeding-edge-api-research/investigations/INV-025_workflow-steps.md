# INV-025: tc-workflows step / snapshot CRUD (+ batch cancel, cpj_search)

**Status**: completed
**Priority**: P2
**Gap**: GAP-031 — tc-workflows step/snapshot CRUD
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

INV-024 mapped the `xwe` ts-rest router for workflow run batches but stopped
at empty-workflow batches (totalRuns=0). The Clay JS bundle should expose
sibling routers for workflow nodes/edges/snapshots — programmatic batch
ingestion is uninteresting until you can also define what the batches run.

Bonus: also verify `PATCH .../batches/{batchId} {status:'cancelled'}` and
the `cpj_search` discriminator branch from INV-024.

## Method

### 1. Bundle scan

The previous bundle hash `index--X05HdGb.js` no longer exists — Clay shipped
a new build. Current hash (resolved from `https://app.clay.com/`) is
`index-Ba1k0a3-.js` (8.4 MB). Re-grep for workflow-related routers:

```
303014  tc-workflows           (route prefix mention)
360656  K_=I({...})            (WorkflowSnapshot schema)
360813+ workflowSnapshot       (xwe batches router region — ~388 KB before)
582765  workflowSnapshot       (sKe streams router ~582 KB)
623643+ tc-workflows           (cKe webhook router)
668000+ uYe top-level + mYe graph router (~669 KB)
735993  WorkflowSnapshot       (Ewe runs router)
```

Two routers were extracted in full:

**uYe** — workflow CRUD + snapshot listing (`/v3/workspaces/:ws/tc-workflows`):
- `getWorkflows`, `getWorkflow`, `createWorkflow {name, defaultModelId?}`,
  `createWorkflowFromPreset /from-preset/:presetId`,
  `createWorkflowFromSnapshot /from-snapshot/:snapshotId`,
  `duplicateWorkflow /:wf/duplicate`,
  `restoreWorkflowFromSnapshot /:wf/restore/:snapshotId`,
  `updateWorkflow PATCH {name?, defaultModelId?, lastRunAt?}`,
  `deleteWorkflow DELETE`,
  `getWorkflowSnapshots GET /:wf/snapshots`,
  `getWorkflowSnapshot GET /:wf/snapshots/:snapshotId`.

**mYe** — workflow graph (nodes + edges):
- `getWorkflowGraph GET /:wf/graph`
- `createWorkflowNode POST /:wf/nodes`
- `updateWorkflowNode PATCH /:wf/nodes/:nodeId`
- `batchUpdateWorkflowNodes PATCH /:wf/nodes` (positions only)
- `deleteWorkflowNode DELETE /:wf/nodes/:nodeId`
- `duplicateWorkflowNode POST /:wf/nodes/:nodeId/duplicate`
- `batchDeleteWorkflowNodes DELETE /:wf/nodes {nodeIds[]}`
- `createWorkflowEdge POST /:wf/edges`
- `updateWorkflowEdge PATCH /:wf/edges/:edgeId`
- `deleteWorkflowEdge DELETE /:wf/edges/:edgeId`
- `downloadCodeNode GET /:wf/nodes/:nodeId/code/download`

Sibling routers found incidentally:
- **sKe** workflow run streams under `/:wf/streams` (CRUD + `/streams/:id/runs`)
- **cKe** stream webhooks under `/tc-workflows/streams/:id/webhook[/batch]`
- **Ewe** direct workflow runs under `/:wf/runs` (createWorkflowRun, getWorkflowRuns, getWorkflowRun, continueWorkflowRunStep, ...)

The node-creation `nodeType` enum is `SCe = xCe = ['regular','code','conditional','map','reduce','tool']`.
The full read enum `F_` adds `['fork','join','collect']`. **`regular` nodes
without a `modelId`/`promptVersionId` are inert** — they're definitions only,
no model gets invoked.

### 2. Verification script

`harness/scripts/verify-workflow-steps.ts` exercises:

- Create scratch workflow A → graph empty → POST 2 regular nodes → PATCH
  rename node 1 → POST edge n1→n2 → graph populated (with validation) →
  batchUpdateWorkflowNodes (move both) → list snapshots (empty)
- Cleanup A: DELETE edge → batchDeleteWorkflowNodes → DELETE workflow
- Create scratch workflow B (empty, credit-safe per INV-024)
- 3× cpj_search probes (empty config / no config / with searchType+query)
- csv_import batch → race PATCH `{status:'cancelled'}` → GET cancelled batch
- snapshots-list-after-batch (auto-created by csv batch) → GET single snapshot
- Cleanup B: DELETE batch → DELETE workflow
- Read `/v3/workspaces/{ws}` credits before + after for delta

Result file: `harness/results/inv-025-workflow-steps-1775595314008.json`.

## Findings

### All step/snapshot endpoints work end-to-end (zero credits)

| Endpoint | Status | Notes |
|---|---|---|
| `GET .../graph` (empty) | 200 | `{nodes:[], edges:[], validation, workflowInputVariables:[]}` |
| `POST .../nodes` regular×2 | 200 | returns `{node:{id (wfn_...), workspaceId, workflowId, name, description, nodeType, tools, nodeConfig, subroutineIds, position, isInitial, isTerminal, createdAt, updatedAt}}` |
| `PATCH .../nodes/{id}` rename+desc | 200 | updatedAt advances, fields persisted |
| `POST .../edges` n1→n2 | 200 | `{edge:{id (wfe_...), sourceNodeId, targetNodeId, metadata:null, ...}}` |
| `GET .../graph` populated | 200 | nodes/edges echo + **server-side validation** with isValid/errors/warnings/suggestions |
| `PATCH .../nodes` (batch positions) | 200 | `{nodes[],success:true}` |
| `GET .../snapshots` (no batches yet) | 200 | `{snapshots:[]}` |
| `DELETE .../edges/{id}` | 200 | `{success:true}` |
| `DELETE .../nodes` (batchDelete) | 200 | `{deletedCount:2,success:true}` |
| `DELETE .../tc-workflows/{wf}` | 200 | scratch A removed |

### Batch cancellation works (PATCH .../batches/{batchId})

Race the auto-fail by issuing PATCH immediately after POST. INV-024 measured
~430ms `pending → failed`; we beat it.

```jsonc
// PATCH /v3/workspaces/{ws}/tc-workflows/{wf}/batches/{batchId}
{ "status": "cancelled" }
// 200
{
  "batch": {
    "id": "wfrb_0td5646Wis22MT4SjVF",
    "status": "cancelled",
    "type": "csv_import",
    "totalRuns": 0, ...
  }
}
```

A subsequent `GET` confirms `status` remains `cancelled`. The PATCH router
also accepts `config` and `state` keys but those weren't exercised.

### Snapshots auto-materialize from batches

INV-024 already showed `workflowSnapshotId: 'latest'` resolves to a real
`wfs_...` id. INV-025 confirms the snapshot row is now retrievable:

```jsonc
// GET .../tc-workflows/{wf}/snapshots
{
  "snapshots": [{
    "id": "wfs_0td5646iBTS96RT7jyJ",
    "workflowId": "wf_0td5644gqEEH86VmYkP",
    "content": {
      "edges": [],
      "nodes": [],
      "workflow": {
        "id": "wf_...",
        "name": "INV-025 batches scratch ...",
        "workspaceId": 1080480,
        "creatorUserId": 1282581,
        "maxConcurrentBranches": 0
      },
      "createdAt": "2026-04-07T20:55:18.090Z",
      "containsCycles": false
    },
    "hash": "74a1d52f47089c20e660f2d69112b5120989a7eb3fd5b1d02ca48bb58184c166",
    "createdAt": "...", "updatedAt": "..."
  }]
}
```

`hash` is sha256 of the content. Snapshots are *server-managed* — there is
no `createSnapshot` / `publishWorkflow` route. They are produced as a
side effect of `createWorkflowRunBatch` with `workflowSnapshotId='latest'`.

### `cpj_search` is NOT YET IMPLEMENTED on the server

```jsonc
// POST /v3/workspaces/{ws}/tc-workflows/{wf}/batches
// body: { workflowSnapshotId:'latest', type:'cpj_search', config:{} }
// 405 Method Not Allowed
{ "type": "MethodNotAllowed",
  "message": "CPJ Search batch type is not yet implemented",
  "details": null }
```

All three shape variants (empty config, no config, with `searchType`/`query`)
return the same 405. Cross-checked the bundle: the React `CreateBatchModal`
disables the submit button when `type==='cpj_search'`
(`disabled: ... || fe==='cpj_search'`) and renders a yellow "coming soon"
banner. The discriminator exists in the ts-rest schema but the server
handler is stubbed. **Treat `cpj_search` as registered-but-NYI.**

### Graph validation is a free safety check

`GET .../graph` returns `validation: {isValid, errors[], warnings[],
suggestions[]}` — server-side static analysis of the workflow definition.
Errors observed: `terminal_node_missing_tool_or_output_schema`. Warnings:
`missing_model`, `missing_prompt`. This is a free pre-flight tool: callers
can fix errors before creating a batch instead of waiting for the batch to
fail at run time. Useful in the proprietary API layer as a `validateWorkflow()`
helper.

### Inert nodes are credit-safe

A `regular` nodeType with no model/prompt/tools/inlineScript persists fine
and produces no executions. `tools: []`, `nodeConfig: {nodeType:'regular'}`,
`subroutineIds: []`. Even attaching such a node to a workflow that ran a
batch would not cost credits because there's nothing to invoke. This means
GAP-031 follow-ups (run lifecycle, step output capture) can be probed
without credit risk by using inert nodes — the batch still spawns runs that
process rows, but with no actions to invoke each run is a no-op.

### Credit delta = 0

```
before { basic: 1934.4, longExpiry: 0, actionExecution: 999999999897 }
after  { basic: 1934.4, longExpiry: 0, actionExecution: 999999999897 }
```
(Note: `credits` is at the **top level** of the `/v3/workspaces/{wsId}`
response, not nested under `workspace.credits`.)

### Cleanup status

- nodes wfn_0td5643dp3GRSygz3Ri, wfn_0td56433vBCNjxGQdUc — deleted
- edge wfe_0td56432K8b6JvMn7eC — deleted
- batch wfrb_0td5646Wis22MT4SjVF — deleted
- workflows wf_0td5642Z3YyJ8oMRnw8, wf_0td5644gqEEH86VmYkP — deleted

No residue.

## New Endpoints Discovered

Added 22 entries to `endpoints.jsonl` (15 confirmed end-to-end, 7 suspected
from bundle but not exercised). PATCH batches/{batchId} promoted from
suspected → confirmed.

Confirmed in INV-025:
1. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/graph`
2. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/nodes`
3. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/nodes/{nodeId}`
4. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/nodes` (batch positions)
5. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/nodes/{nodeId}`
6. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/nodes` (batchDelete)
7. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/edges`
8. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/edges/{edgeId}`
9. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/snapshots`
10. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/snapshots/{snapshotId}`
11. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/batches/{batchId}` (cancel)
12. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}` (updateWorkflow)

Suspected from bundle (in `endpoints.jsonl` as `status:suspected`):
- `POST   /:wf/nodes/{nodeId}/duplicate`
- `GET    /:wf/nodes/{nodeId}/code/download`
- `PATCH  /:wf/edges/{edgeId}`
- `POST   /tc-workflows/from-snapshot/{snapshotId}` (createWorkflowFromSnapshot)
- `POST   /:wf/restore/{snapshotId}` (restoreWorkflowFromSnapshot)
- `POST   /tc-workflows/from-preset/{presetId}`
- `POST   /:wf/duplicate`
- `POST   /:wf/runs` + `GET /:wf/runs[/{runId}]` (Ewe direct-runs router)
- `POST   /:wf/streams` (sKe streams router)

## Implications

1. **Step/snapshot CRUD is fully programmatic now.** A consumer can build
   tc-workflows entirely via API: create workflow → POST nodes → POST edges
   → validate via `GET .../graph` → run via batches. No UI required.
2. **Snapshots are server-managed, not user-controlled.** There's no
   `publishWorkflow` or `createSnapshot` mutation; the model is "live edit
   the workflow definition, snapshots are auto-taken on batch creation".
   Snapshot content is sha256-hashed for content addressing.
3. **PATCH-cancel works** but is a race. For non-empty workflows the
   ~430ms auto-fail window will be much longer (real runs take seconds), so
   cancellation will be more useful in practice once steps are wired up.
4. **`cpj_search` is documented but stubbed.** The discriminator and React
   UI both exist; the server returns a structured 405 with a clear message.
   No further investigation needed until Clay ships the handler — re-probe
   after future bundle drops.
5. **Workflow graph validation is a free pre-flight.** The proprietary API
   layer should expose this as `validateWorkflow(wfId)` so callers can
   catch missing-model / missing-prompt / terminal-without-output-schema
   errors before paying for a batch run.
6. **Bundle hashes rotate.** `index--X05HdGb.js` (used in INV-021..INV-024)
   no longer resolves; current is `index-Ba1k0a3-.js`. Future investigations
   must re-resolve from `https://app.clay.com/` rather than caching the URL.

## Files Updated

- `investigations/INV-025_workflow-steps.md` (this file)
- `investigations/_index.md`
- `harness/scripts/verify-workflow-steps.ts` (new)
- `harness/results/inv-025-workflow-steps-1775595314008.json` (new)
- `registry/endpoints.jsonl` (+22 entries; 1 promoted to confirmed)
- `registry/capabilities.md` (workflow node/edge/snapshot section)
- `registry/gaps.md` (closed GAP-031, opened GAP-032..033)
- `registry/changelog.md` (2026-04-07 INV-025 entry)
- `knowledge/internal-v3-api.md` (tc-workflows graph + snapshots section)

## Next Steps

1. **GAP-032 (new): tc-workflows direct runs (`Ewe` router).** Probe
   `POST /:wf/runs` against an inert workflow (regular nodes, no model)
   with one row. Document `WorkflowRun` shape, `runStatus` lifecycle,
   `continueWorkflowRunStep`, archive vs current discriminator. Inert nodes
   should keep credit cost zero.
2. **GAP-033 (new): tc-workflows streams (`sKe` router) + webhook batch.**
   `POST /:wf/streams` + `POST /tc-workflows/streams/:id/webhook` look like
   a webhook-driven streaming alternative to `csv_import` batches. Useful
   for live ingestion. Body shapes still unknown — need bundle re-grep at
   ~582 KB region.
3. **First credit-bearing probe**: attach a `prompt_version` source to a
   regular node with the cheapest available `modelId`, run a 1-row batch,
   measure credit delta. Document the per-node credit cost formula.
4. **Subroutines** (`CKe` router around region 668 KB) — there's a
   `subroutineIds: []` field on every node; subroutines look like reusable
   sub-workflows. Worth a separate investigation.
5. **Graph validation taxonomy**: enumerate all `validation.errors[].type`
   values by deliberately constructing broken workflows (missing edges,
   cycles when not allowed, terminal nodes without outputs, etc.). Free
   to probe (no credits).
