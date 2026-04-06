# Credit Usage Patterns — What Costs Money

**Status**: DOCUMENTED
**Investigated**: Credit audit of all 13 investigation scripts + 2 explore scripts

## COSTS CREDITS (avoid in investigation scripts)

| Operation | Credit Type | Cost Per |
|-----------|------------|----------|
| `PATCH /v3/tables/{id}/run` (enrichment trigger) | Action | 1+ per row × field |
| `tableSettings.autoRun: true` + inserting rows into table with action columns | Action | 1+ per row × enrichment column |
| Creating enrichment column on table that already has rows (may auto-trigger) | Action | 1+ per existing row |
| Data enrichments (Find People, Find Companies, etc.) | Data | 1+ per row |

## FREE (safe for investigation scripts)

| Operation | Notes |
|-----------|-------|
| Table create/read/update/delete/duplicate | All free |
| Column/field create/read/update/delete | Free (except action columns on populated tables) |
| View create/rename/delete | Free |
| Row insert/read/update/delete | Free |
| Source/webhook CRUD | Free |
| Workbook create/duplicate/list | Free |
| Schema reads (`GET /v3/tables/{id}`) | Free |
| Actions catalog (`GET /v3/actions`) | Free |
| Workspace/user/permission reads | Free |
| Export job creation + polling + download | Free |
| Formula evaluation (auto on insert) | Free |
| Tags CRUD | Free |

## Investigation Script Best Practices

1. **NEVER set autoRun: true on tables with enrichment columns** unless explicitly testing autoRun
2. **NEVER call PATCH /run** unless explicitly testing enrichment execution
3. **Create enrichment columns on EMPTY tables** — add rows only if you need to test execution
4. **Use `forceRun: false`** when testing run semantics — it skips already-succeeded cells (0 credits)
5. **Use cheap actions** like `normalize-company-name` (1 credit each) when enrichment testing is needed
6. **Minimize row count** in enrichment tests — 1-2 rows is enough to prove behavior
7. **Clean up tables** after tests to prevent ongoing autoRun charges

## Audit of Our 15 Scripts

Total credits consumed by all investigation scripts: **~20 action credits**
- 13 of 15 scripts consumed ZERO credits
- Highest cost: investigate-enrichment-lifecycle.ts (6 credits)
- All scripts used `normalize-company-name` (cheapest action, 1 credit each)

The 14.9K/15K action usage was NOT from our investigation scripts (~0.13%).
It was from pipeline rebuilds, existing table enrichments, and earlier agent sessions.
