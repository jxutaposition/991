# Prompt: Endpoint Probe

## Objective

Systematically test a specific v3 API endpoint to fully document its behavior: required parameters, optional parameters, error responses, edge cases, and rate limits.

## Prerequisites

- Read `../AGENT.md` for conventions and safety rules
- Read `../../knowledge/internal-v3-api.md` for known auth mechanics
- Valid Clay session cookies (use `../scripts/extract-session.ts` to obtain)
- A scratch Clay table for testing (do NOT test against production tables)

## Parameters

Before starting, define:
- **Target endpoint**: The API path to probe (e.g., `POST /v3/tables/{tableId}/fields`)
- **Known shape**: What we already know from endpoints.jsonl
- **Questions**: What specifically we're trying to learn

## Method

### Step 1: Baseline Call

Make a known-good request to confirm the endpoint works with current session:

```typescript
const response = await fetch('https://api.clay.com/v3/tables/{tableId}', {
  headers: {
    'Cookie': sessionCookies,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Clay-Frontend-Version': clayVersion
  }
});
```

### Step 2: Parameter Enumeration

For POST/PATCH/PUT endpoints, test systematically:

1. **Minimal payload**: What's the absolute minimum required?
2. **Full payload**: What additional optional fields are accepted?
3. **Wrong types**: What happens with string instead of number, etc.?
4. **Missing required fields**: Which fields cause 400 errors?
5. **Extra unknown fields**: Does Clay reject or ignore unknown fields?
6. **Boundary values**: Empty strings, very long strings, special characters

For GET endpoints:
1. **Query parameters**: Try common params (limit, offset, filter, sort, fields)
2. **Invalid IDs**: What error for nonexistent table/field/source IDs?
3. **Wrong format IDs**: What if the ID doesn't match expected pattern?

### Step 3: Error Response Catalog

Document every distinct error response:

```json
{
  "scenario": "missing required field 'name'",
  "status_code": 400,
  "response_body": {"error": "...", "message": "..."},
  "notes": "..."
}
```

### Step 4: Rate Limit Testing (Careful)

Only if explicitly investigating rate limits:

1. Start with 1 request per second
2. Gradually increase to 2/s, 5/s, 10/s
3. Watch for 429 responses or connection resets
4. Stop immediately on any sign of rate limiting
5. Document the threshold

## Output

1. **Update endpoints.jsonl**: Refine the request_shape and response_shape
2. **Write investigation findings**: Add to the relevant INV-XXX file
3. **Update capabilities.md**: If the probe confirms or denies a capability

## Template: Probe Report

```markdown
### Endpoint: {METHOD} {PATH}

**Probed**: {date}
**Session**: Valid (confirmed via baseline call)

#### Minimum Required Payload
{json}

#### Full Accepted Payload
{json}

#### Response Shape (Success)
{json}

#### Error Responses
| Scenario | Status | Body |
|----------|--------|------|
| ... | ... | ... |

#### Rate Limit Observations
{notes or "not tested"}

#### Unexpected Behaviors
{anything surprising}
```
