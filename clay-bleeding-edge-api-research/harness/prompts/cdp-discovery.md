# Prompt: CDP API Discovery Sprint

## Objective

Intercept all HTTP requests to `api.clay.com/*` during a full Clay user workflow and catalog every endpoint, request shape, and response shape. This is the foundational research that maps Clay's full internal API surface.

## Prerequisites

- Read `../AGENT.md` for conventions and safety rules
- Read `../../knowledge/internal-v3-api.md` for known endpoints
- Read `../../registry/endpoints.jsonl` for current catalog
- Access to a Clay account with at least one table
- Playwright available (see `../../e2e/`)

## Setup

Use `../scripts/intercept-clay-api.ts` as the base script, or build a Playwright session with CDP interception:

```typescript
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const client = await context.newCDPSession(await context.newPage());

await client.send('Network.enable');
client.on('Network.requestWillBeSent', (params) => {
  if (params.request.url.includes('api.clay.com')) {
    // Log: method, url, headers, postData
  }
});
client.on('Network.responseReceived', (params) => {
  if (params.response.url.includes('api.clay.com')) {
    // Log: status, headers
    // Use Network.getResponseBody to get response content
  }
});
```

## Workflow to Execute

Perform each of these operations in Clay while intercepting network traffic. Wait 2-3 seconds between operations to clearly separate API calls.

### Phase 1: Navigation and Reading
1. Load the Clay workspace home/dashboard (observe: how are tables listed?)
2. Navigate to an existing table (observe: what loads?)
3. Scroll through rows (observe: pagination?)
4. Click a column header (observe: what metadata loads?)
5. Click a cell to select it (observe: does the formula bar make API calls?)
6. Switch between grid views if available (observe: view-specific calls?)

### Phase 2: Column Operations
7. Add a new text column (observe: field creation call)
8. Add a formula column referencing the text column (observe: formula with field reference)
9. Rename a column (observe: field update call)
10. Delete the formula column (observe: field deletion call)
11. Delete the text column (observe: same or different?)

### Phase 3: Row Operations
12. Add a row manually (observe: row creation call)
13. Edit a cell value (observe: cell update call)
14. Delete a row (observe: row deletion call)

### Phase 4: Table Lifecycle
15. Create a new table from scratch (observe: table creation call)
16. Rename the new table (observe: table update call)
17. Create a webhook source on the new table (observe: source creation)
18. Delete the new table (observe: table deletion call)

### Phase 5: Workbook Operations
19. Create a new workbook (if UI allows from this context)
20. Navigate between workbooks

### Phase 6: Settings/Configuration
21. Open table settings (observe: settings-related calls)
22. Open column configuration modal (observe: config reading calls)

## Output Format

For EACH intercepted request to `api.clay.com`:

```json
{
  "method": "GET|POST|PATCH|PUT|DELETE",
  "path": "/v3/...",
  "triggered_by": "description of what UI action triggered this",
  "request_headers": {"relevant headers"},
  "request_body": "abbreviated request body or null",
  "response_status": 200,
  "response_body": "abbreviated response body",
  "notes": "observations"
}
```

## Deliverables

1. **Raw intercept log**: Save to `../results/cdp-discovery-{date}.json`
2. **New endpoints**: Add to `../../registry/endpoints.jsonl`
3. **Investigation report**: Write to `../../investigations/INV-001_v3-endpoint-catalog.md`
4. **Capability updates**: Update `../../registry/capabilities.md` with confirmed/denied capabilities
5. **Gap updates**: Remove resolved gaps, add newly discovered gaps to `../../registry/gaps.md`

## Tips

- Watch for requests that happen on page load vs. on user action
- Note the order of API calls for multi-step operations (e.g., source creation may be 2+ calls)
- Pay attention to query parameters on GET requests
- Watch for WebSocket connections (may be used for real-time updates)
- If you see versioned paths (v1, v2, v3, v4), document all versions
- Some requests may go to subdomains or different base URLs
