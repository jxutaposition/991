# INV-027: tc-workflows streams (`lKe` router) + webhook ingestion (`uKe` router)

**Status**: completed
**Priority**: P2
**Gap**: GAP-033 — tc-workflows streams + webhook batch
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

INV-026 closed the direct-runs router (`Swe`) and noted a sibling router
under tc-workflows for **streams** + webhook-driven ingestion. INV-025's
guess was that this would be the live equivalent of the `csv_import`
batches flow — instead of uploading CSVs you register a stream, get a
URL, and let external systems POST events into it. Goal: catalog the
endpoints, verify webhook → run end-to-end, observe lifecycle.

## Method

### 1. Bundle scan

Bundle hash rotated AGAIN. INV-026 `index-D2XXxr_J.js` →
**`index-BS8vlUPJ.js`** (8.43 MB), resolved from `https://app.clay.com/`
HTML. Two routers found contiguously at offsets 623100–625900:

- `lKe = terracottaWorkflowRunStreams` — workspace-scoped stream CRUD,
  exported as `terracottaWorkflowRunStreams:lKe` in the client router map
  (offset ~841857).
- `uKe = terracottaStreamWebhook` — root-path webhook ingestion,
  exported as `terracottaStreamWebhook:uKe` (offset ~841885).

INV-025 had guessed the router name as `sKe`. The actual router object
is `lKe`; `sKe` is the request-body Zod schema for `createWorkflowRunStream`
(`{workflowSnapshotId, streamType, name, config, status?}`). Same pattern
as INV-026, where the guessed `Ewe` turned out to be the batches body
discriminator and the real router was `Swe`. **Stop guessing router
names from neighbouring tokens.**

### 2. Routes extracted

`lKe` (6 routes, all session-cookie auth):

| Operation | Method | Path |
|---|---|---|
| `createWorkflowRunStream` | POST | `/v3/workspaces/:ws/tc-workflows/:wf/streams` |
| `getWorkflowRunStreams` | GET | `/v3/workspaces/:ws/tc-workflows/:wf/streams?limit&offset&status&streamType` |
| `getWorkflowRunStream` | GET | `/v3/workspaces/:ws/tc-workflows/:wf/streams/:streamId` |
| `updateWorkflowRunStream` | PATCH | `/v3/workspaces/:ws/tc-workflows/:wf/streams/:streamId` |
| `deleteWorkflowRunStream` | DELETE | `/v3/workspaces/:ws/tc-workflows/:wf/streams/:streamId` |
| `getWorkflowRunStreamRuns` | GET | `/v3/workspaces/:ws/tc-workflows/:wf/streams/:streamId/runs?limit&offset&status` |

`uKe` (2 routes, **root-path** — no `/workspaces/:ws/` prefix; the
streamId is globally unique and scopes the request itself):

| Operation | Method | Path |
|---|---|---|
| `postWebhook` | POST | `/v3/tc-workflows/streams/:streamId/webhook` |
| `postWebhookBatch` | POST | `/v3/tc-workflows/streams/:streamId/webhook/batch` |

### 3. Schemas (from bundle)

```ts
streamType = 'webhook' | 'agent_action' | 'workflow_action'   // oKe
streamStatus = 'active' | 'paused' | 'disabled'                // BS

WorkflowRunStream = {                                          // VS
  id: string,                       // wfrs_...
  workflowId: string,
  workflowSnapshotId: string,
  streamType,
  name: string,
  createdBy: number | null,
  config: any | null,               // free-form per streamType
  status: streamStatus,
  createdAt, updatedAt: ISO,
  deletedAt: ISO | null,
  webhookUrl?: string,              // ONLY populated for streamType='webhook'
  referencedTables?: [{tableId, tableName, workbookId|null}],
}

createWorkflowRunStream body =                                 // sKe
  { workflowSnapshotId, streamType, name, config, status?='active' }

updateWorkflowRunStream body =                                 // cKe
  { name?, workflowSnapshotId?, config?, status? }

postWebhook body = Record<string, any>                         // arbitrary JSON
postWebhook 202 = { success: true, workflowRunId, message }
postWebhook errors: 400|404|429 (each `{error, message}`, 429 adds `retryAfter`)

postWebhookBatch body = { items: [{entityId?, backfillId?, requestData: object}] }
postWebhookBatch 202 = { success: true, runs: [{requestId, workflowRunId}], count }
```

