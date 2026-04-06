# INV-001: v3 Endpoint Catalog

**Status**: not-started
**Priority**: P0
**Gap**: GAP-001 (Full v3 Endpoint Catalog)
**Date started**: --
**Date completed**: --

## Hypothesis

Clay's frontend makes dozens of API calls to `api.clay.com/v3` during normal usage. We currently know only 4 endpoints (from Claymate Lite). A CDP interception sprint should reveal the full internal API surface, including endpoints for table creation, deletion, workspace listing, row operations, and enrichment configuration.

## Method

1. Use `harness/scripts/intercept-clay-api.ts` to launch a CDP-instrumented browser session
2. Authenticate to Clay
3. Perform the full workflow described in `harness/prompts/cdp-discovery.md`:
   - Navigate workspace home (table listing)
   - Open an existing table
   - Column operations (add, rename, delete)
   - Row operations (add, edit, delete)
   - Table lifecycle (create, rename, delete)
   - Source/webhook management
   - Settings and configuration
4. Catalog every intercepted `api.clay.com` request

## Findings

*Not yet started. Findings will be documented here with request/response examples.*

## New Endpoints Discovered

*Will be added to `registry/endpoints.jsonl` as discovered.*

## Implications

*How discoveries affect the architecture design and tool specifications.*

## Next Steps

*Follow-up investigations based on findings.*
