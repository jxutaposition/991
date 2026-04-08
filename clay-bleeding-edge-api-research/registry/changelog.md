# Discovery Changelog

Timestamped log of significant discoveries and registry updates.

## 2026-04-07: INV-028 — Clay API-key CRUD (`TRe` router) + productized inbound webhook channel (GAP-036 closed, GAP-038 opened)

**Source**: `harness/scripts/verify-webhook-batch-auth.ts` + pass-2 `verify-webhook-batch-auth-2.ts` + bundle re-scan of `index-BS8vlUPJ.js` (unchanged since INV-027). Targeted GAP-036: "does `postWebhookBatch` require API-key auth, and how do we mint one?"

**Router discovered — `TRe = apiKeys`** (4 routes, all at global `/v3/api-keys`, session-cookie auth):

1. `GET /v3/api-keys?resourceType=user&resourceId=<uid>` — list user keys (upgrade from INV-017's suspected placeholder to fully confirmed).
2. `POST /v3/api-keys` body `{name, resourceType:'user', resourceId:<uid>, scope:{routes:Kb[], workspaceId?:number}}` → 200 with plaintext `apiKey` exposed ONCE (matches UI modal "will not be displayed again"). Key ids are `ak_`-prefixed.
3. `PATCH /v3/api-keys/:apiKeyId` body `{name?, workspaceId?}` — not exercised, bundle-confirmed.
4. `DELETE /v3/api-keys/:apiKeyId` body `{}` → `{success:true}`. Verified end-to-end (5 scratch keys minted+deleted cleanly).

**Scope enum (`Kb`) — 7 values, UI exposes only 3**: `all`, `endpoints:run-enrichment`, `endpoints:prospect-search-api`, `terracotta:cli`, `terracotta:code-node`, `terracotta:mcp`, `public-endpoints:all`. The `terracotta:*` family has no UI checkbox but IS mintable via direct API. **`terracotta:mcp` is particularly interesting** — strongly implies Clay has an MCP (Model Context Protocol) server surface shipped or in development. Opened as GAP-038.

**resourceType enum (`Gb`) has ONLY `'user'`** — workspace-scoped key listing returns 400. Keys are user-owned; `scope.workspaceId` constrains which workspace the key can act in.

**`postWebhookBatch` auth probe — exhaustive, all negative**:

- Minted 5 scratch keys across 4 scope sets: `['terracotta:cli']`, all three `terracotta:*`, `['all']`, and the full 7-scope union.
- Probed `POST /v3/tc-workflows/streams/{id}/webhook/batch` with canonical body `{items:[{requestData}]}` under 11 header forms: `Authorization: Bearer/bearer/Basic`, `X-Api-Key`, `X-Clay-API-Key`, `Clay-API-Key`, `clay-api-token`, `Token`, `x-auth-token`, query-param `?apiKey=`, `?api_key=`, plus no-auth and cookie.
- **Every combination 401 Unauthorized or 403 Forbidden**. Zod validation passes (wrong bodies return 400 `items Required`) — the handler IS reached, auth rejects after parse.
- Only `Clay-API-Key` produces a distinct 403 (vs universal 401), suggesting there's a middleware parsing that specific header but rejecting session-minted `ak_*` keys — possibly bound to the deprecated v1 key format.
- `/v1/tc-workflows/streams/{id}/webhook[/batch]` and `/v1/webhooks/{id}` all return 404/503 "deprecated API endpoint".
- **No frontend caller for `postWebhookBatch` exists in the bundle** — only the router definition. Contrast with `postWebhook` (single) which the Workflows editor calls directly.
- **Conclusion**: `postWebhookBatch` is internal-only, used by Clay's own async workers for backfill ingestion. Body shape `{entityId, backfillId, requestData}` is consistent with a worker iterating over source rows. Not externalizable. GAP-036 closed "by elimination".

**Breakthrough finding — single `postWebhook` is completely unauthenticated**:

INV-027 had assumed `POST /v3/tc-workflows/streams/{streamId}/webhook` required session cookies because that's how the script happened to send it. INV-028 pass 2 tried it with zero auth headers:

```
POST /v3/tc-workflows/streams/wfrs_.../webhook
(no Cookie, no Authorization, no anything)
{"email":"noauth-single@x.com"}
-> 202 {"success":true, "workflowRunId":"wfr_0td59w8HZxk3CMfmz22",
        "message":"Webhook request accepted and queued for processing"}
```

The streamId is the bearer token (same security model as Clay table webhook URLs or Slack incoming webhooks). This IS the productized inbound channel we were hunting for — it was hiding in plain sight. Reclassified the endpoint in `endpoints.jsonl` from `auth:session_cookie` to `auth:none`. Updated capabilities.md to reflect the unauthenticated nature. This was the main missing half of GAP-036.

**Minor backend bug documented**: Clay returns `webhookUrl: "https://api.clay.com/tc-workflows/streams/{id}/webhook"` (no `/v3`) in the stream-create response, but that URL form returns 404 HTML under every auth scheme. The `/v3`-prefixed form is the only routable path. Consumers integrating against `webhookUrl` as-returned will get a 404 — must rewrite to prepend `/v3`. Filed in INV-028 "Implications" for follow-up documentation.

**Endpoint registry changes**: +3 net (POST, PATCH, DELETE `/v3/api-keys` — GET was pre-existing as suspected, now upgraded to confirmed); reclassified `postWebhook` (single) to `auth:none`; updated `postWebhookBatch` notes to `auth:internal-only` with full INV-028 findings. Total: **120 endpoints**.

**Credit delta**: Zero. API key CRUD is free; the minted keys plus 3 scratch workflows + 2 scratch streams + ~60 probe POSTs moved neither `basic` nor `actionExecution`.

**Files updated**: `harness/scripts/verify-webhook-batch-auth.ts` (new), `harness/scripts/verify-webhook-batch-auth-2.ts` (new), `harness/results/inv-028-key-auth-1775600096405.json` (new), `harness/results/inv-028-p2-1775600207001.json` (new), `investigations/INV-028_api-key-auth.md` (new), `investigations/_index.md`, `registry/endpoints.jsonl` (+3 api-keys rows, +reclassifications), `registry/capabilities.md` (webhook + API-key rows), `registry/gaps.md` (closed GAP-036, opened GAP-038), `knowledge/internal-v3-api.md` (API-key CRUD section + webhook auth correction), `knowledge/authentication.md` (API-key minting via session cookies), `.gitignore` (added `.api-keys.json`), `timeline/2026-04-07_9_inv-028-api-key-auth.md` (new).

## 2026-04-07: INV-027 — tc-workflows streams (`lKe` router) + webhook ingestion (`uKe` router) (GAP-033 closed)

**Source**: `harness/scripts/verify-workflow-streams.ts` + bundle re-scan. Bundle hash rotated AGAIN — INV-026 `index-D2XXxr_J.js` is gone, current bundle is `https://app.clay.com/assets/index-BS8vlUPJ.js` (8.43 MB). Two routers extracted contiguously at offsets 623100–625900: `lKe = terracottaWorkflowRunStreams` (workspace-scoped CRUD, 6 routes) and `uKe = terracottaStreamWebhook` (root-path ingestion, 2 routes). Confirmed via the client router map at offset ~841857 (`terracottaWorkflowRunStreams:lKe, terracottaStreamWebhook:uKe`). INV-025/026 had guessed the streams router was named `sKe` — that's actually the request body Zod schema for `createWorkflowRunStream`, same trap as INV-025's "Ewe" / actual `Swe`. **Stop guessing router names from neighbouring tokens.**

**Confirmed end-to-end (7 endpoints) + 1 reachable-but-auth-blocked**:

1. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/streams` body `{workflowSnapshotId, streamType:'webhook'|'agent_action'|'workflow_action', name, config, status?='active'}` → `{stream:{id (wfrs_...),workflowId,workflowSnapshotId,streamType,name,createdBy:number|null,config,status,createdAt,updatedAt,deletedAt:null,webhookUrl?:string,referencedTables?:[{tableId,tableName,workbookId|null}]}}`. `webhookUrl` is **only populated when `streamType='webhook'`**. The URL returned is `https://api.clay.com/tc-workflows/streams/{id}/webhook` — note **no `/v3` prefix in the returned URL even though the only path actually routable under cookie auth is `/v3/tc-workflows/streams/{id}/webhook`**. Probably gateway-rewritten under non-cookie auth.
2. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams` query `{limit?, offset?, status?, streamType?}` → `{streams:WorkflowRunStream[], total}`.
3. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` → `{stream}`.
4. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` body `{name?, workflowSnapshotId?, config?, status?}` → `{stream}`. Verified status flip to `'paused'`; once paused, `postWebhook` returns 400 `"Stream is not active"`.
5. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` body `{}` → `{success:true}`. Soft delete (sets `deletedAt`); spawned runs survive.
6. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}/runs` query `{limit?, offset?, status?}` → `{runs:WorkflowRun[], total}` using same `Q_` shape as direct/batch runs. Stream-spawned runs have `streamId` set and `batchId:null`.
7. `POST   /v3/tc-workflows/streams/{streamId}/webhook` body `Record<string,any>` (arbitrary JSON) → 202 `{success:true, workflowRunId, message:"Webhook request accepted and queued for processing"}`. **Root path — no `/workspaces/{ws}` prefix; `streamId` is globally unique.** The body becomes `runState.inputs` verbatim. Errors: 400 `BadRequest` (paused stream / shape errors), 404 `NotFound` (bad streamId), 429 with `retryAfter`.

**Reachable but auth-blocked (1 endpoint)**:

8. `POST   /v3/tc-workflows/streams/{streamId}/webhook/batch` body `{items:[{entityId?:number, backfillId?:string, requestData:object}]}` → expected 202 `{success:true, runs:[{requestId, workflowRunId}], count}`. Returned **403 `{type:'Forbidden', message:'You must be logged in'}`** under session-cookie auth despite the canonical body shape from the bundle. Strong hint that this is the API-key-authed productized inbound webhook channel. Tracked as GAP-036.

**Webhook → run lifecycle observed end-to-end**:

```
t+0.0s  POST /v3/tc-workflows/streams/{id}/webhook  body={"email":"...","company":"Lele"}
        -> 202, workflowRunId returned synchronously
