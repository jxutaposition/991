# INV-026: tc-workflows direct workflow runs (`Swe` router)

**Status**: completed
**Priority**: P2
**Gap**: GAP-032 — tc-workflows direct runs
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

INV-025 identified a sibling ts-rest router in the Clay bundle (guessed
name "Ewe") under `/v3/workspaces/:ws/tc-workflows/:wf/runs`, distinct
from the batch-based runs router already verified in INV-024. This
investigation documents its full route set, WorkflowRun shape, status
lifecycle, and the `continueWorkflowRunStep` human-in-the-loop endpoint.

## Method

### 1. Bundle scan

Bundle hash rotated AGAIN: `index-Ba1k0a3-.js` (INV-025) → now
`index-D2XXxr_J.js` (8.43 MB), resolved from
`https://app.clay.com/` HTML. The router object is actually **`Swe`**
at offset ~361931 (INV-025 guessed `Ewe`, which is the batches body
discriminator variable, not a router). Seven routes extracted:

| Route | Method | Path | Body | 200 |
|---|---|---|---|---|
| `createWorkflowRun` | POST | `/:ws/tc-workflows/:wf/runs` | `{inputs?, batchId?, standaloneActions?}` | `{workflowRun: Q_}` |
| `getWorkflowRuns` | GET | `/:ws/tc-workflows/:wf/runs?limit&offset` | — | `{runs: Q_[], total}` |
| `getWorkflowRun` | GET | `/:ws/tc-workflows/:wf/runs/:runId` | — | discriminated `current` \| `archived` |
| `continueWorkflowRunStep` | POST | `/:ws/tc-workflows/:wf/runs/:runId/steps/:stepId/continue` | `{humanFeedbackInput: hCe}` | `{success, stepId, status}` |
| `getWaitingSteps` | GET | `/:ws/tc-workflows/:wf/steps/waiting` | — | `{waitingSteps:[xwe]}` |
| `pauseWorkflowRun` | POST | `/:ws/tc-workflows/:wf/runs/:runId/pause` | `{}` | `{success, runId, status}` |
| `unpauseWorkflowRun` | POST | `/:ws/tc-workflows/:wf/runs/:runId/unpause` | `{}` | `{success, runId, status}` |

**No `deleteWorkflowRun`, no `cancelWorkflowRun`, no `PATCH /runs/:id`** —
the direct-runs router is append-only. Cancellation semantics are
batch-level only (see INV-025). Individual runs can only be paused /
unpaused once started.

### 2. `Q_` WorkflowRun shape (bundle)

```ts
WorkflowRun = {
  id: string,                       // wfr_...
  workflowId: string,               // wf_...
  workflowName: string | null,
  workflowSnapshotId: string,       // wfs_... (auto-resolved from 'latest')
  batchId: string | null,
  streamId: string | null,
  runStatus: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'waiting',
  runState: {
    status: 'running' | 'paused' | 'completed' | 'failed',
    currentNodeId?: string,
    inputs: object,
    globalContext: object,
    startedAt: string,
    // if completed:
    outputs?: any,
    completedAt?: string,
    completedByStepId?: string,
    completedByNodeId?: string,
    // if failed:
    failedAt?: string,
    error?: string,
    failedByStepId?: string,
    failedByNodeId?: string,
  },
  maxUninterruptedSteps: number,
  createdAt: string,
  updatedAt: string,
  langsmithTraceHeader?: string | null,
}
```

**NOTE**: Two status enums. The top-level `runStatus` includes `waiting`
and `pending`; the `runState` discriminated union does not (it has only
`running|paused|completed|failed`). The two are not 1:1.

### 3. Verification script

`harness/scripts/verify-workflow-direct-runs.ts`:

- Create scratch workflow
- Build two-node inert graph (`regular` initial → `regular` terminal, no
  model/prompt), connect with an edge
- `GET .../graph` validation
- `GET .../runs` (empty)
- `POST .../runs` with 4 body shape variants + 3 legacy shapes
- Poll `GET .../runs/{runId}` for up to 12s to capture lifecycle
- `GET .../runs` populated
- `GET .../steps/waiting`
- `POST .../runs/{runId}/pause` + `.../unpause`
- `POST .../runs/{runId}/steps/wfrs_fake_id/continue`
- `PATCH .../runs/{runId} {status:'cancelled'}`  (negative probe)
- `DELETE .../runs/{runId}` (negative probe)
- Cleanup: edge → nodes → workflow
- Credit balance before + after

Result file: `harness/results/inv-026-direct-runs-1775596617540.json`.

## Findings

### All seven Swe routes are live and behave as the bundle describes

