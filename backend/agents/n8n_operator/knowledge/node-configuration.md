# n8n Node Configuration

## Principles
- **Operation-aware**: `resource` + `operation` determine required fields. Different ops = different requirements.
- **displayOptions**: fields show/hide based on other values (e.g., `sendBody` only appears when method=POST)
- **Progressive disclosure**: start minimal, add complexity as needed

## Discovery Flow
1. Inspect existing workflows via `GET /api/v1/workflows/{id}` using `http_request` — find a workflow using the same node type and check its configuration
2. Stuck on a field → check the n8n documentation or create a minimal test workflow to discover valid values
3. Still insufficient → list all workflows with `GET /api/v1/workflows` and find additional examples

## Configuration Statistics
- Average 18s search → inspect workflow
- Average 56s between configuration edits
- Typically 2-3 validation cycles per configuration

## Iteration Pattern
Minimal config → test run via `POST /api/v1/workflows/{id}/run` → add fields the test demands → repeat (2-3 rounds typical)

## Anti-patterns
- Dumping every optional field upfront
- Deploying without validation
- Changing operation without re-checking required fields
- Fighting auto-sanitization for IF/Switch operators

---

## Common Node Configuration Patterns

### HTTP Request (nodes-base.httpRequest)

**GET**:
```javascript
{method: "GET", url: "https://api.example.com/users", authentication: "none"}
```

**GET with query params**:
```javascript
{method: "GET", url: "https://api.example.com/search", sendQuery: true,
  queryParameters: {parameters: [{name: "limit", value: "100"}, {name: "offset", value: "={{$json.offset}}"}]}}
```

**POST with JSON** — remember `sendBody: true`!:
```javascript
{method: "POST", url: "https://api.example.com/users", authentication: "none",
  sendBody: true, body: {contentType: "json", content: {name: "={{$json.name}}", email: "={{$json.email}}"}}}
```

**PUT/PATCH**: Same as POST with different method.
**DELETE**: Usually no body: `{method: "DELETE", url: ".../{id}", authentication: "none"}`

**With authentication**:
```javascript
{method: "GET", url: "...", authentication: "predefinedCredentialType", nodeCredentialType: "httpHeaderAuth"}
```

**Gotcha**: `sendBody: true` required for POST/PUT/PATCH!

---

### Webhook (nodes-base.webhook) — 813 searches!

**Basic**:
```javascript
{path: "my-webhook", httpMethod: "POST", responseMode: "onReceived"}
```

**With auth**:
```javascript
{path: "secure-webhook", httpMethod: "POST", responseMode: "onReceived", authentication: "headerAuth"}
```

**Return data from workflow**:
```javascript
{path: "my-webhook", httpMethod: "POST", responseMode: "lastNode",
  options: {responseCode: 201, responseHeaders: {entries: [{name: "Content-Type", value: "application/json"}]}}}
```

**CRITICAL GOTCHA**: Webhook data is under `$json.body`, not `$json`!

---

### Slack (nodes-base.slack)

**Post message**:
```javascript
{resource: "message", operation: "post", channel: "#general", text: "Hello!"}
```

**Dynamic content**:
```javascript
{resource: "message", operation: "post", channel: "={{$json.channel}}", text: "New user: {{$json.name}} ({{$json.email}})"}
```

**Update message** (requires messageId):
```javascript
{resource: "message", operation: "update", messageId: "1234567890.123456", text: "Updated content"}
```

**Create channel** (lowercase, no spaces, 1-80 chars):
```javascript
{resource: "channel", operation: "create", name: "new-project", isPrivate: false}
```

**Gotchas**: Channel must start with `#` for public or use channel ID. Enums are case-sensitive (`"message"` not `"Message"`).

---

### Gmail (nodes-base.gmail)

**Send**:
```javascript
{resource: "message", operation: "send", to: "={{$json.email}}",
  subject: "Order #{{$json.orderId}}", message: "Dear {{$json.name}},\n\nConfirmed.\n\nThank you!",
  options: {ccList: "admin@example.com"}}
```

**Get emails**:
```javascript
{resource: "message", operation: "getAll", returnAll: false, limit: 50,
  filters: {q: "is:unread from:important@example.com", labelIds: ["INBOX"]}}
```

---

### Postgres (nodes-base.postgres) — 456 templates