t+0.0s  GET /runs/{wfRunId} -> runStatus:'running'
        runState.inputs == request body verbatim ({email, company})
t+0..6s running
t+7.0s  COMPLETED — runState.status:'completed'
```

Total wall time: ~7 seconds for the same inert 2-node graph that INV-026 measured at ~9.3 s for direct runs. Live ingestion adds no meaningful latency vs direct runs.

**Stream typing**: `streamType` enum is `webhook | agent_action | workflow_action`. Only `webhook` returns a `webhookUrl`. The other two were created cleanly with `config:{}` but expose no externally-pushable surface — likely internal stream types written to from inside the workflow runtime (sub-workflows or agent tools emitting events). Tracked as GAP-037.

**Three invocation primitives now confirmed for tc-workflows**:
- `csv_import` batches (bulk, file-driven, per-row) — INV-024.
- Direct runs (synchronous, single-shot, optional inputs) — INV-026.
- **Webhook streams (live, push-driven, arbitrary JSON payload) — INV-027.**

**Negative probes**:
- `POST /tc-workflows/streams/{id}/webhook` (no `/v3` prefix) → 404 — only the `/v3` form routes under session cookie.
- `POST /v3/tc-workflows/streams/wrs_does_not_exist/webhook` → 404 `"Stream not found"`.
- `POST /v3/tc-workflows/streams/{id}/webhook` against a `paused` stream → 400 `"Stream is not active"`.

**Credit delta**: `basic: 1934.4 → 1934.4`, `actionExecution: 999999999897 → 999999999897`. Zero — same as INV-026, since the underlying execution path is the same default-Claude-Haiku-on-inert-regular-nodes pattern.

**Files updated**: `harness/scripts/verify-workflow-streams.ts` (new), `harness/results/inv-027-streams-1775599180271.json` (new), `harness/results/bundles/index-BS8vlUPJ.js` (new), `investigations/INV-027_workflow-streams.md` (new), `investigations/_index.md`, `registry/endpoints.jsonl` (+8 — 7 confirmed, 1 suspected; replaces the previous single suspected `streams` placeholder), `registry/capabilities.md` (workflow streams section), `registry/gaps.md` (closed GAP-033, opened GAP-036 + GAP-037), `knowledge/internal-v3-api.md` (streams + webhook ingestion section), `architecture/system-design.md` (section 2c — added streams row + live ingestion description), `timeline/2026-04-07_8_inv-027-workflow-streams.md` (new).

---

## 2026-04-07: INV-026 — tc-workflows direct workflow runs (`Swe` router) (GAP-032 closed)

**Source**: `harness/scripts/verify-workflow-direct-runs.ts` + bundle re-scan of the **current** Clay JS bundle. Hash rotated AGAIN — `index-Ba1k0a3-.js` (INV-025) is gone, live bundle is now `https://app.clay.com/assets/index-D2XXxr_J.js` (8.43 MB). Router object `Swe` extracted at offset ~361931. (INV-025 guessed the name was "Ewe"; that was wrong — `Ewe` is the body discriminator for the batches router.)

**Confirmed end-to-end (7 endpoints)**:

1. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/runs` body `{inputs?:object, batchId?:string, standaloneActions?:object}` → `{workflowRun:{id (wfr_...),workflowId,workflowName,workflowSnapshotId (wfs_...),batchId:null,streamId:null,runStatus:'running',runState:{status,currentNodeId,inputs,globalContext,startedAt},maxUninterruptedSteps,createdAt,updatedAt,langsmithTraceHeader?}}`. Server auto-resolves `'latest'` snapshot (explicit `workflowSnapshotId` in body is silently ignored). `standaloneActions` is an object, NOT an array — passing `[]` returns a structured 400.
2. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/runs` query `{limit (default 50), offset (default 0)}` → `{runs:WorkflowRun[], total}`.
3. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/runs/{runId}` → discriminated `{type:'current', workflowRun, workflowRunSteps:[{id (wfrs_...),workflowNodeId,nodeVisitId,isAsync,data:{usage,nodeName,toolName?,reasoning?,toolParams?,systemPrompt,userPrompt,threadContext,executionMetadata},stepInputs,stepOutputs,status,inCurrentStatusSince,startedAt,completedAt,nodeName}], workflowSnapshot}` | `{type:'archived', archivedAgentRun:{id,workflowRunId,logUrl,statusTimings,createdAt}}`.
4. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/runs/{runId}/pause` body `{}` → `{success,runId,status}`. 400 `"Cannot pause workflow run with status 'completed'"` on terminal runs.
5. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/runs/{runId}/unpause` body `{}` → `{success,runId,status}`. 400 on non-paused runs.
6. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/runs/{runId}/steps/{stepId}/continue` body `{humanFeedbackInput: discriminated on 'type' — ApproveToolCall{toolName,approveToolCallForEntireRun} | DenyToolCall{preventFutureToolCallsWithThisTool,toolName,feedback?} | DenyTransition{targetNodeId,feedback?} | ...}` → `{success,stepId,status}`. Verified 404 `"Workflow run step not found"` on fake stepId (route active, stepId validation working). Happy path requires a step in 'waiting' state — deferred to GAP-035.
7. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/steps/waiting` → `{waitingSteps:[{stepId,workflowId,workflowName,runId,nodeName,createdAt,waitingSince,callbackData,stepInputs?,stepOutputs?}]}`. `callbackData` is a discriminated union covering 10 variants including `human_input_tool_decision`, `human_input_transition_decision`, `async_tool_execution`, `max_uninterrupted_steps_reached`, `workflow_run_paused`, `wait_tool_execution`, `code_execution_pending/complete`, `tool_node_execution_pending/complete`.

**Status lifecycle observed**: Empty 2-node graph (regular initial → regular terminal) transitioned `running → completed` in ~9.3s. Two `workflowRunSteps` persisted with full execution telemetry: token usage, system/user prompts, thread context, tool calls, reasoning strings. `runStatus` enum in bundle: `pending|running|paused|completed|failed|waiting`. `runState` discriminated union uses `running|paused|completed|failed` only (narrower subset).

**Negative probes** (returned 404; routes do NOT exist):
- `PATCH /v3/workspaces/{ws}/tc-workflows/{wf}/runs/{runId}` — no direct-run cancel
- `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/runs/{runId}` — no direct-run delete

The `Swe` router is append-only. To cancel a single run you must wrap the invocation in a batch (batches support `PATCH {status:'cancelled'}` per INV-025).

**Surprise finding**: "inert regular nodes" are NOT actually inert. A `regular` node with no `modelId` causes Clay to inject `anthropic:claude-haiku-4-5` plus a ~2KB system prompt plus built-in tools (`memory_search`, transition, `fail_node`). Steps EXECUTE and burn ~12k tokens in the 2-node test. Despite this, the workspace `credits` balance was UNCHANGED on workspace 1080480 (which has `actionExecution: 999999999897`, effectively unlimited). Possible explanations: (a) this dev workspace isn't metered, (b) Clay absorbs default-LLM costs, (c) metering is delayed/batched. Needs re-verification on a normal paid workspace — tracked as GAP-034. INV-025's "credit-safe" claim for inert regular nodes is only confirmed on THIS workspace.

**Credit delta**: `basic: 1934.4 → 1934.4`, `actionExecution: 999999999897 → 999999999897`. Zero.

**Bundle hash reminder**: INV-024 `index--X05HdGb.js`, INV-025 `index-Ba1k0a3-.js`, INV-026 `index-D2XXxr_J.js`. Every session rotates — future agents must re-resolve from `https://app.clay.com/` HTML, never cache.

**Files updated**: INV-026 investigation, `investigations/_index.md`, `harness/scripts/verify-workflow-direct-runs.ts` (new), `harness/results/inv-026-direct-runs-1775596617540.json` (new), `registry/endpoints.jsonl` (+4 confirmed, 3 promoted suspected→confirmed), `registry/gaps.md` (closed GAP-032, opened GAP-034 + GAP-035), `registry/capabilities.md`, `knowledge/internal-v3-api.md`.

## 2026-04-07: INV-025 — tc-workflows step / snapshot CRUD + cancel + cpj_search (GAP-031 closed)

**Source**: `harness/scripts/verify-workflow-steps.ts` + bundle re-scan of the **current** Clay JS bundle. The hash rotated since INV-024 — `index--X05HdGb.js` no longer resolves; the live bundle is now `https://app.clay.com/assets/index-Ba1k0a3-.js` (8.4 MB). Two adjacent ts-rest routers extracted at offset ~668 KB:

- **uYe** — workflow CRUD + snapshot listing
- **mYe** — workflow graph (nodes + edges) with server-side validation

**Confirmed end-to-end (12 endpoints)**:

1. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/graph` → `{nodes, edges, validation:{isValid,errors[],warnings[],suggestions[]}, workflowInputVariables}`. Server-side static analysis is free pre-flight (terminal nodes need outputs, regular nodes need model+prompt, etc.).
2. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/nodes` body `{name<=255, description?, nodeType:'regular'|'code'|'conditional'|'map'|'reduce'|'tool', modelId?, promptVersionId?, position?, isInitial?, isTerminal?}` → `{node:{id (wfn_...), workspaceId, workflowId, name, description, nodeType, tools:[], nodeConfig, subroutineIds:[], position, isInitial, isTerminal, createdAt, updatedAt}}`. Inert `regular` nodes (no model/prompt/tools/inlineScript) are credit-safe scratch resources.
3. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/nodes/{nodeId}` — many optional fields including `source` (discriminated `prompt_version|inline_prompt|input_schema`), `toolIds`, `subroutineIds`, `inlineScript {code,language,inputSchema,outputSchema,packages,allowedToolIds,timeoutMs,shouldIndexStdout}`, `nodeConfig`, `interventionSettings`, `retryConfig`.
4. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/nodes` (batch reposition) body `{updates:[{nodeId,position}]}` → `{nodes[],success}`.
5. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/nodes/{nodeId}` body `{}` → `{success}`.
6. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/nodes` body `{nodeIds[]}` → `{deletedCount,success}`.
7. `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/edges` body `{sourceNodeId, targetNodeId, metadata?:{conditionalSourceHandle?}}` → `{edge:{id (wfe_...), workspaceId, workflowId, sourceNodeId, targetNodeId, metadata, createdAt, updatedAt}}`.
8. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/edges/{edgeId}` body `{}` → `{success}`.
9. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/snapshots` → `{snapshots:[{id (wfs_...), workflowId, content:{nodes,edges,workflow:{id,name,workspaceId,creatorUserId,maxConcurrentBranches},createdAt,containsCycles}, hash (sha256), createdAt, updatedAt}]}`. Server-managed: empty until first batch is created.
10. `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/snapshots/{snapshotId}` → `{snapshot}`. Verified end-to-end against the snapshot auto-created by a `csv_import` batch.
11. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/batches/{batchId}` body `{status?, config?, state?}` → `{batch}`. **Promoted from suspected to confirmed.** PATCH `{status:'cancelled'}` returns 200 with `batch.status='cancelled'`; subsequent GET also returns `'cancelled'`. Must beat the ~430ms auto-fail race for empty workflows.
12. `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}` body `{name?, defaultModelId?, lastRunAt?}` (bundle-confirmed top-level update — was implicit but now in registry).

**Bundle-only (added as `suspected`, 9 entries)**:

- `POST .../nodes/{nodeId}/duplicate` body `{position?}`
- `GET  .../nodes/{nodeId}/code/download` (Python source)
- `PATCH .../edges/{edgeId}` body `{metadata:{handoffConfig?}}`
- `POST /v3/workspaces/{wsId}/tc-workflows/from-snapshot/{snapshotId}` body `{name}`
- `POST .../tc-workflows/{wfId}/restore/{snapshotId}` body `{}`
- `POST /v3/workspaces/{wsId}/tc-workflows/from-preset/{presetId}` body `{name}`
- `POST .../tc-workflows/{wfId}/duplicate` body `{name}`
- `POST/GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs` (Ewe direct-runs router; sibling to batch-based runs; warning: executes steps)
- `POST .../tc-workflows/{wfId}/streams` (sKe streams router)

**Negative result — `cpj_search` is server-stubbed**:

```jsonc
// POST .../batches { workflowSnapshotId:'latest', type:'cpj_search', config:{} }
// 405 Method Not Allowed
{ "type":"MethodNotAllowed",
  "message":"CPJ Search batch type is not yet implemented",
  "details":null }