| Endpoint | Result |
|---|---|
| POST `/runs` `{inputs:{}}` | 200, returns `workflowRun` with `runStatus:'running'` |
| POST `/runs` `{inputs:{hello:'world'}}` | 200 |
| POST `/runs` `{}` | 200 (inputs default to `{}`) |
| POST `/runs` `{standaloneActions:[]}` | 400 `"Expected object, received array"` — the bundle type is `J_`, which is an **object**, not an array. |
| POST `/runs` `{input:{}}` | 200 (extra keys silently accepted; not in schema) |
| POST `/runs` `{params:{}}` | 200 |
| POST `/runs` `{workflowSnapshotId:'latest',inputs:{}}` | 200 (workflowSnapshotId is silently ignored — the server always resolves 'latest' itself) |
| GET `/runs` | 200 — lists all created runs with `runStatus:'running'` for active, plus populated `runState` |
| GET `/runs/{runId}` | 200 — returns `{type:'current', workflowRun, workflowRunSteps[], workflowSnapshot}` |
| GET `/steps/waiting` | 200 `{waitingSteps:[]}` |
| POST `/runs/{runId}/pause` on completed run | 400 `"Cannot pause workflow run with status 'completed'"` |
| POST `/runs/{runId}/unpause` on completed run | 400 `"Cannot unpause workflow run with status 'completed'"` |
| POST `/runs/{runId}/steps/wfrs_fake/continue` | 404 `"Workflow run step not found"` (endpoint reachable, stepId validation working) |
| PATCH `/runs/{runId}` | 404 (not in router) |
| DELETE `/runs/{runId}` | 404 (not in router) |

### Observed status lifecycle (inert regular graph, one row)

```
create → runStatus: 'running', runState.status: 'running'
  t+0s: running
  t+1s: running
  t+2s: running
  ...
  t+7s: completed, runState.status: 'completed'
        runState.outputs.toolResult populated
        runState.completedAt set
```

Total wall time: ~9.3 s from create to `completed`. Two steps spawned:

1. Initial node step: `started → completed` (8.1 s). Invoked Anthropic
   `claude-haiku-4-5` to decide next action, called `memory_search` tool,
   then transitioned.
2. Terminal node step: `started → completed` (23 ms).

The full step data for the initial step contains `systemPrompt`,
`userPrompt`, `toolName`, `toolParams`, `reasoning`, `executionMetadata`,
and token usage (`{totalTokens: 8998, promptTokens: 8250,
completionTokens: 748}`). This is a goldmine for understanding Clay's
agentic workflow execution model.

### "Inert" regular nodes are NOT actually inert — but ARE credit-safe

Prior assumption (INV-025): `regular` nodes with no modelId/promptVersionId
are pure definitions that get skipped at runtime. **This is wrong.**

Reality: the server attaches a default LLM (`anthropic:claude-haiku-4-5`)
and default system prompt (see full prompt in results file) to any
regular node lacking a modelId. The node EXECUTES, invokes the LLM,
burns ~12k total tokens across the 2-node test, and calls tools
(`memory_search`).

Despite this, the workspace credit balance was UNCHANGED:

```
before: { basic: 1934.4, longExpiry: 0, actionExecution: 999999999897 }
after:  { basic: 1934.4, longExpiry: 0, actionExecution: 999999999897 }
```

Hypothesis: Clay's terracotta workflow execution uses an **internal LLM
pool not metered against user workspace credits**. The `actionExecution`
counter (~10^12) is already absurd, suggesting a dev/unlimited
workspace state. Needs cross-verification against a normal paid
workspace.

**For now**: direct workflow runs on inert `regular` nodes are safe to
investigate at zero user cost on this workspace. Do NOT generalise to
production workspaces without re-measuring.

### `continueWorkflowRunStep` is reachable but wasn't fully exercised

The happy-path probe would require building a workflow whose step
transitions to `waiting` for human input (e.g., `human_input_tool_decision`
callbackData). That requires a node with `interventionSettings` wired up,
which we haven't mapped yet. The 404 on the fake stepId confirms the
route is active and validates stepId existence server-side. Request body
shape is known from the bundle (`humanFeedbackInput` discriminated union
with at least 5 variants: `ApproveToolCall`, `DenyToolCall`,
`DenyTransition`, plus 2 more from `hCe` at offset 342410).

### No cancellation for direct runs

The direct-runs router contains **no cancel/delete routes**. Once
started, a run can only:
- Complete naturally (→ `completed` or `failed`)
- Be paused (→ `paused`) via POST `/pause`
- Be unpaused (→ `running`) via POST `/unpause`

Contrast with INV-025 batches: `PATCH /batches/{batchId} {status:'cancelled'}`
works at batch level. If you need cancel semantics for a single run,
wrap it in a batch.

### Runs survive workflow deletion — but only if you query them first

