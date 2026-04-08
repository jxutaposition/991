# INV-022: Source Scheduling / Cron Persistence

**Status**: completed
**Priority**: P1
**Gap**: TODO-028 — does any schedule field on tableSettings or source typeSettings actually persist and drive scheduled runs?
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

`tableSettings` is a schemaless merge bucket (INV-023) so it should accept arbitrary `schedule` / `cronExpression` keys at PATCH time, but unverified whether they (a) persist on read-back and (b) drive any actual scheduled execution. Sources have a `typeSettings` blob that is suspected to be more validated. No dedicated `/v3/schedules*` endpoints exist (per `exhaustively_searched/scheduled-sources-api.md`).

## Method

`harness/scripts/investigate-source-scheduling.ts`:

1. Created scratch spreadsheet table; PATCHed `tableSettings` with 13 different schedule shapes (5/6-field cron, `@hourly`/`@daily`, schedule object, `scheduleEnabled`, `nextRunAt`, `lastRunAt`, `scheduleStatus`, `runFrequency`, `runFrequencyConfig`, `HAS_SCHEDULED_RUNS`, plus top-level variants).
2. GET-read the table back and dumped the merged `tableSettings`.
3. Created scratch `manual` source on the same table (webhook = paywalled HTTP 402; v3-action = HTTP 500 without action wiring; manual works fine).
4. PATCHed source with 9 different schedule shapes against `typeSettings.*` and source top-level.
5. GET-read the source back.
6. Probed 16 candidate scheduling endpoints (`/v3/tables/{id}/schedule`, `/v3/sources/{id}/runs`, `/v3/triggers`, `/v3/jobs`, `/v3/recurring-jobs`, `/v3/scheduled-tables`, etc.).
7. Cleaned up source + table.

Raw outputs:
- `harness/results/inv-022-source-scheduling-1775589540678.json`
- `harness/results/inv-022-source-scheduling-summary-1775589540678.json`

## Findings

### tableSettings: every schedule key persists (schemaless bucket — same as INV-023)

Final `tableSettings` after all 13 PATCHes (read back from `GET /v3/tables/{id}`):

```json
{
  "schedule": {
    "cron": "0 12 * * *",
    "enabled": true,
    "timezone": "America/Los_Angeles"
  },
  "lastRunAt": "2026-04-07T00:00:00.000Z",
  "nextRunAt": "2030-01-01T00:00:00.000Z",
  "runFrequency": "DAILY",
  "cronExpression": "@daily",
  "scheduleStatus": "ACTIVE",
  "scheduleEnabled": true,
  "HAS_SCHEDULED_RUNS": false,
  "runFrequencyConfig": { "hour": 9, "timezone": "UTC" }
}
```

Key observations:

- **All custom keys persisted verbatim.** Even nonsense like `runFrequency: "DAILY"` round-trips. Cron strings are not validated — `@daily`, `0 0 * * * *` (6-field), `0 * * * *`, `@hourly` all stored as raw strings.
- **`HAS_SCHEDULED_RUNS` is server-controlled.** PATCH set it to `true`, server overrode it back to `false`. Same as INV-019. This is the only schedule-related key the backend manages itself; everything else is opaque storage.
- **Top-level `cronExpression` and top-level `schedule` were silently dropped** — `PATCH /v3/tables/{id}` only persists keys nested under `tableSettings`. The top-level fields returned 200 but never appeared on read-back.
- **There is no `nextRunAt`/`lastRunAt`/`scheduleStatus` server-managed pair** — those values stayed exactly as we wrote them, including the clearly fake `2030-01-01` value. They are not driven by any backend scheduler.

### Sources: typeSettings is validated, top-level is silently dropped

| PATCH shape | Status | Persisted on GET? |
|---|---|---|
| `typeSettings.cronExpression` | **500** | n/a |
| `typeSettings.schedule` (object) | **500** | n/a |
| `typeSettings.scheduleEnabled` | **500** | n/a |
| `typeSettings.runFrequency` | **500** | n/a |
| `typeSettings.nextRunAt` | **500** | n/a |
| top-level `schedule` | 200 | **NO** |
| top-level `cronExpression` | 200 | **NO** |
| top-level `scheduleEnabled` | 200 | **NO** |
| top-level `isScheduled` + `scheduleConfig` | 200 | **NO** |

Final source `typeSettings` after every PATCH: `{}`. No schedule-shaped keys appear anywhere on the source object. **Sources do not store schedule state at all** through any path we can reach.

The `typeSettings` 500s are notable: unlike `tableSettings`, source `typeSettings` has either schema validation or a typed serializer that throws on unknown keys. So the merge-semantics escape hatch we have on tables does not exist on sources.

### Endpoint probes: all 404, no scheduling REST surface

All 16 candidates returned 404 (or 400 in one parameterized case). No `/v3/scheduled-runs`, `/v3/scheduled-tables`, `/v3/triggers`, `/v3/jobs`, `/v3/recurring-jobs`, `/v3/tables/{id}/schedule`, `/v3/sources/{id}/runs`, etc. Combined with the existing `exhaustively_searched/scheduled-sources-api.md` list, the v3 scheduling REST surface is empty.

### Trigger-source type does not carry schedule fields

Inspected an existing `trigger-source` source (`s_0tczx56nYvfSt2SWUwU`, the "Find professional posts" event source). Its `typeSettings` contains only `iconType`, `signalType`, `triggerDefinitionId`, `actionSourceSettings.{inputs, actionKey, actionPackageId}`. **No cron, schedule, frequency, or nextRun fields** anywhere on a real production trigger source either. Whatever drives recurring trigger evaluation is not exposed on the source object.

## Implications

1. **Scheduling is UI-only / scheduler-internal.** `tableSettings` is just a schemaless JSON blob the UI scribbles into; the backend scheduler (whatever runs `HAS_SCHEDULED_RUNS`) reads from somewhere we cannot reach via REST. Writing `cronExpression: "@hourly"` into `tableSettings` will NOT cause the table to actually run hourly — it just stores a string the UI may later display.
2. **`HAS_SCHEDULED_RUNS` is the only real signal.** It is server-managed and read-only from our side. Setting it to `true` is rejected silently. So we cannot even trick the system flag.
3. **No supported way to programmatically schedule a Clay table or source** via the v3 API as it stands. This must go through Playwright DOM automation against the schedule UI, or live with manual triggering via `PATCH /v3/tables/{id}/run`.
4. **Source typeSettings is stricter than tableSettings.** Useful future knowledge: don't try to use sources as a schemaless escape hatch the way tables work — source `typeSettings` 500s on unknown keys.
5. **For "automated refresh"** (the original P1 motivation), the realistic options are:
   - **Self-hosted scheduler**: cron our own backend → call `PATCH /v3/tables/{id}/run` with the desired `fieldIds` / `runRecords`. This is the only API-accessible way to get recurring enrichment runs today.
   - **Playwright UI automation**: drive Clay's own scheduling dropdown.

## New Endpoints Discovered

None. All 16 probed paths returned 404.

## Next Steps

- Update `exhaustively_searched/scheduled-sources-api.md` with the additional 16 dead paths from this investigation.
- Treat TODO-028 as resolved-negative: "scheduling cannot be configured via the v3 API".
- For agent automation, plumb a "scheduled run" capability through our own backend cron + `PATCH /v3/tables/{id}/run`.
- (Optional, P2) CDP-intercept the Clay UI's "Schedule" panel to find whatever non-`/v3` route the scheduler config actually flows through. Could live in `/api/*` or a separate scheduler service.
