# INV-025: tc-workflows Step / Snapshot CRUD + Cancel + cpj_search

**Date**: 2026-04-07
**Investigation**: INV-025
**Credit cost**: 0

## HEADLINE

Step/snapshot CRUD is fully programmatic. A consumer can now build
tc-workflows entirely via API: create workflow → POST nodes → POST
edges → validate via `GET /graph` → run via batches. Closes GAP-031.
Opens GAP-032 (direct runs router) and GAP-033 (streams router).

## Endpoints Confirmed (12)

1. `GET    .../tc-workflows/{wf}/graph`
   → `{nodes, edges, validation:{isValid,errors,warnings,suggestions},
       workflowInputVariables}`
2. `POST   .../tc-workflows/{wf}/nodes`
3. `PATCH  .../tc-workflows/{wf}/nodes/{nodeId}`
4. `PATCH  .../tc-workflows/{wf}/nodes` (batch reposition)
5. `DELETE .../tc-workflows/{wf}/nodes/{nodeId}` (body `{}`)
6. `DELETE .../tc-workflows/{wf}/nodes` (body `{nodeIds[]}`)
7. `POST   .../tc-workflows/{wf}/edges`
8. `DELETE .../tc-workflows/{wf}/edges/{edgeId}` (body `{}`)
9. `GET    .../tc-workflows/{wf}/snapshots`
10. `GET    .../tc-workflows/{wf}/snapshots/{snapshotId}`
11. `PATCH  .../tc-workflows/{wf}/batches/{batchId}` — promoted
    suspected → confirmed by racing the ~430ms auto-fail window.
    PATCH `{status:'cancelled'}` works.
12. `PATCH  .../tc-workflows/{wf}` (`updateWorkflow`)

Plus 9 more added as `suspected` from the bundle: `nodes/{id}/duplicate`,
`nodes/{id}/code/download`, `edges/{id}` PATCH, `from-snapshot`,
`from-preset`, `restore/{snapshotId}`, `duplicate`, `runs` (Ewe — see
INV-026 correction), `streams` (sKe).

## Surprises & Gotchas

- **Snapshots are server-managed.** No `publishWorkflow` or
  `createSnapshot` route exists. Snapshots auto-materialize when
  `createWorkflowRunBatch` is called with `workflowSnapshotId='latest'`.
  `content.hash` is sha256 — content-addressed.
- **Graph validation is a free pre-flight.** Server-side static
  analysis returns errors like
  `terminal_node_missing_tool_or_output_schema` and warnings like
  `missing_model`, `missing_prompt`. Useful as a `validateWorkflow()`
  helper before paying for a real batch.
- **`cpj_search` is registered-but-NYI.** Server returns 405
  `"CPJ Search batch type is not yet implemented"` for all three
  shape variants tried. The React `CreateBatchModal` disables the
  submit button when `type === 'cpj_search'` and shows a yellow
  "coming soon" banner. Re-probe after future bundle drops.
- **Inert nodes are credit-safe (claim contradicted in INV-026 — see
  next entry).** A `regular` node with no
  model/prompt/tools/inlineScript persists fine and at INV-025 time
  appeared to consume zero credits. INV-026 then showed Clay
  silently injects a default Claude agent on regular nodes with no
  modelId — so the credit-safety claim only holds on this dev
  workspace; needs re-verification on a normal paid workspace
  (GAP-034).
- **Bundle hash rotated.** `index--X05HdGb.js` (INV-021..INV-024) no
  longer resolves; current is `index-Ba1k0a3-.js`. Future
  investigations must always re-resolve from `https://app.clay.com/`
  HTML and never cache the URL.
- **`GET /v3/workspaces/{wsId}` returns `credits` at the TOP LEVEL**,
  not under `workspace.credits`. Worth fixing in any reference doc
  that says otherwise.
- Node enum: `regular | code | conditional | map | reduce | tool`
  for create; read enum adds `fork | join | collect`.

## Cross-reference

`investigations/INV-025_workflow-steps.md`