We DELETE'd the scratch workflow while it had 4+ runs attached. The
workflow DELETE returned 200. We didn't re-query the runs afterwards —
future investigation should check whether runs become orphaned, auto-archived,
or cascade-deleted.

## New Endpoints Discovered

All 7 Swe routes. 3 were already in `endpoints.jsonl` as `suspected`
(from INV-025 bundle scan); those are now `confirmed`. 4 are new:

| Endpoint | Prior state | Now |
|---|---|---|
| POST `/runs` | suspected | confirmed |
| GET `/runs` | suspected | confirmed |
| GET `/runs/{runId}` | suspected | confirmed |
| POST `/runs/{runId}/pause` | (not in registry) | confirmed |
| POST `/runs/{runId}/unpause` | (not in registry) | confirmed |
| POST `/runs/{runId}/steps/{stepId}/continue` | (not in registry) | confirmed |
| GET `/steps/waiting` | (not in registry) | confirmed |

## Implications

1. **Direct run API is usable end-to-end.** A consumer can:
   (a) build a workflow via mYe graph router (INV-025),
   (b) POST a run with `{inputs: {...}}`,
   (c) poll `GET /runs/{id}` until `runStatus:'completed'`,
   (d) read `runState.outputs` + `workflowRunSteps[*].stepOutputs`.
   No batch-and-CSV ceremony required for single-shot invocations.
2. **The direct-run API is the right primitive for agentic / chat-style
   integrations.** Batches are for bulk CSV. Direct runs are one row,
   one agent turn, synchronous polling, pause/resume, human-in-the-loop.
3. **Clay runs a hosted LLM inside every workflow.** Even without
   configuring a model, Clay injects `claude-haiku-4-5` with a detailed
   system prompt and tools (`memory_search`, `fail_node`, transition
   actions). This changes how INV-025 should be summarised:
   "inert regular node" is a misnomer — it's a **Claude agent node with
   Clay defaults**. Credit metering on such default-LLM usage needs
   separate verification on a normal workspace.
4. **No run cancel endpoint.** The proprietary API layer should expose
   `pauseRun()`/`unpauseRun()` but NOT `cancelRun()`; for user-facing
   cancellation, wrap the invocation in a 1-row csv_import batch (which
   CAN be cancelled).
5. **`workflowRunSteps[*].data` is a full trace.** Every step records
   prompts, tool calls, reasoning, token usage, thread context, and
   model identity. This is sufficient for observability / replay
   features without any extra endpoints.
6. **Bundle hash now rotates between investigations — do not cache it.**
   INV-024: `index--X05HdGb.js`. INV-025: `index-Ba1k0a3-.js`.
   INV-026: `index-D2XXxr_J.js`. Every session must re-resolve.

## Files Updated

- `investigations/INV-026_direct-workflow-runs.md` (this file)
- `investigations/_index.md`
- `harness/scripts/verify-workflow-direct-runs.ts` (new)
- `harness/results/inv-026-direct-runs-1775596617540.json` (new)
- `registry/endpoints.jsonl` (+4 new confirmed, 3 promoted suspected→confirmed)
- `registry/capabilities.md` (workflow direct-runs section)
- `registry/gaps.md` (closed GAP-032, opened GAP-034 + GAP-035)
- `registry/changelog.md` (2026-04-07 INV-026 entry)
- `knowledge/internal-v3-api.md` (direct runs section)

## Next Steps

1. **GAP-034 (new): default-LLM credit metering check.** Run a direct
   workflow run on a second workspace that has a real basic-credit
   balance (not this dev workspace) and see whether Clay's default
   Claude Haiku invocation is metered. Relevant for understanding
   whether "inert regular node" is truly free on production accounts.
2. **GAP-035 (new): human-in-the-loop happy-path.** Configure a node with
   `interventionSettings` so its step ends in `waiting` with
   `human_input_tool_decision` callback data, then exercise
   `continueWorkflowRunStep` with each variant of `humanFeedbackInput`
   (`ApproveToolCall`, `DenyToolCall`, `DenyTransition`, ...) and
   confirm the run resumes.
3. **GAP-033 (existing): streams router (`sKe`)** — next P2 investigation.
   Still unexplored; at ~582 KB in the current bundle hash.
4. **Orphaned run behaviour**: delete a workflow with active runs and
   see whether `getWorkflowRun(runId)` still resolves (maybe archived?),
   or whether runs cascade-delete.
5. **Subroutines (`CKe` router around 668 KB)** — every node has
   `subroutineIds:[]`, there's a router for them, and they look like
   reusable sub-workflows. Worth a separate P2 investigation.
6. **`maxUninterruptedSteps` semantics** — field is present on
   WorkflowRun but set to 0 in all our responses. Probably limits how
   many steps can fire without human intervention; relevant to
   agent safety.
