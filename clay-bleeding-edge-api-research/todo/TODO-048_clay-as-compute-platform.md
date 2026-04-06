# TODO-048: Clay as a Serverless Compute Platform

**Priority:** P0 — Game-changing capability
**Status:** Open

## Concept

The HTTP API action (`http-api-v2`) can call ANY URL with ANY method/headers/body. Combined with autoRun, this means:

**Insert row → Clay automatically calls your endpoint with the row data → response stored in cell**

This turns Clay into a serverless function orchestrator. Your "function" is any HTTP endpoint. Clay handles:
- Scheduling (autoRun on new rows)
- Retry logic (built-in retry settings)
- Rate limiting (per-action rate limit rules)
- Auth management (via app-accounts)
- Result storage (in the enrichment cell)
- Error tracking (metadata.status)

## Investigation Plan

1. Create a table with an HTTP API action column pointing to httpbin.org/post
2. Configure inputsBinding to send row data as the request body
3. Insert a row → does autoRun trigger the HTTP call?
4. Read back the cell → what does the response look like?
5. Test with different HTTP methods (GET, PUT, DELETE)
6. Test error handling (point to a 500 endpoint)
7. Test timeout behavior
8. Can we chain: HTTP action A returns data → formula extracts field → HTTP action B uses it?
