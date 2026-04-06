# TODO-005: Access Enrichment Error States

**Priority:** P2 — Important for reliability, not blocking
**Status:** Open
**Related Gap:** GAP-013

## Problem

When enrichments fail (bad input, provider error, credit exhaustion), Clay shows error indicators in the UI. We have no API access to these error states.

## What We Know

- Clay UI shows red error indicators on failed cells
- DOM selectors for error states documented in `knowledge/clay-dom-structure.md`
- No v3 endpoint known for error retrieval

## Investigation Plan

1. If TODO-001 (row reads) is solved, check if error state is included in cell data
2. CDP intercept when hovering over an error cell in the UI
3. Try `GET /v3/tables/{tableId}/errors` or similar
4. Fallback: Playwright DOM scraping of error indicators

## Success Criteria

- Can retrieve error message/code for failed enrichments per row
- Can distinguish "not yet run" from "ran and failed" from "succeeded"
