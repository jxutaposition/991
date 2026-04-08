# Exhaustively Searched — Dead Ends & Negative Results

Features and APIs that have been thoroughly investigated and confirmed **not possible** via the v3 REST API. These files exist so future agents don't waste time re-probing the same paths.

**If you're a deployed agent**: Read this directory before probing. If something is listed here, move on to the next gap.

## Index

| File | Feature | Conclusion |
|------|---------|------------|
| [view-filter-sort.md](view-filter-sort.md) | View filter/sort/field-order update via REST | Not available — 11 payload formats tested, all no-op |
| [row-pagination.md](row-pagination.md) | Cursor/page/offset pagination | Not available — use `limit=10000` workaround |
| [row-sorting-query-params.md](row-sorting-query-params.md) | Sort via query params on records endpoint | Not available — all params silently ignored |
| [table-history-restore.md](table-history-restore.md) | Table version history / restore / snapshots | No endpoints exist (all 404) |
| [individual-workbook-crud.md](individual-workbook-crud.md) | GET/PATCH/DELETE individual workbooks | Not available — only create, duplicate, list work |
| [per-action-credit-tracking.md](per-action-credit-tracking.md) | Credit usage per enrichment action | No endpoints exist — only aggregate via workspace |
| [bulk-field-creation.md](bulk-field-creation.md) | Multi-field creation in single call | No endpoint — but non-issue (21ms/field, no rate limit) |
| [row-count-endpoint.md](row-count-endpoint.md) | Total row count for a table | No field in schema, no endpoint — use limit+count workaround |
| [formula-trigger-not-needed.md](formula-trigger-not-needed.md) | Manual formula re-evaluation | Not needed — formulas auto-evaluate on insert and update |
| [folders-api.md](folders-api.md) | Folder management | All /v3/folders paths 404 |
| [recipes-api.md](recipes-api.md) | Recipe CRUD | All paths 404 |
| [audiences-segments-api.md](audiences-segments-api.md) | Audiences/segments | All paths 404 |
| [scheduled-sources-api.md](scheduled-sources-api.md) | Scheduled source/cron management | All paths 404 |
| [crm-integrations-api.md](crm-integrations-api.md) | CRM integration management | All paths 404 |
| [website-tracking-api.md](website-tracking-api.md) | Website tracking/intent | All paths 404 |
| [notifications-api.md](notifications-api.md) | Notifications | All paths 404 |
| [search-api.md](search-api.md) | Search endpoint | All paths 404 |
| [workflows-api.md](workflows-api.md) | Legacy `/v3/workflows`+`/v3/claygent` | Still 404 — **SUPERSEDED**: tc-workflows has a full API surface (INV-023..INV-026) |
| [activity-audit-billing.md](activity-audit-billing.md) | Activity log, audit, billing, quotas, limits, access | All 404 or 403 (admin-only) |
