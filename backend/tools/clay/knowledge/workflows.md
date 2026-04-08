# Clay Workflows (tc-workflows)

Reference for Clay's agentic workflow product. Distinct from enrichment runs (which are per-row column operations on tables) — workflows are graphs of nodes that execute prompts/code/tools, with HITL support, snapshots, and webhook ingestion.

**When to use a workflow vs an enrichment run:**
- **Enrichment** (`clay_trigger_enrichment`): you have a table column with an enrichment provider (LinkedIn, Apollo, etc.) and want to run it on specific rows. Per-row provider call.
- **Workflow** (`clay_run_workflow`): you have a multi-step agentic graph (LLM nodes, tool calls, branching) that processes inputs end-to-end and produces a result. Think Claygent.

All endpoints are session-cookie authed and live under `/v3/workspaces/{wsId}/tc-workflows/...`. The internal router name is `Swe` for direct runs, `lKe` for streams, `uKe` for webhook ingestion. (Don't memorize these; just useful when grepping the bundle.)

## Workflow CRUD

| Method | Path | Tool | Notes |
|---|---|---|---|
| GET | `/v3/workspaces/{wsId}/tc-workflows` | `clay_list_workflows` | Returns `{workflows: [{id (wf_…), name, defaultModelId, lastRunAt, …}]}` |
| POST | `/v3/workspaces/{wsId}/tc-workflows` | `clay_create_workflow` | Body `{name (≤255), defaultModelId?}` → `{workflow: {id, …}}` |
| PATCH | `/v3/workspaces/{wsId}/tc-workflows/{wfId}` | (no tool) | Update name / defaultModelId. Use `http_request` if needed. |
| DELETE | `/v3/workspaces/{wsId}/tc-workflows/{wfId}` | (no tool) | Body `{}` required. Returns `{success}`. |

## Run lifecycle (direct runs — the common case)

| Method | Path | Tool | Notes |
|---|---|---|---|
| POST | `.../tc-workflows/{wfId}/runs` | `clay_run_workflow` | Body `{inputs?: object, batchId?, standaloneActions?: object}`. Auto-resolves `'latest'` snapshot. Starts executing immediately. Returns `{workflowRun: {id (wfr_…), runStatus: 'running', …}}`. |
| GET | `.../tc-workflows/{wfId}/runs` | `clay_list_workflow_runs` | Query `{limit?, offset?}` |
| GET | `.../tc-workflows/{wfId}/runs/{runId}` | `clay_get_workflow_run` | Returns discriminated `{type:'current', workflowRun, workflowRunSteps[], workflowSnapshot}` or `{type:'archived', archivedAgentRun}`. Step telemetry includes prompts, tool calls, reasoning, token usage. |
| POST | `.../runs/{runId}/pause` | `clay_pause_workflow_run` | Body `{}`. 400 if already terminal. |
| POST | `.../runs/{runId}/unpause` | `clay_unpause_workflow_run` | Body `{}`. 400 if not paused. |
| POST | `.../runs/{runId}/steps/{stepId}/continue` | `clay_continue_workflow_step` | HITL feedback. Body `{humanFeedbackInput: {type: 'ApproveToolCall'\|'DenyToolCall'\|'DenyTransition'\|…, …}}`. |
| GET | `.../tc-workflows/{wfId}/steps/waiting` | `clay_list_waiting_steps` | Returns `{waitingSteps: [{stepId, runId, nodeName, callbackData, …}]}`. Drives HITL UI. |

### Run status enums (two of them, NOT 1:1)
- `runStatus` (top-level): `pending | running | paused | completed | failed | waiting`
- `runState.status` (inner discriminated union): `running | paused | completed | failed`

When checking "is this run done?", read `runStatus`. The inner `runState` is a discriminator for the union body, not an independent status — it can be stale relative to `runStatus`.

### Append-only constraint — there is NO cancel/delete on direct runs
- `PATCH .../runs/{runId}` → 404
- `DELETE .../runs/{runId}` → 404

To cancel a single run, wrap its invocation inside a 1-row csv_import batch and PATCH the batch with `{status: 'cancelled'}` (see Batches section). Direct runs cannot be cancelled — only paused/unpaused, and pause is best-effort.

### "Inert" nodes are NOT inert
A `regular` workflow node with no `modelId` and no prompt is **not** a no-op. Clay silently injects `anthropic:claude-haiku-4-5` plus a ~2 KB system prompt plus built-in tools (`memory_search`, `fail_node`, transition actions). A 2-node "inert" test workflow burned ~12k tokens in INV-026.

The workspace credit delta from this was zero on the dev workspace, but that workspace has effectively unlimited `actionExecution` credits. **Do not assume runs against inert nodes are credit-free on a normal paid workspace.** Always test on a small batch first. (Tracked as GAP-034 in research.)

### Other gotchas on the run create endpoint
- `workflowSnapshotId` in the request body is **silently ignored**. The server always resolves `'latest'` itself.
- `standaloneActions` must be an **object**, not an array. Passing `[]` returns 400 `"Expected object, received array"`.

## Workflow graph (nodes + edges)

| Method | Path | Tool | Notes |
|---|---|---|---|
| GET | `.../tc-workflows/{wfId}/graph` | (no tool) | Returns `{nodes, edges, validation: {isValid, errors[], warnings[], suggestions[]}, workflowInputVariables}`. Free pre-flight static analysis. |
| POST | `.../tc-workflows/{wfId}/nodes` | `clay_create_workflow_node` | Body `{name (≤255), description?, nodeType: 'regular'\|'code'\|'conditional'\|'map'\|'reduce'\|'tool', modelId?, promptVersionId?, position?, isInitial?, isTerminal?}` → `{node: {id (wfn_…), …}}` |
| PATCH | `.../nodes/{nodeId}` | (no tool) | Many optional fields incl. `source` (discriminated `prompt_version`/`inline_prompt`/`input_schema`), `toolIds`, `inlineScript`, `nodeConfig`, `interventionSettings`, `retryConfig`. |
| PATCH | `.../nodes` | (no tool) | Batch reposition: body `{updates: [{nodeId, position}]}`. |
| DELETE | `.../nodes/{nodeId}` | (no tool) | Body `{}`. Returns `{success}`. |
| DELETE | `.../nodes` | (no tool) | Batch delete: body `{nodeIds: []}`. Returns `{deletedCount, success}`. |
| POST | `.../tc-workflows/{wfId}/edges` | `clay_create_workflow_edge` | Body `{sourceNodeId, targetNodeId, metadata?: {conditionalSourceHandle?}}` → `{edge: {id (wfe_…), …}}` |
| DELETE | `.../edges/{edgeId}` | (no tool) | Body `{}`. |

## Snapshots (read-only, server-managed)

Snapshots are **auto-created** by `createWorkflowRunBatch` when `workflowSnapshotId='latest'`. There is no `publishWorkflow` or `createSnapshot` route — snapshots are a side effect of running a batch.

| Method | Path | Tool | Notes |
|---|---|---|---|
| GET | `.../tc-workflows/{wfId}/snapshots` | (no tool) | Returns `{snapshots: [{id (wfs_…), workflowId, content, hash, createdAt, …}]}`. Empty until first batch. |
| GET | `.../snapshots/{snapshotId}` | `clay_get_workflow_snapshot` | Returns `{snapshot: {…content embeds full nodes/edges/workflow at snapshot time}}` |

## Batches (CSV-driven runs)

Used when you have a CSV of inputs and want to run the workflow once per row. Three-step flow:

1. `POST .../tc-workflows/{wfId}/batches/csv-upload-url` — body `{filename, fileSize}`, returns `{uploadUrl, fields, uploadToken}`.
2. Caller does `multipart/form-data POST` to `uploadUrl` (S3) with `fields` first and the file last. S3 returns 204.
3. `POST .../tc-workflows/{wfId}/batches` — body `{workflowSnapshotId: 'latest', type: 'csv_import', csvUploadToken, config?}`. Returns `{batch: {id (wfrb_…), status, totalRuns, completedRuns, …}}`.

| Method | Path | Tool | Notes |
|---|---|---|---|
| GET | `.../batches` | (no tool) | Query `{limit?, offset?, status?}` → `{batches[], total}` |
| GET | `.../batches/{batchId}` | (no tool) | Used for status polling. |
| PATCH | `.../batches/{batchId}` | (no tool) | Body `{status?, config?, state?}`. PATCH `{status:'cancelled'}` is the **only way to cancel** a workflow run (wrap a single run in a 1-row csv_import batch if you need cancellability). For empty workflows, race the ~430 ms auto-fail. |
| DELETE | `.../batches/{batchId}` | (no tool) | Body `{}`. Soft delete. |
| GET | `.../batches/{batchId}/runs` | (no tool) | Query `{limit?, offset?}` → `{runs[], total}` |

The other discriminator value `cpj_search` is a server stub — POSTing returns 405 "CPJ Search batch type is not yet implemented".

## Streams (webhook-driven runs)

Streams ingest external webhook events into a workflow. Each event spawns one run.

| Method | Path | Notes |
|---|---|---|
| POST | `.../tc-workflows/{wfId}/streams` | Body `{workflowSnapshotId, streamType: 'webhook'\|'agent_action'\|'workflow_action', name, config, status?}`. For `streamType='webhook'`, response includes `webhookUrl`. |
| GET / PATCH / DELETE | `.../streams[/{streamId}]` | Full CRUD. PATCH `{status: 'paused'}` blocks ingestion; DELETE is soft (sets `deletedAt`; spawned runs survive). |
| GET | `.../streams/{streamId}/runs` | List runs spawned by this stream. |
| **POST** | **`/v3/tc-workflows/streams/{streamId}/webhook`** | **Unauthenticated**. Root path — no `/workspaces/{ws}` prefix. streamId is the bearer. Body becomes `runState.inputs` verbatim. 202 Accepted. Errors: 400 (paused), 404 (bad streamId), 429 (retryAfter). |

**Bug**: Clay's stream-create response returns `webhookUrl` without the `/v3` prefix, but that URL form 404s. Consumers must rewrite to prepend `/v3`.

The batch webhook variant (`POST .../streams/{streamId}/webhook/batch`) is **internal-only** — every user-facing auth scheme returns 401/403. Reserved for Clay's own backfill workers. Use the single-event endpoint in a loop instead.

## Quick decision flowchart

```
Need to process N inputs through a workflow?
├── N == 1, want full control (cancel mid-flight, get steps live)
│   → wrap as a 1-row csv_import batch (PATCH-cancellable)
│
├── N == 1, fire-and-monitor
│   → clay_run_workflow (direct run; no cancel, only pause)
│
├── N small (< 100), CSV is convenient
│   → CSV batch flow (3 steps)
│
└── Continuous / event-driven from external system
    → Create a webhook stream, share streamId with the source system
```

## Cross-references
- Investigation timeline: [INV-024](../../../../clay-bleeding-edge-api-research/investigations/INV-024_workflow-batch-run.md), [INV-025](../../../../clay-bleeding-edge-api-research/investigations/INV-025_workflow-steps.md), [INV-026](../../../../clay-bleeding-edge-api-research/investigations/INV-026_direct-workflow-runs.md), [INV-027](../../../../clay-bleeding-edge-api-research/investigations/INV-027_workflow-streams.md)
- Capability matrix: [registry/capabilities.md](../../../../clay-bleeding-edge-api-research/registry/capabilities.md)