**SELECT** (always use parameterized queries for user input!):
```javascript
{operation: "executeQuery", query: "SELECT * FROM users WHERE email = $1 AND active = $2",
  additionalFields: {mode: "list", queryParameters: "={{$json.email}},true"}}
```

**INSERT**:
```javascript
{operation: "insert", table: "users", columns: "name,email",
  additionalFields: {mode: "list", queryParameters: "={{$json.name}},={{$json.email}}"}}
```

**Gotcha**: NEVER use `'{{$json.email}}'` directly in SQL — SQL injection risk! Always parameterize.

---

### Set (nodes-base.set) — 68% of workflows!

```javascript
{mode: "manual", duplicateItem: false, assignments: {assignments: [
  {name: "fullName", value: "={{$json.firstName}} {{$json.lastName}}", type: "string"},
  {name: "timestamp", value: "={{$now.toISO()}}", type: "string"},
  {name: "count", value: 100, type: "number"}
]}}
```

**Gotcha**: Use correct `type` per field! `"25"` (string) ≠ `25` (number).

---

### Code (nodes-base.code) — 42% of workflows

**All Items**:
```javascript
{mode: "runOnceForAllItems", jsCode: "return $input.all().map(item => ({json: {name: item.json.name.toUpperCase()}}));"}
```

**Each Item**:
```javascript
{mode: "runOnceForEachItem", jsCode: "return [{json: {...$input.item.json, processed: true}}];"}
```

**Gotcha**: In Code nodes, use `$input.item.json` not `{{...}}`!

---

### IF (nodes-base.if) — 38% of workflows

**String equals** (binary):
```javascript
{conditions: {string: [{value1: "={{$json.status}}", operation: "equals", value2: "active"}]}}
```

**isEmpty** (unary — no value2):
```javascript
{conditions: {string: [{value1: "={{$json.email}}", operation: "isEmpty"}]}}
// singleValue: true added by auto-sanitization
```

**Number comparison**:
```javascript
{conditions: {number: [{value1: "={{$json.age}}", operation: "larger", value2: 18}]}}
```

**Multiple conditions (AND/OR)**:
```javascript
{conditions: {string: [{value1: "={{$json.status}}", operation: "equals", value2: "active"}],
  number: [{value1: "={{$json.age}}", operation: "larger", value2: 18}]},
  combineOperation: "all"}  // "all" = AND, "any" = OR
```

**Gotcha**: Unary operators (isEmpty, isNotEmpty, true, false) don't need value2!

---

### Switch (nodes-base.switch) — 18% of workflows

```javascript
{mode: "rules", rules: {rules: [
  {conditions: {string: [{value1: "={{$json.status}}", operation: "equals", value2: "active"}]}},
  {conditions: {string: [{value1: "={{$json.status}}", operation: "equals", value2: "pending"}]}}
]}, fallbackOutput: "extra"}
```

**Gotcha**: Number of rules must match number of outputs!

---

### OpenAI (nodes-langchain.openAi) — 234 templates

```javascript
{resource: "chat", operation: "complete", messages: {values: [
  {role: "system", content: "You are a helpful assistant."},
  {role: "user", content: "={{$json.userMessage}}"}
]}, options: {temperature: 0.7, maxTokens: 500}}
```

---

### Schedule Trigger (nodes-base.scheduleTrigger) — 28% have these

**Daily at time** — always set timezone!:
```javascript
{rule: {interval: [{field: "hours", hoursInterval: 24}], hour: 9, minute: 0, timezone: "America/New_York"}}
```

**Every N minutes**:
```javascript
{rule: {interval: [{field: "minutes", minutesInterval: 15}]}}
```

**Cron**:
```javascript
{mode: "cron", cronExpression: "0 */2 * * *", timezone: "America/New_York"}
```

**Gotcha**: Always set timezone explicitly!

---

## Key Gotchas Summary

| Node | Gotcha |
|------|--------|
| HTTP Request | `sendBody: true` for POST/PUT/PATCH |
| Webhook | Data under `$json.body`, not root |
| Slack | Channel format `#name` or ID; enums case-sensitive |
| Postgres | Parameterized queries, never inline `{{}}` in SQL |
| Set | Correct `type` per field |
| Code | No `{{}}`, use direct JS/Python |
| IF/Switch | Unary vs binary operators |
| Schedule | Explicit timezone |
