# TODO-025: Table Settings Deep Dive

**Priority:** P1 — autoRun and deduplication are agent-critical
**Status:** Open — WRITE confirmed, full schema undocumented
**Discovered:** Session 5 (INV-019)

## What Works

`PATCH /v3/tables/{id}` with `tableSettings` confirmed writable:
- `autoRun: boolean` — enables automatic enrichment runs on new rows
- `dedupeFieldId: "f_xxx"` — sets the field used for deduplication
- `HAS_SCHEDULED_RUNS: boolean` — appears in response (may be read-only)

## What Needs Investigation

1. What other `tableSettings` keys exist? (Try setting various keys and checking response)
2. Does `autoRun: true` immediately trigger enrichments on existing rows?
3. Does `dedupeFieldId` actually prevent duplicate row creation?
4. Can we set `HAS_SCHEDULED_RUNS` or is it system-managed?
5. Try `tableSettings.runOnSchedule`, `tableSettings.scheduleInterval`, etc.
6. Test deduplication: insert duplicate rows and verify behavior

## Success Criteria

- Full tableSettings schema documented
- autoRun behavior confirmed (what triggers, what doesn't)
- Deduplication behavior verified
