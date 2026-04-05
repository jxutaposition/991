# n8n Validation

## Severity Levels

### Errors (block execution — must fix)
- `missing_required` (45%) — required field not provided
- `invalid_value` (28%) — wrong enum value, typo, wrong format
- `type_mismatch` (12%) — wrong data type (string vs number)
- `invalid_expression` (8%) — broken `{{}}` syntax, missing braces, wrong paths
- `invalid_reference` (5%) — referenced node doesn't exist

### Warnings (advisory — should review)
- `best_practice` — no error handling, no retry logic
- `deprecated` — old typeVersion
- `performance` — unbounded query, no rate limiting

### Suggestions (optional)
- Optimization opportunities, alternatives

---

## Validation Profiles

| Profile | Purpose | Use When |
|---------|---------|----------|
| `minimal` | Quick required-field pass | Testing connections |
| `runtime` | **Recommended for pre-deploy** | Most use cases |
| `ai-friendly` | Less noise (~60% fewer false positives) | AI-configured workflows |
| `strict` | Everything + best practices | Production hardening |

**Strategy**: Use `ai-friendly` during development → `runtime` pre-deploy → `strict` for production.

---

## Error Catalog with Examples

### missing_required — Most Common

**Slack missing channel**:
```javascript
// ❌ {resource: "message", operation: "post"}
// ✅ {resource: "message", operation: "post", channel: "#general"}
```

**HTTP missing URL**:
```javascript
// ❌ {method: "GET", authentication: "none"}
// ✅ {method: "GET", authentication: "none", url: "https://api.example.com/data"}
```

**POST missing body** (conditional: required when sendBody=true):
```javascript
// ❌ {method: "POST", url: "...", sendBody: true}
// ✅ {method: "POST", url: "...", sendBody: true, body: {contentType: "json", content: {...}}}
```

**Fix pattern**: Inspect existing workflows via `GET /api/v1/workflows/{id}` to find required fields for the current resource+operation.

### invalid_value

**Wrong operation name**:
```javascript
// ❌ {resource: "message", operation: "send"}   // should be "post"
// ✅ {resource: "message", operation: "post"}
```

**Case-sensitive enums**:
```javascript
// ❌ {resource: "Message"}   // capital M
// ✅ {resource: "message"}   // lowercase
```

**Fix pattern**: Check allowed values from the error message or inspect a working workflow's node configuration.

### type_mismatch

```javascript
// ❌ String instead of number
{limit: "100"}  →  {limit: 100}

// ❌ String instead of boolean
{sendHeaders: "true"}  →  {sendHeaders: true}

// ❌ Object instead of array
{tags: {"tag": "important"}}  →  {tags: ["important"]}
```

### invalid_expression

**Missing braces**: `$json.name` → `={{$json.name}}`
**Typo in node name**: `$node['HTTP Requets']` → `$node['HTTP Request']`
**Wrong path**: `$json.data.user.name` when structure doesn't exist → add `?.` or check path
**Webhook data**: `$json.email` → `$json.body.email`

### invalid_reference

**Deleted/renamed node**: Update expression to current node name.
**Stale connections**: Use `cleanStaleConnections` operation.
**Suggestions**: Error may suggest similar names ("did you mean 'Weather API'?").

---

## Auto-sanitization (runs on workflow save)

**What it fixes automatically** — don't fight it:
- Binary IF/Switch operators → strips erroneous `singleValue`
- Unary operators (isEmpty, isNotEmpty) → sets `singleValue: true`

**What it does NOT fix**:
- Broken connections
- Switch rule/output count mismatches
- Corrupt state

---

## False Positives — When Warnings Are Acceptable

### Missing Error Handling
- ✅ OK for: dev/testing workflows, non-critical notifications, manual-trigger workflows (user watching)
- ❌ Fix for: production automation, critical integrations, payment processing

### No Retry Logic
- ✅ OK for: APIs with built-in retry, idempotent GET requests, local/internal services
- ❌ Fix for: flaky external APIs, non-idempotent operations

### Unbounded Queries
- ✅ OK for: small known datasets (<100 rows), aggregation queries (COUNT/SUM), dev/testing
- ❌ Fix for: production queries on large tables

### Missing Input Validation
- ✅ OK for: internal webhooks (your backend validates), trusted sources (Stripe signed webhooks)
- ❌ Fix for: public webhooks

### Known n8n False Positives
- **Issue #304**: IF node metadata warning — metadata added on save, ignore
- **Issue #306**: Switch branch count — false positive when using fallback mode
- **Issue #338**: Credential validation in test mode — credentials validated at runtime

**Golden Rule**: If you accept a warning, document WHY.

---

## Decision Framework for Warnings

```
Security warning? → Always fix
Production workflow? → Fix (probably)
Handles critical data? → Fix
Known workaround exists? → Acceptable if documented
Dev/testing? → Usually acceptable
```

---

## Recovery Patterns

### Progressive Validation
When too many errors: start with minimal valid config, add features one by one, validate after each addition.

```
Step 1: Minimal config → update workflow via PUT → test run via POST /api/v1/workflows/{id}/run
  config = {resource: "message", operation: "post", channel: "#general", text: "Hello"}

Step 2: Add features incrementally → update workflow → test run again
  Add attachments, blocks, etc. one at a time
```

### Error Triage
1. Fix all **errors** first (blocking)
2. Review each **warning** (fix for production, acceptable for dev)
3. Consider **suggestions** (optional optimization)

### Workflow-level Validation
Checks: connections between nodes, expression validity, graph issues (cycles, multiple triggers, disconnected nodes)

### Auto-fix
`n8n_autofix_workflow` — preview first, then apply. Also `cleanStaleConnections` for orphaned connections.

---

## Validation Loop (from production data)

Average workflow: configure (56s) → validate (23s thinking) → fix → validate again (58s fixing) → 2-3 rounds total

The iteration is normal and expected — don't try to get it perfect on first attempt.
