# Prompt: Capability Expansion

## Objective

Explore new ways to interact with Clay tables beyond what's currently documented. Look for undiscovered endpoints, alternative approaches, hidden features, and novel interaction patterns.

## Prerequisites

- Read `../AGENT.md` for conventions and safety rules
- Read `../../registry/capabilities.md` for current coverage
- Read `../../registry/gaps.md` for known unknowns
- Access to Clay with session cookies and API key

## Exploration Vectors

### 1. v3 API Path Enumeration

Try variations of known endpoint patterns:

```
Known: GET /v3/tables/{tableId}
Try:   GET /v3/tables
Try:   GET /v3/tables?workspaceId={id}
Try:   GET /v3/workspaces
Try:   GET /v3/workspaces/{id}
Try:   GET /v3/workspaces/{id}/tables
Try:   GET /v3/me
Try:   GET /v3/user
Try:   GET /v3/account
Try:   GET /v3/settings

Known: POST /v3/tables/{tableId}/fields
Try:   GET /v3/tables/{tableId}/fields
Try:   GET /v3/tables/{tableId}/fields/{fieldId}
Try:   PATCH /v3/tables/{tableId}/fields/{fieldId}
Try:   DELETE /v3/tables/{tableId}/fields/{fieldId}
Try:   POST /v3/tables/{tableId}/fields/bulk

Known: POST /v3/sources
Try:   GET /v3/sources
Try:   PATCH /v3/sources/{sourceId}
Try:   DELETE /v3/sources/{sourceId}
Try:   GET /v3/tables/{tableId}/sources
```

For each, note: 200 (found!), 404 (doesn't exist), 405 (method not allowed -- path exists but wrong method), 401 (auth issue), 403 (forbidden).

### 2. API Version Exploration

Clay uses v3 for the frontend. But other versions may exist:

```
GET /v1/tables/{tableId}    # known
GET /v2/tables/{tableId}    # exists?
GET /v3/tables/{tableId}    # known
GET /v4/tables/{tableId}    # exists?
GET /api/v1/tables/{tableId}  # known (different path prefix)
GET /api/v2/tables/{tableId}  # exists?
```

### 3. Response Header Mining

Check response headers for hints:

- `X-RateLimit-*` headers for rate limit info
- `X-Request-Id` or correlation headers
- `Link` headers for pagination
- `X-Version` or API versioning headers
- `Set-Cookie` for session management hints
- CORS headers for allowed methods/origins

### 4. Error Message Mining

Intentionally malformed requests often reveal endpoint structure in error messages:

```
POST /v3/tables/invalid/fields
→ Error might reveal: "table not found" vs "invalid table ID format"

POST /v3/tables/{tableId}/fields with wrong type
→ Error might list valid types

POST /v3/tables/{tableId}/fields with partial payload
→ Error might list required fields
```

### 5. GraphQL / Alternative Protocols

Check if Clay uses GraphQL alongside REST:

```
POST /graphql
POST /v3/graphql
POST /api/graphql
```

### 6. WebSocket Connections

Monitor for WebSocket connections during page load and enrichment runs:

```typescript
page.on('websocket', ws => {
  ws.on('framereceived', frame => {
    console.log('WS received:', frame.payload);
  });
  ws.on('framesent', frame => {
    console.log('WS sent:', frame.payload);
  });
});
```

### 7. Search Web for New Community Tools

Search for:
- "clay.com API" (new discussions since last check)
- "clay chrome extension" (new extensions)
- "clay mcp" (new MCP servers for Clay GTM)
- "clay automation" (new integration patterns)
- "clay developer" (API announcements)
- GitHub: "clay" + "api" (new repos)

## Safety Rules

- **Rate limit exploration requests**: 1 per second maximum for unknown endpoints
- **Stop on 429**: Back off immediately if rate limited
- **Don't brute-force**: Use intelligent guessing based on known patterns, not exhaustive enumeration
- **Document everything**: Even 404s are useful data (confirms an endpoint doesn't exist)

## Output

1. **New endpoints**: Add to `../../registry/endpoints.jsonl` (even untested/suspected ones)
2. **Capability updates**: Update `../../registry/capabilities.md`
3. **New gaps**: Add to `../../registry/gaps.md` if new questions arise
4. **Changelog**: Add entry to `../../registry/changelog.md`
5. **Investigation**: Write findings to appropriate `../../investigations/INV-XXX_*.md`
