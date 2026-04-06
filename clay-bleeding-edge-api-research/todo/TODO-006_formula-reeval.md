# TODO-006: Trigger Formula Re-evaluation

**Priority:** P2
**Status:** Open
**Related Gap:** GAP-012

## Problem

Formula columns compute values based on other columns. If we update a cell that a formula depends on, we don't know if/how to force the formula to recalculate via API.

## What We Know

- Formula columns can be created via `POST /v3/tables/{tableId}/fields` with type=formula
- Formulas may auto-evaluate on cell change (needs verification)
- No explicit "recalculate" endpoint known

## Investigation Plan

1. Create a formula column, write a row, read back (once TODO-001 solved) — check if formula auto-evaluated
2. If not, try `PATCH /v3/tables/{tableId}/run` with the formula field's fieldId
3. CDP intercept when formula recalculates in UI

## Success Criteria

- Understand if formulas auto-evaluate or need manual trigger
- If manual trigger needed, document the endpoint
