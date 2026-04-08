# INV-026: tc-workflows Direct Runs (`Swe` Router)

**Date**: 2026-04-07
**Investigation**: INV-026
**Credit cost**: 0 on this dev workspace (but see surprise below)

## HEADLINE

The direct-workflow-runs router is fully usable end-to-end. Seven new
routes confirmed under `/v3/workspaces/{ws}/tc-workflows/{wf}`. Closes
GAP-032; opens GAP-034 (default-LLM credit metering question) and
GAP-035 (HITL happy path).

## Endpoints

| Endpoint | Status |
|---|---|
| `POST   .../runs` | confirmed (was suspected) |
| `GET    .../runs` | confirmed (was suspected) |
| `GET    .../runs/{runId}` | confirmed (was suspected) |
| `POST   .../runs/{runId}/pause` | confirmed (NEW) |
| `POST   .../runs/{runId}/unpause` | confirmed (NEW) |
| `POST   .../runs/{runId}/steps/{stepId}/continue` | confirmed (NEW) |
| `GET    .../steps/waiting` | confirmed (NEW) |

## What Works

- `POST /runs {inputs:{...}}` immediately starts executing.
  Status lifecycle observed on a 2-node inert workflow:
  `running → completed` in ~9.3s.
- `GET /runs/{runId}` returns a discriminated union:
  `{type:'current', workflowRun, workflowRunSteps[], workflowSnapshot}`
  or `{type:'archived', archivedAgentRun}`.
- Each `workflowRunSteps[i].data` is a full execution trace: system
  prompt, user prompt, tool name + params, reasoning string, thread
  context, token usage. Sufficient for observability/replay without
  any extra endpoints.
- pause/unpause work; both 400 with structured messages on terminal
  runs.

## What Doesn't Exist

- `PATCH .../runs/{runId}` → 404
- `DELETE .../runs/{runId}` → 404

The `Swe` router is **append-only**. Direct runs cannot be
cancelled — only paused/unpaused. To cancel a single run, wrap it in a
1-row csv_import batch (which CAN be PATCH-cancelled per INV-025).

## Surprises & Gotchas

- **INV-025 was wrong about the router name.** It guessed "Ewe" — that
  is actually the body discriminator variable for the batches router.
  The real direct-runs router is **`Swe`** at offset ~361931 in the
  current bundle.
- **"Inert" regular nodes are NOT actually inert.** This is the big
  one. INV-025 claimed `regular` nodes with no `modelId` are pure
  definitions. Reality: Clay silently injects
  `anthropic:claude-haiku-4-5` plus a ~2 KB system prompt plus
  built-in tools (`memory_search`, `fail_node`, transition actions).
  The 2-node test burned ~12 k tokens. Despite this, workspace credit
  delta was zero — but this workspace has
  `actionExecution: 999999999897` (effectively unlimited), so the
  credit-safety claim needs re-verification on a normal paid
  workspace. Tracked as GAP-034.
- **`workflowSnapshotId` in the request body is silently ignored.**
  The server always resolves `'latest'` itself.
- **`standaloneActions` is an OBJECT, not an array.** Passing `[]`
  returns 400 `"Expected object, received array"`. Bundle type is
  `J_`, an object schema.
- **Two status enums.** `runStatus` =
  `pending|running|paused|completed|failed|waiting`. The inner
  `runState` discriminated union uses only
  `running|paused|completed|failed`. The two are not 1:1.
- **Bundle hash rotated AGAIN.** INV-024 `index--X05HdGb.js`,
  INV-025 `index-Ba1k0a3-.js`, INV-026 `index-D2XXxr_J.js`. Every
  session must re-resolve from `https://app.clay.com/` HTML.
- `continueWorkflowRunStep` is reachable (404 on fake stepId proves
  the route + stepId validator are live), but the HITL happy path
  needs a node with `interventionSettings` to drive a step into
  `waiting` state. Deferred to GAP-035.

## Cross-reference

`investigations/INV-026_direct-workflow-runs.md`
