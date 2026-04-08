# INV-027: tc-workflows Streams (`lKe` Router) + Webhook Ingestion (`uKe` Router)

**Date**: 2026-04-07
**Investigation**: INV-027
**Credit cost**: 0 on this dev workspace (same default-Claude-Haiku path
as INV-026; see GAP-034 for the metering caveat)

## HEADLINE

The third tc-workflows invocation primitive is fully usable end-to-end:
**live webhook ingestion**. Create a stream → get a `webhookUrl` → POST
arbitrary JSON → a workflow run is created with the body as
`runState.inputs` verbatim, executes, and completes in ~7 seconds on
the same inert 2-node graph INV-026 used for direct runs. Closes
GAP-033; opens GAP-036 (api-key-authed webhook batch) and GAP-037
(internal `agent_action` / `workflow_action` stream types).

Bundle hash rotated AGAIN: `index-D2XXxr_J.js` (INV-026) →
`index-BS8vlUPJ.js` (INV-027). Routers extracted contiguously at offsets
~623100–625900 and cross-checked against the client router map at
offset ~841857: `terracottaWorkflowRunStreams:lKe,
terracottaStreamWebhook:uKe`. INV-025/026 had guessed the streams
router was `sKe`; that's actually the request body Zod schema
(`createWorkflowRunStream`'s body). Same trap as INV-025's "Ewe" /
actual `Swe`. **Stop guessing router names from neighbouring tokens.**

## Endpoints

| Endpoint | Status |
|---|---|
| `POST   /v3/workspaces/{ws}/tc-workflows/{wf}/streams` | confirmed (was suspected) |
| `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams` | confirmed (NEW) |
| `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` | confirmed (NEW) |
| `PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` | confirmed (NEW) |
| `DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}` | confirmed (NEW) |
| `GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}/runs` | confirmed (NEW) |
| `POST   /v3/tc-workflows/streams/{streamId}/webhook` | confirmed (NEW, root path) |
| `POST   /v3/tc-workflows/streams/{streamId}/webhook/batch` | suspected — bundle-confirmed but 403 under cookies (NEW) |

## What Works

- `POST .../streams` with `streamType:'webhook'` returns a stream
  object whose `webhookUrl` is the public ingestion URL.
- `POST /v3/tc-workflows/streams/{id}/webhook` with **arbitrary JSON
  body** returns 202 `{success, workflowRunId, message}`. The
  `workflowRunId` is returned **synchronously**, so the caller can
  immediately poll `/runs/{id}` for status.
- The request body becomes `runState.inputs` on the new run **verbatim,
  with no wrapping**. Observed: body `{email, company}` →
  `runState.inputs == {email, company}`.
- New runs from streams have `streamId` set and `batchId: null`,
  distinguishing them from both direct and batch invocations.
- End-to-end lifecycle observed: webhook → `runStatus:'running'` →
  ... → `runStatus:'completed'` in ~7 seconds (same inert 2-node graph
  INV-026 ran in ~9.3 s for direct runs).
- `PATCH {status:'paused'}` blocks further ingestion: subsequent webhook
  posts return 400 `"Stream is not active"`.
- `DELETE` is a soft-delete (sets `deletedAt`); spawned runs survive.

## What Doesn't Work (or is auth-blocked)

- `POST /v3/tc-workflows/streams/{id}/webhook/batch` returned **403
  `{type:'Forbidden', message:'You must be logged in'}`** under session
  cookie auth, with the canonical body shape from the bundle. The
  single-event variant accepts cookies fine. This is the strongest hint
  yet that Clay has an API-key-authed inbound webhook channel for
  tc-workflows — the same `x-clay-api-key` flow Clay's productized
  inbound webhooks use. Tracked as **GAP-036**.
- `POST /tc-workflows/streams/{id}/webhook` (no `/v3` prefix) → 404.
  Curiously, the `webhookUrl` field returned by the create-response
  is `https://api.clay.com/tc-workflows/streams/{id}/webhook`
  (no `/v3`), but only the `/v3` form is routable under cookie auth.
  Probably the public URL form is gateway-rewritten under non-cookie
  auth modes. Worth re-probing under API-key auth (part of GAP-036).

## Surprises & Gotchas

- **Three `streamType` values, only one is externally pushable.** The
  enum is `webhook | agent_action | workflow_action`. Only `webhook`
  returns a `webhookUrl`. The other two were created cleanly with
  `config:{}` but expose no externally-callable surface. Hypothesis:
  they're internal stream types written to from inside the workflow
  runtime (sub-workflows or agent tools emitting events). Tracked as
  **GAP-037**.
- **Streams are bound to a specific snapshot.** `createWorkflowRunStream`
  requires a real `wfs_xxx` snapshot id (we passed one harvested from a
  seed direct run). Updating the workflow graph after stream creation
  would leave the stream pointing at a stale snapshot —
  `updateWorkflowRunStream` accepts a new `workflowSnapshotId`, so the
  consumer model is "create stream → graph evolves → bump stream
  snapshot manually". Same pattern as batches and direct runs.
- **`webhookUrl` is returned without `/v3`** even though the only path
  routable under cookies is `/v3/tc-workflows/streams/{id}/webhook`.
  Clay's gateway behaviour for the public form is still unmapped.
- **Bundle hash rotated AGAIN.** INV-024 `index--X05HdGb.js`,
  INV-025 `index-Ba1k0a3-.js`, INV-026 `index-D2XXxr_J.js`,
  INV-027 `index-BS8vlUPJ.js`. Every session must re-resolve from
  `https://app.clay.com/` HTML. Cached the new bundle to
  `harness/results/bundles/index-BS8vlUPJ.js`.

## Three invocation primitives now confirmed

| Primitive | Endpoint | Use case | Investigation |
|---|---|---|---|
| **CSV batches** | `POST .../batches {type:'csv_import',...}` | Bulk, file-driven, one run per row | INV-024 |
| **Direct runs** | `POST .../runs {inputs?}` | Synchronous, single-shot, agentic / chat-style | INV-026 |
| **Webhook streams** | `POST /tc-workflows/streams/{id}/webhook` | Live, push-driven, arbitrary JSON | **INV-027** |

These map cleanly to bulk / on-demand / streaming workloads and give
the Lele agent full coverage of the tc-workflows execution surface.

## Cross-reference

`investigations/INV-027_workflow-streams.md`