For `streamType='webhook'`, observed `config` shapes:

- `{}` — accepted, stream created, ingestion works.
- `{ inputSchema: {type:'object', properties:{...}}, webhook: {requiresAuth: false} }` —
  accepted. The `inputSchema` and `webhook.requiresAuth` shapes match the
  `iKe`/`aKe` Zod schemas defined two lines above the streams router in
  the bundle, suggesting Clay reuses the legacy webhook-source config
  shape for tc-workflow streams.

### 4. Verification script

`harness/scripts/verify-workflow-streams.ts`:

1. Create scratch tc-workflow with inert 2-node graph (INV-026 pattern).
2. Trigger snapshot materialization via a no-op direct run, harvest
   `wfs_*` snapshotId.
3. List streams (empty).
4. Create 5 streams: 3 `webhook` (varied configs), 1 `agent_action`,
   1 `workflow_action`.
5. List streams (populated), GET single stream.
6. List stream runs (empty).
7. POST `/v3/tc-workflows/streams/{streamId}/webhook` with arbitrary
   payload `{email, company}`.
8. Probe non-`/v3` path `/tc-workflows/streams/{id}/webhook` (negative).
9. POST `/v3/tc-workflows/streams/{id}/webhook/batch` with 2 items.
10. Poll `streams/{id}/runs` and `tc-workflows/{wf}/runs` for the new run.
11. Poll `runs/{runId}` until `runStatus='completed'`.
12. PATCH stream `{status:'paused'}`, then re-POST webhook (negative).
13. POST webhook to fake streamId (negative).
14. Cleanup all streams + nodes + edges + workflow.
15. Credit delta before/after via `GET /v3/workspaces/{wsId}.credits`.

Result file: `harness/results/inv-027-streams-1775599180271.json`.

## Findings

### All 6 lKe routes work end-to-end

| Endpoint | Result |
|---|---|
| POST `/streams` `{workflowSnapshotId, streamType:'webhook', name, config:{}}` | 200, returns `{stream}` with `id`, `webhookUrl` |
| POST `/streams` with `streamType:'webhook'` + `config:{inputSchema, webhook:{requiresAuth:false}}` | 200 |
| POST `/streams` with `streamType:'agent_action'` | 200, **no `webhookUrl`** |
| POST `/streams` with `streamType:'workflow_action'` | 200, **no `webhookUrl`** |
| GET `/streams` | 200 — `{streams:[VS], total}` |
| GET `/streams/{id}` | 200 — `{stream:VS}` |
| PATCH `/streams/{id}` `{status:'paused'}` | 200 |
| DELETE `/streams/{id}` | 200 — `{success:true}` (soft delete; sets `deletedAt`) |
| GET `/streams/{id}/runs` | 200 — `{runs:[Q_], total}` (uses same `Q_` shape as direct runs) |

### postWebhook (uKe) works end-to-end via session cookie

```
POST /v3/tc-workflows/streams/wfrs_.../webhook
body: {"email":"inv027@example.com","company":"Lele"}

202 Accepted
{"success":true,"workflowRunId":"wfr_...","message":"Webhook request accepted and queued for processing"}
```

The arbitrary JSON body becomes `runState.inputs` on the resulting
workflow run **with no wrapping or transformation**:

```json
"runState": {
  "status": "running",
  "currentNodeId": "wfn_...",
  "inputs": { "email": "inv027@example.com", "company": "Lele" },
  "globalContext": {},
  "startedAt": "2026-04-07T21:59:47.872Z"
}
```

The new run also has `streamId: "wfrs_..."` and `batchId: null`,
distinguishing it from both batch-driven and direct-run invocations.

### End-to-end webhook → run lifecycle observed

```
t+0.0s  POST /webhook -> 202, workflowRunId returned synchronously
t+0.0s  GET /runs/{id} -> runStatus: 'running'
t+1.0s  running
t+2.0s  running
t+3.0s  running
t+4.0s  running
t+5.0s  running
t+6.0s  running
t+7.0s  COMPLETED
```

Wall time create→complete: ~7 seconds for the same inert 2-node graph
INV-026 measured at ~9.3 s. The ingestion path adds no meaningful
latency on top of direct runs.

### postWebhookBatch returned 403 with session cookie

