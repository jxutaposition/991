# TODO-056: Cross-Table Lookup Actions

**Priority:** P1 — SQL-like JOINs between Clay tables
**Status:** Open

## Concept

Actions like `lookup-row-in-other-table`, `lookup-multiple-rows-in-other-table`, `lookup-field-in-other-table-new-ui` enable cross-table JOINs. These are Clay-internal (no external API), likely free or cheap.

## Investigation Plan (0-1 credits)

1. Create Table A with companies, Table B with contacts
2. Create a lookup action column on B that references A by domain field
3. Test: does it find matching rows?
4. What does the result cell contain — the full matching row? Just the value?
5. Test multi-row lookup — what format are multiple matches returned in?
