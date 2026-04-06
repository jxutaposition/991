# Clay API — TODO Tracker

Things we **cannot** do programmatically today that block a fully autonomous Clay table-building agent. We work through these relentlessly until every box is checked.

## Priority Legend
- **P0** — Blocks core read/write loop. Agent is crippled without this.
- **P1** — Blocks important automation workflows. Agent can limp along.
- **P2** — Nice to have. Agent works but with manual workarounds.

## Status
- [x] [TODO-001: Read rows from a table](TODO-001_read-rows.md) — **P0** — RESOLVED: `GET /v3/tables/{id}/views/{viewId}/records`
- [ ] [TODO-002: Export/download table data as CSV](TODO-002_export-csv.md) — **P1**
- [ ] [TODO-003: Create enrichment columns programmatically](TODO-003_enrichment-column-config.md) — **P1**
- [ ] [TODO-004: Monitor enrichment completion](TODO-004_enrichment-completion.md) — **P1**
- [ ] [TODO-005: Access enrichment error states](TODO-005_enrichment-errors.md) — **P2**
- [ ] [TODO-006: Trigger formula re-evaluation](TODO-006_formula-reeval.md) — **P2**
- [ ] [TODO-007: Discover real-time update channel](TODO-007_realtime-updates.md) — **P2**
- [ ] [TODO-008: Bulk field creation](TODO-008_bulk-fields.md) — **P2**
- [ ] [TODO-009: Row pagination for large tables](TODO-009_pagination.md) — **P1** (emerged from TODO-001)

## Attack Strategy

**TODO-001 is RESOLVED** — row reading works via `GET /v3/tables/{id}/views/{viewId}/records`. The agent now has full read/write capability.

**Next priority stack:**
1. **TODO-003 (enrichment column config)** — This is the core Clay value prop. Without programmatic enrichment setup, users still need to manually configure columns in the UI. CDP intercept during manual column creation is the attack vector.
2. **TODO-004 (enrichment completion)** — Knowing when enrichments finish enables chaining and verification. Likely solved by TODO-007 (real-time channel discovery).
3. **TODO-009 (pagination)** — Needed for large tables. Test large `limit` values first (simplest fix), then CDP intercept scroll behavior.
4. **TODO-002 (CSV export)** — Less urgent now that row reads work, but still useful for bulk data extraction.
5. **TODO-005/006/007/008** — Nice to haves, investigate opportunistically.