```

Three shape variants tried — all 405. Cross-checked: the React `CreateBatchModal` disables submit when `type==='cpj_search'` and shows a yellow "coming soon" banner. Discriminator + UI exist; server handler stubbed. Re-probe after future bundle drops.

**Mechanics learned**:

- **Snapshots are server-managed**, not user-controlled. There is no `publishWorkflow` or `createSnapshot` route. Snapshots auto-materialize when `createWorkflowRunBatch` is called with `workflowSnapshotId='latest'`. `content.hash` is sha256 — content-addressed snapshots.
- **Graph validation is a free pre-flight**: enumerated error types include `terminal_node_missing_tool_or_output_schema`; warnings include `missing_model`, `missing_prompt`. Useful as a `validateWorkflow()` helper in the proprietary API layer.
- **Inert nodes are credit-safe**: `regular` nodes with no `modelId`/`promptVersionId`/`toolIds`/`inlineScript` produce zero cost — they're definitions only. This unlocks future investigations of `runs`, `streams`, and `continueWorkflowRunStep` without credit risk.
- **Bundle hashes rotate**. Future investigations must resolve the current bundle filename from `https://app.clay.com/` rather than caching the URL.
- `/v3/workspaces/{wsId}` returns `credits` at the **top level**, not under `workspace.credits`. (Worth fixing wherever previously documented.)

**Credit delta verified zero**: `basic` 1934.4 → 1934.4, `actionExecution` unchanged.

**Cleanup**: nodes wfn_*, edge wfe_*, batch wfrb_*, workflows wf_0td5642Z3YyJ8oMRnw8 + wf_0td5644gqEEH86VmYkP all deleted.

**Files updated**: `harness/scripts/verify-workflow-steps.ts` (new), `harness/results/inv-025-workflow-steps-1775595314008.json` (new), `investigations/INV-025_workflow-steps.md` (new), `investigations/_index.md`, `registry/endpoints.jsonl` (+22 entries; PATCH batches/{id} promoted), `registry/capabilities.md` (new tc-workflows graph/snapshot rows), `registry/gaps.md` (closed GAP-031, opened GAP-032, GAP-033), `knowledge/internal-v3-api.md` (tc-workflows graph + snapshots section).

---

## 2026-04-07: INV-024 — tc-workflows ingestion loop CLOSED (GAP-030)

**Source**: `harness/scripts/verify-workflow-batch-run.ts` + bundle re-scan of `/assets/index--X05HdGb.js` (offsets ~388 KB for the ts-rest router `xwe`, ~4.33 MB for the React `CreateBatchModal` callsite).

**Context**: INV-023 left an open thread — `csv-upload-url` returns an `uploadToken` but the consumer endpoint was untested. This investigation extracts the `xwe` `batches` sub-router from the bundle and exercises the full `csv-upload-url → S3 POST → createWorkflowRunBatch → poll → cleanup` flow against a scratch tc-workflow.

**Confirmed end-to-end**:

1. `POST /v3/workspaces/{ws}/tc-workflows/{wf}/batches` body `{workflowSnapshotId: 'latest', type: 'csv_import', csvUploadToken, config?: object}` → `{batch: {id (wfrb_...), workflowSnapshotId (wfs_...), workflowId, workflowName, status, type, createdBy, config: {csvFile, parameterNames}, state: {lastOffsetProcessed: 0}, createdAt, updatedAt, totalRuns, completedRuns, failedRuns, pendingRuns, runningRuns}}`. Empty body returns `BadRequest{Invalid discriminator value. Expected 'csv_import' | 'cpj_search'}`.
2. `GET /v3/workspaces/{ws}/tc-workflows/{wf}/batches` query `{limit?, offset?, status?}` → `{batches:[...], total}`
3. `GET /v3/workspaces/{ws}/tc-workflows/{wf}/batches/{batchId}` → `{batch}`
4. `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/batches/{batchId}` body `{}` → `{success}`
5. `GET /v3/workspaces/{ws}/tc-workflows/{wf}/batches/{batchId}/runs` query `{limit?, offset?}` → `{runs:[...], total}`

**Bundle-only (added as `suspected`)**:

6. `PATCH /v3/workspaces/{ws}/tc-workflows/{wf}/batches/{batchId}` body `{status?, config?, state?}` → `{batch}` — body shape from `xwe.updateWorkflowRunBatch`, route not exercised at runtime (zero-step batches transition to `failed` in <500ms, hard to PATCH).

**Mechanics**:
- `workflowSnapshotId: 'latest'` is a client convention; server resolves it to a real `wfs_...` snapshot id and returns it on the batch object.
- Server parses the CSV first row and stores it as `config.parameterNames: string[]`. `config.csvFile = {fileSize, filename}` is also reconstructed from the upload metadata.
- `state.lastOffsetProcessed: 0` initialized on creation — likely a cursor for the row processor.
- `BatchStatus` enum: `pending | running | completed | failed | cancelled`.
- `BatchType` enum: `csv_import | cpj_search`. `cpj_search` takes no `csvUploadToken` and is presumably "create batch from a saved Company/People/Jobs search". Untested.
- A batch against a workflow with **zero defined steps** transitions `pending → failed` within ~430ms with `totalRuns=0` and `runs=[]`. This makes empty workflows ideal credit-safe scratch resources for tc-workflows investigations.

**Credits consumed**: 0. The scratch workflow had no enrichment steps, so the executor short-circuited.

**Cleanup**: scratch batch + scratch workflow both deleted. Zero residue.

**New gap opened**: GAP-031 — workflow step/snapshot CRUD (required to make programmatic batches actually do enrichment work).

## 2026-04-07: INV-023 — Suspected upload-URL endpoints PROMOTED to confirmed

**Source**: `harness/scripts/verify-suspected-upload-endpoints.ts` + bundle re-scan of `/assets/index--X05HdGb.js`.

