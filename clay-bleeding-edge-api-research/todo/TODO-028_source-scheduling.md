# TODO-028: Source Scheduling / Auto-Run Configuration

**Priority:** P1 — Automated data refresh is critical for agent autonomy
**Status:** Open

## What We Know
- `tableSettings.autoRun` is writable (confirmed INV-019)
- `tableSettings.HAS_SCHEDULED_RUNS` exists in responses
- `scheduledSourcesLimit: 100` and `scheduledTablesLimit: 100` feature flags
- Source objects have `typeSettings` which may contain schedule config
- No dedicated `/v3/schedules` endpoint exists (confirmed 404)

## Investigation Plan
1. Set `tableSettings.autoRun: true`, insert a row, check if enrichments auto-trigger
2. Try `PATCH /v3/tables/{id}` with `tableSettings.schedule` or `tableSettings.cronExpression`
3. Try `PATCH /v3/sources/{id}` with schedule-related typeSettings
4. Read existing source typeSettings deeply for schedule fields
5. Try `tableSettings.HAS_SCHEDULED_RUNS: true` and see what happens
