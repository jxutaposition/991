# INV-022: Source / Table Scheduling — RESOLVED NEGATIVE

**Date**: 2026-04-07
**Investigation**: INV-022
**Credit cost**: 0

## HEADLINE

There is **no v3 API surface for scheduling** anything. `tableSettings`
will accept and persist any schedule-shaped key you throw at it, but
none of those values drive any backend behavior. Closes TODO-028 and
GAP-028 as resolved-negative.

## Findings

- **`tableSettings` is a schemaless merge bucket.** All 13 PATCH
  shapes round-tripped via GET — including obvious nonsense like
  `runFrequency: "DAILY"`, `nextRunAt: "2030-01-01"`, fake cron
  strings (`@daily`, 6-field expressions). The backend scheduler
  doesn't read any of them.
- **`HAS_SCHEDULED_RUNS` is server-controlled** and silently overrode
  our `true` write back to `false`. The only schedule-related key the
  backend manages itself.
- **Top-level `cronExpression` and top-level `schedule` are silently
  dropped** — `PATCH /v3/tables/{id}` only persists keys nested under
  `tableSettings`.
- **Sources are STRICTER than tables.** Source `typeSettings` has a
  validator/serializer that **500s** on any unknown key
  (`cronExpression`, `schedule`, `scheduleEnabled`, `runFrequency`,
  `nextRunAt`). The schemaless escape hatch we have on tables does
  not exist on sources.
- Top-level source PATCH schedule fields return 200 but never
  persist on read-back.
- **16 candidate scheduling endpoints all 404** (`/v3/triggers`,
  `/v3/jobs`, `/v3/recurring-jobs`, `/v3/scheduled-tables`,
  `/v3/tables/{id}/schedule`, `/v3/sources/{id}/runs`, ...).
- A real production `trigger-source` carries no cron / nextRun /
  schedule / frequency fields anywhere on its object.

## Endpoints Added

None. All 16 probed paths returned 404.

## Implications

- The realistic "automated refresh" path is **self-hosted cron** →
  `PATCH /v3/tables/{id}/run` with the desired `fieldIds` /
  `runRecords`. That's the only API-accessible recurring enrichment
  mechanism today.
- Or Playwright DOM automation against Clay's UI scheduler dropdown.

## Cross-reference

`investigations/INV-022_source-scheduling.md`