**Context**: INV-021 surfaced two upload-URL endpoints from the frontend bundle but never exercised them. Both used an S3 POST policy variant (distinct from the multipart PUT pattern confirmed by INV-021). This investigation promoted them to `confirmed` and fixed an incorrect `fields: Array<string>` shape in the registry (it's actually an object with keys `bucket`, `key`, `Policy`, `X-Amz-*`).

**Confirmed end-to-end (all 204 on S3)**:

1. `POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url` body `{filename, fileSize}` → `{uploadUrl, fields: {bucket, key, Policy, X-Amz-*}, uploadToken}`. Targets `clay-base-import-prod` S3 bucket. `uploadToken` is a server-generated UUID intended for a subsequent `createWorkflowRunBatch` call (still untested — next step).
2. `POST /v3/documents/{wsId}/upload-url` body `{name, folderId?, context?="agent_playground"}` → `{documentId, uploadUrl, fields}`. Targets `file-drop-prod` bucket. Paired with `POST /v3/documents/{wsId}/{documentId}/confirm-upload` (empty body) which returns the full document record.

**Five additional endpoints confirmed in passing** while setting up/cleaning up the scratch workflow and document:

- `GET /v3/workspaces/{wsId}/tc-workflows` → `{workflows: [...]}`
- `POST /v3/workspaces/{wsId}/tc-workflows` `{name, defaultModelId?}` → `{workflow}`
- `DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}` (body `{}` required) → `{success}`
- `POST /v3/documents/{wsId}/{documentId}/confirm-upload` → full document record
- `DELETE /v3/documents/{wsId}/{documentId}?hard=true` → `{success}`

**Key mechanics of the POST policy flow (applies to both upload endpoints)**:
- Caller does `multipart/form-data POST` directly to S3 with ALL form fields appended first and `file` last (order matters for S3 POST policies).
- Do NOT override `Content-Type` — let `FormData` set the correct multipart boundary.
- S3 returns `204 No Content` on success (not 200, unlike the PUT multipart flow).
- Single-shot — no `/complete` step, capped at S3's 5 GB POST limit.

**Bucket routing insight**: Both POST-policy endpoints target the SAME two S3 buckets as `/v3/imports/{ws}/multi-part-upload` (`clay-base-import-prod` and `file-drop-prod`). Clay has two ingress mechanisms fronting the same buckets — multipart PUT (up to 15 GB) vs POST policy (up to 5 GB, simpler flow).

**Structured BadRequest schema**: All verified endpoints return a consistent `{type: "BadRequest", message, details: {pathParameterErrors, headerErrors, queryParameterErrors, bodyErrors}}` on missing fields. Useful pattern for future scripts to distinguish "route exists, body wrong" (400 with this shape) from "route doesn't exist" (404).

**Cleanup**: scratch workflow deleted, both test documents hard-deleted. Zero residue.

## 2026-04-07: INV-021 — CSV upload origin RESOLVED (GAP-027)

**Source**: `harness/scripts/investigate-csv-upload-origin.ts` + `harness/scripts/verify-multipart-upload.ts`

**Question**: Where does Clay's UI upload CSV files? INV-020 confirmed `POST /v3/imports` consumes an existing S3 key but couldn't find the upload origin (17 `/v3/*` candidates → 404).

**Answer**: The upload origin IS in `/v3` — INV-020 missed it because the path-param shape uses **workspaceId**, not importId. Two new confirmed endpoints:

1. `POST /v3/imports/{workspaceId}/multi-part-upload` body `{filename, fileSize, toS3CSVImportBucket}` → `{uploadId, s3Key, uploadUrls: [{url, partNumber}]}` — initiates an S3 multipart upload, returns presigned PUT URLs.
2. `POST /v3/imports/{workspaceId}/multi-part-upload/complete` body `{s3key, uploadId, etags, toS3CSVImportBucket}` → `{}` — finalizes the multipart upload.

**Full sequence verified end-to-end with a 55-byte CSV**: init → S3 PUT (Content-Type: application/octet-stream, capture ETag) → complete → POST /v3/imports with returned `s3Key`. POST /v3/imports returned 200 with `state.totalSizeBytes: 55` — confirming the freshly uploaded key is consumable.

**Discovery method**: Phase 1 HTTP probing (60+ non-`/v3` paths on api.clay.com + 9 alternate hosts) returned ZERO hits — conclusively ruling out non-v3 origins. The bundle scan of `app.clay.com/assets/index--X05HdGb.js` found the `lgt`/`ugt` axios wrappers and the `ch` axios client's `baseURL: https://api.clay.com/v3`. Phase 2 (Playwright) was unnecessary.

**Two destination buckets**:
- `clay-base-import-prod.s3.us-east-1.amazonaws.com` — `toS3CSVImportBucket: true` (CSV imports, consumable by POST /v3/imports)
- `file-drop-prod.s3.us-east-1.amazonaws.com` — `toS3CSVImportBucket: false` (general file drop)

**Footguns documented**:
- `/complete` request key is `s3key` (lowercase k), but init response returns `s3Key` (camelCase).
- ETags must be unwrapped from S3's surrounding double-quotes before sending to `/complete`.
- Bundle splits files into 50 MB parts with concurrency 5 for uploads; max file size constant is 15 GB.

**Bonus**: Bundle also revealed two `suspected` (not exercised) upload-URL endpoints that use a different pattern (S3 POST policy):
- `POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url` (Workflows team)
- `POST /v3/documents/{wsId}/upload-url` (Documents feature)

**Implications**: Full programmatic CSV ingestion is now possible without the UI or `/v3/tables/{id}/records` workaround. The proprietary API layer can take a raw file from a user, run the 4-step flow, and land rows in any Clay table. Updates: `endpoints.jsonl` (+4), `capabilities.md` (CSV upload now confirmed), `gaps.md` (GAP-027 resolved), `knowledge/internal-v3-api.md` (multipart upload section), `investigations/INV-021_csv-upload-origin.md` (full writeup).

---

## 2026-04-07: INV-022 — Source scheduling RESOLVED NEGATIVE (TODO-028)

**Source**: `harness/scripts/investigate-source-scheduling.ts`

**Question**: Do schedule fields on `tableSettings` / source `typeSettings` actually drive scheduled runs?

**Answer**: **No**. Scheduling is UI-only / scheduler-internal. There is no v3 REST surface for it.

**Findings**:

1. **`tableSettings` accepts and PERSISTS every schedule-shaped key** via merge semantics — `schedule` (object), `cronExpression` (5-field, 6-field, `@hourly`, `@daily` all stored as opaque strings), `scheduleEnabled`, `nextRunAt`, `lastRunAt`, `scheduleStatus`, `runFrequency`, `runFrequencyConfig`. **None of them have any backend effect.** Values like `nextRunAt: "2030-01-01..."` round-trip unchanged — nothing on the server is computing them.
2. **`HAS_SCHEDULED_RUNS` is server-controlled.** PATCH set it to `true`, server overrode back to `false`. Only schedule-related key the backend manages itself.
3. **Top-level (non-`tableSettings`) PATCH fields are silently dropped.** `PATCH /v3/tables/{id}` with top-level `cronExpression` or `schedule` returns 200 but the keys never appear on read-back.
4. **Source `typeSettings` is validated, unlike `tableSettings`.** PATCH with any schedule key into `typeSettings` returns **500 InternalServerError**. Top-level PATCH on a source with schedule keys returns 200 but persists nothing — sources do not store schedule state at all.
5. **Existing `trigger-source` production sources** carry no cron/schedule/frequency/nextRun fields anywhere on the source object — only `signalType`, `triggerDefinitionId`, `actionSourceSettings`. Whatever drives recurring trigger evaluation lives outside the REST surface.
6. **16 additional candidate scheduling endpoints probed, all 404**: `/v3/tables/{id}/schedule`, `/v3/tables/{id}/schedules`, `/v3/tables/{id}/scheduled-runs`, `/v3/tables/{id}/runs`, `/v3/sources/{id}/schedule`, `/v3/sources/{id}/next-run`, `/v3/workspaces/{id}/scheduled-runs`, `/v3/workspaces/{id}/scheduled-tables`, `/v3/scheduled-runs`, `/v3/scheduled-tables`, `/v3/triggers`, `/v3/jobs`, `/v3/recurring-jobs`, plus POST variants of the schedule paths.

**Implications**: For "automated data refresh" (the original P1 motivation), the only API-accessible path today is to run our own cron and call `PATCH /v3/tables/{id}/run`. No new endpoints. Updating `gaps.md` (GAP-028 resolved-negative), `capabilities.md` (new "Scheduling" section, both rows = NOT AVAILABLE), `knowledge/internal-v3-api.md` (tableSettings schedule keys = scratch space), `todo/README.md` (TODO-028 resolved). TODO-028 file deleted.

---

## 2026-04-07: INV-020 — POST /v3/imports unlocked (TODO-024)

**Source**: 4 iterative harness scripts (`investigate-import-creation*.ts`)

**Breakthroughs**:

1. **`POST /v3/imports` confirmed working** with the following payload shape:
   ```json
   {
     "workspaceId": <num>,
     "config": {
       "map": {"<fieldId>": "{{\"CSV Header\"}}"},
       "source": {
         "key": "<userId>/<filename>.csv",
         "type": "S3_CSV",
         "filename": "<filename>.csv",
         "hasHeader": true,
         "recordKeys": ["<header>", ...],
         "uploadMode": "import",
         "fieldDelimiter": ","
       },
       "destination": {"type": "TABLE", "tableId": "t_xxx"},
       "isImportWithoutRun": true
     }
   }
   ```
   Returns 200 with `{id: "ij_xxx", state: {status: "INITIALIZED"}}`. Executes
   **synchronously** — by the next poll the state is `FINISHED` with
   `numRowsSoFar=49` for our test file. Verified end-to-end: rows landed in the
   destination table and were readable via the records endpoint.

2. **`GET /v3/imports/{importId}`** confirmed for status polling. Returns the
   full import record including `state.status`, `numRowsSoFar`, `totalSizeBytes`.

3. **`destination.type`** accepts `TABLE` and `NOOP` (observed in history).

4. **`isImportWithoutRun: true`** prevents enrichment auto-trigger — important
   for credit control.

5. **No CSV upload endpoint exists in `/v3`**. Probed 17 candidate paths
   (`/v3/files`, `/v3/uploads`, `/v3/imports/upload`, `/v3/imports/{id}/upload`,
   `/v3/storage/presign`, etc.) — all 404. The S3 key has to come from a
   non-`/v3` route. Captured as new GAP-027.

6. **Error fingerprints documented** — `Must specify workspaceId` (empty body),
   `Bad source config: Could not locate file with key X` (non-existent S3 key),
   `Could not find source with type INLINE_CSV` (only `S3_CSV` is fully wired up).

**Files updated**:
- `investigations/INV-020_import-job-creation.md` (new)
- `registry/endpoints.jsonl` — `POST /v3/imports` promoted from `untested` to `confirmed` with full schema; `GET /v3/imports/{importId}` added
- `registry/capabilities.md` — added "Create import job", "Get import status", "CSV upload" rows
- `registry/gaps.md` — GAP-020 marked import side resolved; new GAP-027 (CSV upload endpoint location)
- `todo/README.md` — TODO-024 marked resolved
- `knowledge/internal-v3-api.md` — import section expanded
- `harness/scripts/investigate-import-creation{,-2,-3,-4}.ts` (new probe scripts)

---

## 2026-04-06: Session 4 — Gap Discovery & Programmatic Investigation (INV-013 through INV-017)

**Source**: 5 parallel investigation scripts probing 100+ endpoint/parameter combinations

**Breakthroughs**:

1. **Table duplication** (INV-016): `POST /v3/tables/{id}/duplicate` → confirmed working. Also `POST /v3/tables` with `sourceTableId` or `duplicateFromTableId`. Workbook duplication also works: `POST /v3/workbooks/{id}/duplicate`.

2. **View CRUD** (INV-015): `POST /v3/tables/{id}/views` creates views. `PATCH /v3/tables/{id}/views/{viewId}` renames them. Filter/sort update payload needs refinement (returns 200 but doesn't persist).

3. **Enrichment cell metadata** (INV-013): Full state machine documented from existing tables. `metadata.status` values: `SUCCESS`, `ERROR_OUT_OF_CREDITS`, `ERROR_BAD_REQUEST`. Stale cells: `{isStale: true, staleReason: "TABLE_AUTO_RUN_OFF"}`. `recordMetadata.runHistory`: per-field `[{time, runId}]`.

4. **Pagination** (INV-014): No cursor/page/offset mechanism. All params silently ignored. `limit=10000` returns all 160 rows (39ms). Default limit=100.

5. **Formula auto-evaluation** (INV-017): Formulas auto-evaluate on insert and auto-re-evaluate on update. No trigger needed.

6. **CSV export** (INV-017): `POST /v3/tables/{id}/export` creates async job (`ej_xxx`, status: ACTIVE).

7. **Workbook creation** (INV-016): `POST /v3/workbooks` confirmed. 42 workbooks in workspace.

**Negative results**: Table history/restore/runs/jobs/stats all 404. Row sorting query params all ignored. Credit-specific endpoints all 404. Individual workbook GET/PATCH/DELETE all 404.

**TODOs resolved**: 17 of 19 (89%). Only TODO-007 (WebSocket/SSE) and TODO-010 (view filter/sort payload) remain open.

**New endpoints confirmed**: 8 (table duplicate, view create, view update, workbook duplicate, workbook create, table export, plus `sourceTableId`/`duplicateFromTableId` params on table create)

**Registry**: Grew from 49 to 57 entries.

---

## 2026-04-06: INV-012 — v3 Row READING Endpoint DISCOVERED

**Source**: Systematic API probing of 25+ URL patterns to find how Clay reads table data

**Critical Finding**: Row reading requires a **view ID** — there is no view-less GET endpoint for records.

**Two confirmed read endpoints**:

1. **`GET /v3/tables/{tableId}/views/{viewId}/records`** — List rows through a view
   - Returns `{results: Record[]}` with full cell data, metadata, timestamps
   - `limit` query param works (controls result count)
   - `offset` query param is accepted but **silently ignored** (always returns from start)
   - No pagination metadata in response (no hasMore, total, nextCursor)
   - View-level filtering is applied server-side (e.g., "Fully enriched rows" view returns 0 for unenriched table, "All rows" returns everything)
   - Confirmed on 2 tables (Experts: 79 rows, Creators: 49 rows)

2. **`GET /v3/tables/{tableId}/records/{recordId}`** — Single record by ID
   - Returns full record object (same shape as list items)
   - 404 with `"Record {id} was not found"` for invalid IDs
   - Route pattern means any sub-path (e.g., `/records/count`) is treated as a record ID lookup

**View IDs**: Come from `GET /v3/tables/{tableId}` → `table.views[]` array. Each view has `id` (gv_xxx), `name`, `filter`, `sort`, `limit`, `offset` fields.

**What was tested and returned 404**:
- `GET /v3/tables/{id}/records` (no view) — 404
- `GET /v3/tables/{id}/rows` — 404
- `GET /v3/tables/{id}/data` — 404
- `GET /v3/records?tableId=` — 404
- `POST /v3/tables/{id}/query` — 404
- `POST /v3/records/query` — 404
- `GET /v3/views/{viewId}/records` — 404
- `GET /v3/grid-views/{viewId}` — 404
- `GET /v3/grid-views/{viewId}/records` — 404
- `POST /v3/views/{viewId}/records/query` — 404
- `POST /graphql` — 404
- `POST /v3/graphql` — 404

**Trap discovered**: `POST /v3/tables/{id}/records/{anything}` creates a new record with `id` set to `{anything}`. The POST create endpoint interprets the last path segment as a custom record ID. During probing, "query", "search", "list", "fetch", "batch" all created junk rows (cleaned up via DELETE).

**Record shape**:
```json
{
  "id": "r_xxx",
  "tableId": "t_xxx",
  "cells": { "f_fieldId": { "value": "...", "metadata": { "status": "SUCCESS" } } },
  "recordMetadata": { "runHistory": {...}, "preprocessingMarkerMax": {...} },
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "deletedBy": null,
  "dedupeValue": null
}
```

**Impact**: v3 row CRUD is now **100% complete** — Create (POST), Read (GET via view), Update (PATCH), Delete (DELETE).

**Gaps resolved**: GAP-025
**Endpoints added**: 2 (view-based list + single record GET)

## 2026-04-06: INV-011 — v1 API DEPRECATED + v3 Records Endpoint

**Source**: Agent integration test failure led to systematic v1 endpoint testing

**Critical Finding**: The entire v1 API is deprecated and non-functional:
- `api.clay.com/api/v1/*` — routes not registered (Express HTML 404)
- `api.clay.run/v1/*` — returns `{"success":false,"message":"deprecated API endpoint"}`
- All auth methods tested (Bearer, x-api-key, session cookie) — all 404

**Breakthrough**: `POST /v3/tables/{id}/records` exists for row creation:
- Format: `{records: [{cells: {f_fieldId: "value"}}]}`
- Returns created records with IDs, timestamps
- `PATCH /v3/tables/{id}/records` updates rows (async, enqueued)
- `DELETE /v3/tables/{id}/records` deletes rows (`{recordIds: [...]}`)
- `GET /v3/tables/{id}/records` does NOT exist (404)

**Also confirmed**: Webhook row insertion works — POST to `state.url` returns 200.

**Impact**: All v1 tools in backend (`clay_read_rows`, `clay_write_rows`, `clay_trigger_enrichment`) are broken and need migration to v3.

## 2026-04-06: INV-010 Deep Dive — authAccountId BREAKTHROUGH

**Source**: Creative endpoint probing after systematically exhausting obvious paths

**The Discovery**: `GET /v3/app-accounts` returns ALL 111 auth accounts with their IDs, provider types, and ownership.

The key that unlocked it: when creating an enrichment column with a dummy `authAccountId`, the error said `"App Account not found"`. This told us the entity is called "App Account" — and `/v3/app-accounts` was the path. Previous probes tried `auth-accounts`, `authAccounts`, `connected-accounts` but never `app-accounts`.

**What this means**: The agent can now fully automate enrichment column creation end-to-end:
1. `GET /v3/actions?workspaceId=` → find the enrichment action + its `auth.providerType`
2. `GET /v3/app-accounts` → find the account where `appAccountTypeId` matches the provider
3. `POST /v3/tables/{id}/fields` → create the column with the correct `authAccountId`

**Also discovered**: Action column creation also requires `actionPackageId` (the `package.id` from the actions catalog), not just `actionKey`.

**Gaps resolved**: GAP-004 (FULLY), GAP-022 (superseded)

## 2026-04-06: INV-009 Reach Goals (Session 3)

**Source**: Authenticated probing — webhook creation, enrichment trigger, table type comparison, credit monitoring

**Discoveries**:

1. **Webhook URL is in `state.url`** (GAP-010 RESOLVED)
   - `POST /v3/sources` with `type: "webhook"` → response includes `state.url: "https://api.clay.com/v3/sources/webhook/{uuid}"`
   - URL is stable UUID. Immediately readable after creation.
   - `DELETE /v3/sources/{id}` returns `{success: true}` (GAP-024 RESOLVED)

2. **`runRecords: {recordIds: string[]}` confirmed** (GAP-021 RESOLVED)
   - `{recordIds: []}` → `runMode: "INDIVIDUAL"` (correct key)
   - `{}`, `{all: true}`, `{allRecords: true}` → `runMode: "NONE"` (wrong keys)

3. **Table types are functionally identical** (GAP-018 RESOLVED)
   - `spreadsheet` and `company` both start with 2 fields (Created At, Updated At) and 5 views
   - Type only affects UI onboarding, not API schema

4. **Credit monitoring works in real time** (GAP-023 RESOLVED)
   - `credits: {basic: 574, actionExecution: 9553}` / `creditBudgets: {basic: 2000, actionExecution: 10000}`

5. **50 rapid requests: 0 rate-limited** — rate limits are effectively non-existent

6. **CORRECTED: `/v3/tables/recent`, `/v3/tables/list`, etc. are NOT endpoints**
   - INV-006 reported these as "exists (401)" but they were false positives
   - Authenticated test shows 404: "Table recent does not exist" — treated as table IDs
   - Only valid table listing is `/v3/workspaces/{id}/tables`
   - Same for `/v3/imports/csv`, `/v3/imports/webhook` — these are import job ID lookups, not separate endpoints

**Gaps resolved**: GAP-010, GAP-018, GAP-021, GAP-023, GAP-024
**Registry corrections**: 6 endpoints downgraded from untested → not-endpoint (false positive 401s)

## 2026-04-06: INV-008 Boundary Exploration (Session 2)

**Source**: Authenticated probing of 30+ v3 endpoints using session cookie from INV-007

**Discoveries**:

1. **Session cookie auto-refreshes** (GAP-003 RESOLVED)
   - `set-cookie` header in every response pushes expiry forward by 7 days
   - Cookie never expires as long as any v3 endpoint is hit weekly
   - Eliminates need for complex refresh logic

2. **No rate limiting detected** (GAP-005 RESOLVED)
   - 20 rapid-fire requests: 0 rate-limited, avg 21ms, no rate-limit headers
   - 150ms Claymate baseline was a courtesy delay, not a requirement

3. **v3 has NO row endpoints** (GAP-011 RESOLVED NEGATIVE)
   - GET/POST `/v3/tables/{id}/rows` → 404
   - v1 API is the only path for row CRUD

4. **Source CRUD fully operational** — GET, PATCH confirmed with full response shapes
   - `GET /v3/sources?workspaceId=` lists all sources (use query param, not /sources/list)
   - `GET /v3/sources/{id}` returns sourceSubscriptions (table/field linkage)
   - `PATCH /v3/sources/{id}` works (empty body = no-op)

5. **Table rename confirmed** — `PATCH /v3/tables/{id}` with `{name}` returns full table object

6. **Workspace detail returns billing/credits** — `GET /v3/workspaces/{id}` includes billingPlanType, credits, creditBudgets, featureFlags, abilities

7. **Actions catalog: 1,191 actions, 170+ providers** — full I/O schemas, rate limits, enablement info
   - Auth block only has `{providerType}` — no authAccountId (that's per-column only)
   - All auth-account enumeration paths 404'd

8. **Import history accessible** — `GET /v3/imports?workspaceId=` returns 26 records with column mappings

9. **Enrichment trigger `runRecords` is an OBJECT** — not a string. Corrected in registry.

10. **`X-Clay-Frontend-Version` header confirmed optional** — all probes succeeded without it

11. **CSV export is async** — `GET /v3/exports/csv?tableId=` returns 404 "job not found", likely needs POST to create job first

12. **`GET /v3/workspaces` (list all) requires admin** — 403 for regular users

**Gaps resolved**: GAP-003, GAP-005, GAP-011, GAP-017 (mostly)
**Gaps partially resolved**: GAP-004 (negative — no auth-account endpoint), GAP-020 (import works, export unclear)
**New gaps added**: GAP-021 (runRecords format), GAP-022 (authAccountId extraction), GAP-023 (credit monitoring), GAP-024 (source delete)
**Endpoint registry**: 10 endpoints upgraded from untested → confirmed with full response shapes

## 2026-04-05: Initial Research Sprint

**Source**: Conversation analysis + Claymate Lite source code reverse-engineering + Clay University docs + web research

**Discoveries**:

1. **Clay internal v3 API confirmed** (`api.clay.com/v3`)
   - Reverse-engineered from Claymate Lite `content.js` (984 lines)
   - 4 endpoints confirmed: table read, field create, source read, source create
   - Authentication: browser session cookies + `X-Clay-Frontend-Version` header
   - Added 4 v3 entries to endpoints.jsonl

2. **Clay official v1 API documented**
   - 5 endpoints cataloged: table metadata, row read/write, enrichment trigger, sources list
   - API key auth (Bearer token)
   - Added 5 v1 entries to endpoints.jsonl

3. **Claymate Lite fully analyzed**
   - Schema format documented (version 1.0, columns array with typeSettings)
   - Field reference system mapped: `{{f_xxx}}` internal, `{{@Column Name}}` portable
   - Dependency resolution algorithm documented (topological sort)
   - Source column two-step creation process documented
   - 150ms inter-call delay noted

4. **Product disambiguation documented**
   - Clay GTM (clay.com) vs Clay Personal CRM (clay.earth)
   - `@clayhq/clay-mcp` is for personal CRM, NOT GTM
   - `clay-mcp-bridge` (bleed-ai) referenced but no public artifact found

5. **16 research gaps identified and prioritized**
   - 3 P0 gaps (endpoint catalog, table lifecycle, session durability)
   - 7 P1 gaps (enrichment config, rate limits, table listing, column CRUD, workbooks, pagination, webhook URLs)
   - 6 P2 gaps (row v3, formula triggers, error states, version header, WebSockets, bulk ops)

6. **Architecture designed**
   - Four-layer access stack (v1 API, v3 bridge, Playwright, CDP)
   - Session management lifecycle
   - 11 new agent tools specified
   - Integration plan with main codebase
   - Risk assessment with mitigation strategies

**Files created**: 8 knowledge docs, 5 architecture docs, 4 registry files, 5 harness prompts, 4 harness scripts, 6 investigation stubs

## 2026-04-05: INV-006 Unauthenticated Endpoint Enumeration

**Source**: Systematic HTTP probing of `api.clay.com/v3/*` using 401/404 differentiation and Zod validation error mining

**Method**: Send requests to every plausible v3 path. 401 = endpoint exists (needs auth). 404 = doesn't exist. 400 = exists AND reveals required parameters via Zod validation errors. Iteratively build payloads by fixing one validation error at a time.

**Discoveries**:

1. **`GET /v3` is publicly accessible** (no auth) — returns:
   - Current frontend version: `v20260403_221301Z_9894a0108e`
   - CASL-style auth abilities structure
   - Can be polled to detect deployments

2. **`POST /v3/tables` — TABLE CREATION CONFIRMED** (GAP-002 RESOLVED)
   - Payload: `{workspaceId: number, type: "spreadsheet"|"company"|"people"|"jobs", name?: string}`
   - Table types enumerated via validation error: must be one of [spreadsheet, company, people, jobs]

3. **`DELETE /v3/tables/{tableId}` and `PATCH /v3/tables/{tableId}` — TABLE DELETE/UPDATE CONFIRMED**

4. **`PATCH /v3/tables/{tableId}/run` — ENRICHMENT TRIGGER CONFIRMED**
   - Payload: `{runRecords: {recordIds: string[]}, fieldIds: string[], forceRun: boolean, callerName?: string}`
   - Zod validation revealed full schema

5. **Column CRUD completed** (GAP-007 RESOLVED)
   - `PATCH /v3/tables/{tableId}/fields/{fieldId}` — update
   - `DELETE /v3/tables/{tableId}/fields/{fieldId}` — delete
   - `PUT` does NOT exist (404)

6. **Table listing endpoints discovered** (GAP-006 RESOLVED)
   - `/v3/tables/recent`, `/v3/tables/list`, `/v3/tables/search`, `/v3/tables/all`
   - `/v3/workspaces/{id}/tables`

7. **Source CRUD completed**
   - `PATCH /v3/sources/{sourceId}` — update
   - `DELETE /v3/sources/{sourceId}` — delete
   - `GET /v3/sources/list` — listing

8. **Import/Export endpoints discovered**
   - `/v3/imports/csv`, `/v3/imports/webhook`
   - `/v3/exports/csv`, `/v3/exports/download`

9. **Actions endpoint discovered**
   - `GET /v3/actions?workspaceId=` — list actions
   - `POST /v3/actions` — create action package: `{workspaceId, actionPackageId, actionPackageDefinition: string}`

10. **Workbook CRUD confirmed NOT available** (GAP-008 RESOLVED NEGATIVE)
    - `/v3/workbooks` → 404

11. **v1 and v2 deprecated** — `/v1` and `/v2` both return `{"success":false,"message":"deprecated API endpoint"}`

12. **v1 has no collection endpoints** — `/api/v1/tables`, `/api/v1/sources`, `/api/v1/workspaces` all 404. Only table-specific paths work.

**Endpoint registry**: Grew from 9 to 37 entries
**Gaps resolved**: GAP-002, GAP-006, GAP-007, GAP-008
**New gaps added**: GAP-017 (response shapes), GAP-018 (table types), GAP-019 (action definition format), GAP-020 (import/export mechanics)
