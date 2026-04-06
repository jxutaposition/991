# TODO-008: Bulk Field Creation

**Priority:** P2
**Status:** Open
**Related Gap:** GAP-016

## Problem

Creating columns is one-at-a-time via `POST /v3/tables/{tableId}/fields`. For tables with 20+ columns, this means 20+ sequential API calls.

## What We Know

- Single field creation works reliably
- No rate limiting detected (50 req/s tested) so sequential calls are fast
- Claymate's `importSchema` creates fields one at a time with dependency ordering

## Investigation Plan

1. Try sending an array in the body: `{fields: [{...}, {...}]}`
2. CDP intercept during Claymate schema import to see if it batches
3. If no bulk endpoint exists, the workaround is fine — 20 calls at 21ms avg = <500ms total

## Success Criteria

- Determine if bulk creation is possible
- If not, document that sequential is the only path (and it's fast enough)
