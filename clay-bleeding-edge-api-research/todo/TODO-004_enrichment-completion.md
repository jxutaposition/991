# TODO-004: Monitor Enrichment Completion

**Priority:** P1 — Agent needs to know when enrichments finish
**Status:** Open
**Related Gap:** None (new gap)

## Problem

We can trigger enrichments via `PATCH /v3/tables/{tableId}/run` with `{fieldIds, runRecords: {recordIds}}`, but we have no way to know when they **finish**. The response is immediate (enqueued), not a completion signal.

Without this, the agent:
- Can't reliably read enrichment results (might read before completion)
- Can't chain enrichments (column B depends on column A's output)
- Can't report success/failure to the user

## What We Know

- `PATCH /run` returns immediately with an acknowledgment (async)
- No known polling endpoint for enrichment status
- Clay UI shows real-time progress (loading spinners per cell) — it must get updates somehow
- Likely candidates: WebSocket, SSE, or polling

## Investigation Plan

1. **CDP intercept during enrichment**: Trigger an enrichment in the UI and watch ALL network activity — especially WebSocket frames, SSE streams, or polling requests
2. **Check for status endpoint**: Try `GET /v3/tables/{tableId}/run/status`, `GET /v3/tables/{tableId}/jobs`, etc.
3. **Row polling fallback**: If no dedicated status API exists, poll rows (once TODO-001 is solved) and check for cell value changes as a proxy for completion
4. **WebSocket discovery**: Check if Clay opens a WS connection on page load (relates to TODO-007)

## Success Criteria

- Can detect when a triggered enrichment has completed (all rows processed)
- Can distinguish success vs failure per row
- Understand latency/polling interval needed
