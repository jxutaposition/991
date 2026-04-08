# Clay API — TODO Tracker

Things we **cannot** do programmatically today that block a fully autonomous Clay table-building agent.

## Priority Legend
- **P0** — Blocks core read/write loop. Agent is crippled without this.
- **P1** — Blocks important automation workflows. Agent can limp along.
- **P2** — Nice to have. Agent works but with manual workarounds.

## Open Items

### From Session 4
- [ ] [TODO-007: Discover real-time update channel](TODO-007_realtime-updates.md) — **P2** — requires CDP/Playwright
- [x] [TODO-010: View CRUD filter/sort](TODO-010_view-crud.md) — **RESOLVED NEGATIVE** — all 11 payload formats tested, all return 200 but filter/sort not persisted. Preconfigured views use server-side `typeSettings.preconfiguredType`. View filtering is NOT available via REST API.

### From Session 5 (Deep Scan)
- [x] TODO-020: Signals CRUD — **PARTIALLY RESOLVED**: single GET works, no write endpoints exist
- [x] TODO-021/030: Export file download — **RESOLVED**: `GET /v3/exports/{jobId}?download=true` → `downloadUrl` = signed S3 URL (24h expiry)
- [ ] [TODO-022: Workspace users & permissions](TODO-022_workspace-users-permissions.md) — **P2** — READ confirmed. WRITE untested.
- [ ] [TODO-023: Attributes catalog deep dive](TODO-023_attributes-catalog.md) — **P2** — READ confirmed. Full schema undocumented.
- [x] TODO-024: Import job creation — **RESOLVED (INV-020)** — `POST /v3/imports` confirmed working with `{workspaceId, config:{map, source:{key,type:"S3_CSV",filename,hasHeader,recordKeys,uploadMode,fieldDelimiter}, destination:{type:"TABLE",tableId}, isImportWithoutRun}}`. Synchronous. `GET /v3/imports/{id}` polls status. Remaining sub-gap: no v3 endpoint to upload the CSV to S3 (tracked as GAP-027).
- [ ] [TODO-025: Table settings deep dive](TODO-025_table-settings-deep-dive.md) — **P1** — tableSettings is schemaless JSON blob. autoRun, dedupeFieldId, schedule, cronExpression all accepted.

### From Session 6 (TODO Attacks)
- [x] TODO-026: Signal write — **RESOLVED NEGATIVE**: no POST/PATCH endpoints exist for signals
- [x] TODO-027: Resource tags — **RESOLVED**: full CRUD confirmed. `POST {tagText, tagColor, isPublic}`, `DELETE /{tagId}`. Colors: nightshade/pomegranate/tangerine/lemon/matcha/blueberry/ube/dragonfruit
- [x] TODO-028: Source scheduling — **RESOLVED NEGATIVE (INV-022)** — `tableSettings` accepts and persists every schedule-shaped key (`schedule`, `cronExpression`, `scheduleEnabled`, `nextRunAt`, `lastRunAt`, `scheduleStatus`, `runFrequency`, `runFrequencyConfig`) via merge but they are pure UI scratch space; backend scheduler does not read them. `HAS_SCHEDULED_RUNS` is server-controlled (PATCH override silently dropped). Source `typeSettings` is validated and 500s on schedule keys; top-level source PATCH silently no-ops. 16 candidate `/v3/*schedul*`, `/v3/triggers`, `/v3/jobs`, `/v3/recurring-jobs` paths all 404. Workaround: external cron → `PATCH /v3/tables/{id}/run`.
- [ ] [TODO-029: Deduplication behavior](TODO-029_table-deduplication-behavior.md) — **P1** — dedupeFieldId accepted but doesn't prevent direct-insert duplicates
- [x] TODO-030: Export download — **RESOLVED** (merged with TODO-021)
- [x] TODO-031: Enrichment column from scratch — **RESOLVED**: works with empty inputsBinding `[]` and actionPackageId from actions catalog

### Also Open (tracked in registry/gaps.md only)
- **GAP-019**: `actionPackageDefinition` format for `POST /v3/actions`. Requires CDP intercept.

## Resolved (files deleted — resolutions documented in timeline and registry)

| TODO | Resolution | Session |
|------|-----------|---------|
| TODO-001: Read rows | `GET /v3/tables/{id}/views/{viewId}/records` | Session 5 (INV-012) |
| TODO-002: CSV export | `POST /v3/tables/{id}/export` → async job `ej_xxx` | Session 4 (INV-017) |
| TODO-003: Enrichment columns | `actionKey` + `actionPackageId` + `inputsBinding` + `authAccountId` | Pipeline rebuild |
| TODO-004: Enrichment completion | Poll rows → `cell.metadata.status` = `SUCCESS` / `ERROR_*` | Session 4 (INV-013) |
| TODO-005: Enrichment errors | `metadata.status`: `ERROR_OUT_OF_CREDITS`, `ERROR_BAD_REQUEST` | Session 4 (INV-013) |
| TODO-006: Formula re-eval | Formulas auto-evaluate on insert + auto-re-evaluate on update | Session 4 (INV-017) |
| TODO-008: Bulk field creation | Non-issue: 0 rate limiting, 21ms/call, 20 fields < 500ms | Session 2 (INV-008) |
| TODO-009: Pagination | `limit=10000` returns all rows. No cursor/page/offset. Default=100. | Session 4 (INV-014) |
| TODO-011: Enrichment metadata | `SUCCESS`, `ERROR_OUT_OF_CREDITS`, `ERROR_BAD_REQUEST`, `isStale` | Session 4 (INV-013) |
| TODO-012: Row count | No count field. Use `limit=10000` + count results. | Session 4 (INV-014) |
| TODO-013: Duplication | `POST /v3/tables/{id}/duplicate` + `POST /v3/workbooks/{id}/duplicate` | Session 4 (INV-016) |
| TODO-014: Trigger response | `{recordCount: N, runMode: "INDIVIDUAL"}`. No job ID. | Session 4 (INV-013) |
| TODO-015: Workbook CRUD | Create + duplicate work. GET/PATCH/DELETE individual → 404. | Session 4 (INV-016) |
| TODO-016: Table history | All endpoints 404. UI-only feature. | Session 4 (INV-016) |
| TODO-017: Run history | `recordMetadata.runHistory` = per-field `[{time, runId}]` | Session 4 (INV-013) |
| TODO-018: Credit tracking | No per-action tracking. Only `GET /v3/workspaces/{id}` → `credits`. | Session 4 (INV-017) |
| TODO-019: Row sorting | All sort query params ignored. Sorting is view-level only. | Session 4 (INV-017) |

## Score

### Sessions 4 through INV-026 Combined
- **Total TODOs created**: 43
- **Total resolved**: 38 (88%)  — TODO-024 closed by INV-020, TODO-028 closed by INV-022
- **Total open**: 5 (TODO-007, 022, 023, 025, 029) + GAP-019, GAP-033, GAP-034, GAP-035
- **Exhaustively searched**: 36 documented dead-ends + behavioral patterns
- **Total registry endpoints**: 110
- **Investigations completed**: INV-001 through INV-026
