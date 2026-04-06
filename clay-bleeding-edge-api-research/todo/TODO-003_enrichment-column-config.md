# TODO-003: Create Enrichment Columns Programmatically

**Priority:** P1 — Core Clay value prop is enrichments
**Status:** Open
**Related Gap:** GAP-019

## Problem

We can create text/formula/source columns, but creating an **action (enrichment) column** requires the `actionPackageDefinition` field — a string whose format we don't know. Without this, we can't programmatically set up enrichment pipelines.

## What We Know

- `POST /v3/tables/{tableId}/fields` works for type=text, formula, source
- Action columns require `actionPackageDefinition` — likely a serialized config string
- `GET /v3/actions` returns all 1,191 actions with full I/O schemas
- `POST /v3/actions` can create action packages (but format unknown)
- `GET /v3/app-accounts` gives us authAccountIds needed for enrichment auth
- We have all the pieces *except* the assembly format

## Investigation Plan

1. **CDP intercept**: Watch what payload is sent when user manually adds an enrichment column in the UI
2. **Existing column inspection**: Read schema of a table that already has enrichment columns — the field definition may contain the `actionPackageDefinition` in readable form
3. **Actions API probing**: Try creating an action package via `POST /v3/actions` with various payload shapes and inspect the response
4. **Cross-reference Claymate**: Claymate's `importSchema` function handles enrichment columns — its source code may reveal the format

## Success Criteria

- Can create an enrichment column (e.g., "Find person's email using Prospeo") entirely via API
- Document the `actionPackageDefinition` format
- Can wire up authAccountId, input mappings, and output field configuration
