# TODO-052: Enrichment Result Extraction via Formulas

**Priority:** P0 — The bridge between enrichment and usable data
**Status:** Open

## Concept

Enrichment cells store results as JSON but display preview strings ("✅ Anthropic"). The `attributeProviderPathMap` we discovered maps provider outputs to specific JSON paths (e.g., `"email[0].email"`).

Can formulas extract structured data from enrichment results?

## Investigation Plan — VERY CHEAP (1-2 enrichments max)

1. Run normalize-company-name on 1 row
2. Create formula: `{{f_enrichCol}}` — what does the raw value look like in a formula?
3. Create formula: `{{f_enrichCol}}?.original_name` — JSON path extraction
4. Create formula: `JSON.stringify({{f_enrichCol}})` — full dump
5. Create formula: `typeof {{f_enrichCol}}` — is it string or object?
6. Document whether enrichment results are accessible as objects in formulas
7. If yes: this means ANY enrichment result can be decomposed into individual columns via formulas