```
POST /v3/tc-workflows/streams/{streamId}/webhook/batch
body: {"items":[{"requestData":{...}},{"entityId":42,"requestData":{...}}]}

403 {"type":"Forbidden","message":"You must be logged in","details":null}
```

This is **interesting**: the single-event `postWebhook` accepts session
cookies fine, but `postWebhookBatch` rejects them. Most likely the batch
endpoint requires API-key auth (the same `x-clay-api-key` flow that the
official inbound webhooks use) — Clay's "official" public inbound API
supports webhook events into a stream, and the batch variant may be the
high-throughput backfill channel for that. Body shape was the canonical
one from the bundle, so this isn't a 400 (shape error) — it's auth.
Logged as **GAP-036**. The single-event variant is sufficient for the
proprietary API layer's needs.

### Lifecycle / negative probes

| Probe | Result |
|---|---|
| POST `/webhook` to a `paused` stream | 400 `{error:'BadRequest', message:'Stream is not active'}` |
| POST `/webhook` to non-existent streamId | 404 `{error:'NotFound', message:'Stream not found'}` |
| POST `/tc-workflows/streams/{id}/webhook` (no `/v3` prefix) | 404 — confirms the route lives under `/v3` like the rest of the API |
| PATCH `{status:'paused'}` then GET stream | 200, `status:'paused'` reflected |
| DELETE stream | 200 `{success:true}`; soft delete (sets `deletedAt`); the workflow still references the runs it spawned. |

### `webhookUrl` is the discoverable surface

For `streamType='webhook'`, the create-response includes the
fully-qualified URL:

```
"webhookUrl": "https://api.clay.com/tc-workflows/streams/wfrs_xxx/webhook"
```

This is mechanically equivalent to how INV-009 found webhook URLs in
`source.state.url` for legacy webhook sources — Clay returns the public
ingestion URL alongside the resource ID. The `/v3` prefix is **dropped**
in the returned URL even though the route is registered at
`/v3/tc-workflows/streams/{id}/webhook` and the bare path 404s. Both
URLs (with and without `/v3`) are tested in the script:
`https://api.clay.com/tc-workflows/streams/{id}/webhook` (returned by
the API) — **NOT TESTED in this run** because the script used the `/v3`
form. Worth a follow-up probe; quite possibly Clay's gateway strips
`/v3` for the webhook subroutes specifically. (See Next Steps.)

### No `cancelWorkflowRunStream` route

`lKe` has create/read/list/update/delete/listRuns and nothing else.
There is no explicit cancel — `PATCH {status:'paused'}` is the
soft-stop, `PATCH {status:'disabled'}` is the harder stop, and
`DELETE` is the destructive option. Same architectural pattern as the
direct-runs router (`Swe`): minimal lifecycle, lots of read.

### Credit delta: zero

```
before: { basic: 1934.4, longExpiry: 0, actionExecution: 999999999897 }
after:  { basic: 1934.4, longExpiry: 0, actionExecution: 999999999897 }
```

Same `actionExecution` near-infinity as INV-026. The webhook-driven
run executed the same default-`claude-haiku-4-5` agent on the same
inert nodes, again with no observable metering. GAP-034 still stands.

## New Endpoints Discovered

8 new endpoints (all confirmed end-to-end except `postWebhookBatch`,
which is bundle-confirmed + reachable but auth-blocked under session
cookies):

| Endpoint | Status |
|---|---|
| POST `/v3/workspaces/{ws}/tc-workflows/{wf}/streams` | confirmed |
| GET `/v3/workspaces/{ws}/tc-workflows/{wf}/streams` | confirmed |
| GET `/v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` | confirmed |
| PATCH `/v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` | confirmed |
| DELETE `/v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` | confirmed |
| GET `/v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}/runs` | confirmed |
| POST `/v3/tc-workflows/streams/{streamId}/webhook` | confirmed |
| POST `/v3/tc-workflows/streams/{streamId}/webhook/batch` | suspected (auth-blocked) |

## Implications

1. **Live ingestion is now usable end-to-end.** The proprietary API
   layer can offer a third workflow invocation primitive: "register a
   webhook stream, get back a URL, point external systems at it, runs
   appear in `streams/{id}/runs`". This mirrors how Clay's legacy
   webhook *sources* feed CSV-like tables, but at the
   **tc-workflows agent** layer rather than the table layer.
