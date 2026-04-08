# Scheduled Sources / Cron API

**Status**: NO ENDPOINTS EXIST. Scheduling is **UI-only / scheduler-internal** — not exposed via v3 REST at all.
**Investigated**: INV-018 (Session 5), INV-022 (2026-04-07)
**Note**: Feature flag `scheduledSourcesLimit: 100` exists but does not correspond to any v3 endpoint or persisted state we can write to. INV-022 confirmed `tableSettings` accepts and persists every schedule-shaped key (`schedule`, `cronExpression`, `scheduleEnabled`, `nextRunAt`, `lastRunAt`, `scheduleStatus`, `runFrequency`, `runFrequencyConfig`) via merge but they are pure UI scratch space — no backend behavior changes. `HAS_SCHEDULED_RUNS` is server-controlled and silently overrides PATCH writes back to `false`. Source `typeSettings` is validated and 500s on schedule keys; top-level source PATCH silently no-ops.

## Paths Tested (All 404)

### INV-018 (Session 5)
- `GET /v3/schedules`, `GET /v3/schedules?workspaceId=`
- `GET /v3/workspaces/{id}/schedules`
- `GET /v3/scheduled-sources`, `GET /v3/workspaces/{id}/scheduled-sources`
- `GET /v3/cron`, `GET /v3/workspaces/{id}/cron-jobs`

### INV-022 (2026-04-07)
- `GET /v3/tables/{id}/schedule`, `GET /v3/tables/{id}/schedules`
- `GET /v3/tables/{id}/scheduled-runs`, `GET /v3/tables/{id}/runs`
- `GET /v3/sources/{id}/schedule`, `GET /v3/sources/{id}/next-run`, `GET /v3/sources/{id}/runs` (400 — bad shape, not a real route)
- `GET /v3/workspaces/{id}/scheduled-runs`, `GET /v3/workspaces/{id}/scheduled-tables`
- `GET /v3/scheduled-runs?workspaceId=`, `GET /v3/scheduled-tables?workspaceId=`
- `GET /v3/triggers?workspaceId=`, `GET /v3/jobs?workspaceId=`, `GET /v3/recurring-jobs?workspaceId=`
- `POST /v3/tables/{id}/schedule`, `POST /v3/sources/{id}/schedule`

## Workaround
Run your own cron and call `PATCH /v3/tables/{id}/run` with the desired `fieldIds` / `runRecords`. This is the only API-accessible way to get recurring enrichment runs today.
