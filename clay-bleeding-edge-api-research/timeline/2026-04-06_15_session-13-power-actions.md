# Session 13: Power Actions — AI, Scraping, Lookups, Route-Row Pipeline

**Date**: 2026-04-06
**Investigation**: INV-030
**Credit cost**: ~3 (scrape + route-row + normalize from earlier; AI didn't execute)

## Results

### scrape-website — FULLY WORKING (TODO-057 RESOLVED)

`scrape-website` action column auto-runs on row insert, returns structured data with 12 fields:

```json
Keys: ["links", "title", "emails", "images", "favicon", "bodyText", "description", 
       "socialLinks", "phoneNumbers", "specificVendor", "extractedKeywords", "languagesDetectedFormatted"]
```

Formula extraction works perfectly:
- `{{f_scrapeCol}}?.title` → "Home \ Anthropic"
- `{{f_scrapeCol}}?.description` → "Anthropic is an AI safety and research company..."
- `{{f_scrapeCol}}?.emails` → `[]`

**Practical use**: Insert company URLs → auto-scrape → extract title/description/emails/phone via formulas into individual columns.

### Route-Row End-to-End Pipeline — FULLY WORKING

Complete flow verified:
1. Created source table with Company + URL columns
2. Created route-row column targeting destination table
3. Enabled autoRun
4. Inserted row → route-row auto-triggered → row delivered to destination table
5. Destination got `Company: "Anthropic"`, `URL: "https://anthropic.com"` via auto-created formula columns

Route-row value in source table: `"✅ Sent"` with `metadata.status: "SUCCESS"`

### use-ai — Column Created but Didn't Execute

Both `use-ai` columns created successfully (200) with `gpt-4o-mini` model, but after 15s polling both showed `status: undefined, value: undefined`. The action wasn't in `runHistory`. Possible issues:
- May require `use-ai` specific credits or billing plan gate
- May not support autoRun (needs explicit `PATCH /run`)
- May need different model name
- May have longer execution time

**Status**: TODO-054 still open — column creation works, execution needs investigation.

### Cross-Table Lookup — ERROR_INVALID_INPUT

`lookup-field-in-other-table-new-ui` column created but returned `ERROR_INVALID_INPUT`. The `DOMAIN()` function returns undefined for some URLs (known from Session 11). Need to use a simpler lookup value (exact match on domain string).

**Status**: TODO-056 still open — column creation works, input binding needs adjustment.

## New Behavioral Insights

- `scrape-website` returns an object with 12 named fields — fully decomposable via formulas
- Route-row + autoRun is sub-second: insert → trigger → deliver happens before the 15s poll completes  
- Actions that fail to execute show `status: undefined` (not ERROR) — they simply don't appear in runHistory
- Destination table formula columns include `metadata.sourceId` and `metadata.originKey: "row"` for provenance tracking