2. **Three invocation primitives confirmed for tc-workflows**:
   - `csv_import` batches (bulk, file-driven, per-row) — INV-024.
   - Direct runs (synchronous, single-shot, optional inputs) — INV-026.
   - Webhook streams (live, push-driven, arbitrary JSON payload) — INV-027.
   These map cleanly to bulk / on-demand / streaming workloads.
3. **Stream `streamType` enum suggests two more surfaces** —
   `agent_action` and `workflow_action`. Both accepted creates with
   empty config and no `webhookUrl` was returned, meaning those streams
   are not webhook-ingestion targets. They are likely **internal stream
   types** that other Clay agents/workflows write into (e.g., a
   sub-workflow publishing events that another workflow stream
   consumes). Their config shape is unknown — opens GAP-037.
4. **postWebhookBatch's 403-on-session-cookie is the strongest clue
   yet that Clay has an API-key-authed inbound webhook channel for
   tc-workflows**. The single-event endpoint accepting cookies is
   probably an internal convenience for the editor UI; the batch
   endpoint rejecting cookies suggests it's the productized
   high-throughput inbound API. If we can get an API key minted for the
   workspace, we should re-test the batch route under that auth.
5. **Stream resources are auto-snapshot-bound.** `createWorkflowRunStream`
   requires a real `wfs_xxx` snapshot id (we passed the one from a seed
   direct run). Updating the workflow graph after stream creation would
   leave the stream pointing at a stale snapshot — `updateWorkflowRunStream`
   accepts a new `workflowSnapshotId`, so the consumer model is
   "create stream → graph evolves → bump stream snapshot manually".
   This is consistent with batches/direct-runs both having their own
   `workflowSnapshotId` field per invocation.
6. **The `/v3` prefix vs the returned `webhookUrl`**: Clay returns
   `https://api.clay.com/tc-workflows/streams/{id}/webhook` (no `/v3`),
   yet the only path that worked under session cookies was the `/v3`
   form. The non-`/v3` form on `api.clay.com` returned 404. Either:
   (a) Clay's API gateway re-routes the public form to the `/v3` form
   for non-cookie auth, or (b) there's a separate public endpoint we
   haven't unlocked yet. Worth probing under API-key auth as part of
   GAP-036.

## Files Updated

- `investigations/INV-027_workflow-streams.md` (this file)
- `investigations/_index.md`
- `harness/scripts/verify-workflow-streams.ts` (new)
- `harness/results/inv-027-streams-1775599180271.json` (new)
- `registry/endpoints.jsonl` (+8 streams/webhook endpoints)
- `registry/capabilities.md` (workflow streams section)
- `registry/gaps.md` (closed GAP-033, opened GAP-036 + GAP-037)
- `registry/changelog.md` (2026-04-07 INV-027 entry)
- `knowledge/internal-v3-api.md` (streams + webhook ingestion section)
- `architecture/system-design.md` (section 2c — added streams row + live
  ingestion description)
- `timeline/2026-04-07_8_inv-027-workflow-streams.md`

## Next Steps

1. **GAP-036 (new): API-key auth for `postWebhookBatch`.** The single-event
   variant works under cookies; the batch variant returns 403 "must be
   logged in" with the canonical body shape. Mint a workspace API key,
   re-test under `Authorization: Bearer ...` or `x-clay-api-key`, and
   close the loop on the batch ingestion path.
2. **GAP-037 (new): `agent_action` and `workflow_action` stream types.**
   Created cleanly with empty config but no `webhookUrl` is returned.
   These are not externally-pushable. Determine where they get written
   (probably from agent tools / sub-workflow nodes) by interception or
   bundle scan around the `agent_action`/`workflow_action` literals.
3. **`webhookUrl` non-`/v3` form**: probe
   `https://api.clay.com/tc-workflows/streams/{id}/webhook` (the URL
   Clay actually returns) under session cookie, anonymous, and API-key
   auth to see which auth mode the public form expects.
4. **Stream snapshot drift**: create a stream, edit the workflow graph,
   trigger another direct run (forces new snapshot), POST the webhook
   again, and observe whether the new run uses the stream's old
   snapshot or auto-bumps. Will tell us whether stream consumers need
   explicit `updateWorkflowRunStream` calls when the workflow evolves.
5. **Carry forward GAP-034 (default-LLM credit metering) and GAP-035
   (HITL happy path)** from INV-026; both still open.
