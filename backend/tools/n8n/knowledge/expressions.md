# n8n Expression Syntax

## Expression Format

All dynamic content uses **double curly braces**: `{{expression}}`

```
✅ {{$json.email}}
✅ {{$json.body.name}}
✅ {{$node["HTTP Request"].json.data}}
❌ $json.email  (no braces — literal text)
❌ {$json.email}  (single braces — invalid)
```

## Core Variables

### $json — Current Node Output
```javascript
{{$json.fieldName}}
{{$json['field with spaces']}}
{{$json.nested.property}}
{{$json.items[0].name}}
```

### $node — Reference Other Nodes
```javascript
{{$node["Node Name"].json.fieldName}}
{{$node["HTTP Request"].json.data}}
{{$node["Webhook"].json.body.email}}
```
- Names **must** be in quotes, are **case-sensitive**, and must match exactly.

### $now — Current Timestamp (Luxon DateTime)
```javascript
{{$now}}
{{$now.toISO()}}                                    // 2025-10-20T14:30:45.000Z
{{$now.toFormat('yyyy-MM-dd')}}                      // 2025-10-20
{{$now.toFormat('HH:mm:ss')}}                        // 14:30:45
{{$now.toFormat('MMMM dd, yyyy')}}                   // October 20, 2025
{{$now.toFormat('EEEE, MMMM dd, yyyy')}}             // Monday, October 20, 2025
{{$now.plus({days: 7}).toFormat('yyyy-MM-dd')}}      // date arithmetic
{{$now.minus({hours: 24}).toISO()}}
```

### $env — Environment Variables
```javascript
{{$env.API_KEY}}
{{$env.DATABASE_URL}}
```

---

## CRITICAL: Webhook Data Structure

Webhook data is **NOT** at the root — it's under `.body`:

```javascript
// Webhook node output:
{
  "headers": {"content-type": "application/json", ...},
  "params": {},
  "query": {},
  "body": {           // ⚠️ USER DATA IS HERE
    "name": "John",
    "email": "john@example.com"
  }
}
```

```
❌ WRONG: {{$json.name}}        → undefined
✅ CORRECT: {{$json.body.name}}  → "John"
```

Also available: `{{$json.headers['content-type']}}`, `{{$json.query.api_key}}`

---

## Where Expressions DON'T Apply

- **Code nodes** — use direct JS/Python: `$json.field` not `{{$json.field}}`
- **Webhook paths** — static only: `"my-webhook"`, not `"{{$json.id}}/webhook"`. Use `:paramName` for dynamic segments.
- **Credentials** — use n8n credential system, not expressions

---

## Data Types & Helpers

### Arrays
```javascript
{{$json.users[0].email}}                           // first item
{{$json.users[$json.users.length - 1].name}}       // last item
{{$json.users.map(u => u.email).join(', ')}}        // join all
{{$json.users.length}}                              // count
```

### Strings
`.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.replace()`, `.substring()`, `.split()`, `.includes()`

### Numbers & Math
```javascript
{{$json.price * 1.1}}     // add 10%
{{$json.quantity + 5}}
```

### Conditional / Default
```javascript
{{$json.status === 'active' ? 'Active' : 'Inactive'}}  // ternary
{{$json.email || 'no-email@example.com'}}                // default
```

### DateTime (Luxon on $now)
`.toFormat()`, `.toISO()`, `.toSQL()`, `.toHTTP()`, `.plus()`, `.minus()`, `.set()`, `.startOf()`, `.endOf()`, `.diff()`, `.setZone()`

---

## 15 Common Mistakes

| # | Mistake | Fix | Symptom |
|---|---------|-----|---------|
| 1 | `$json.email` (no braces) | `{{$json.email}}` | Literal text in output |
| 2 | `{{$json.name}}` from webhook | `{{$json.body.name}}` | Undefined |
| 3 | `{{$json.first name}}` | `{{$json['first name']}}` | Syntax error |
| 4 | `{{$node.HTTP Request.json}}` | `{{$node["HTTP Request"].json}}` | "Cannot read property 'Request' of undefined" |
| 5 | `{{$node["http request"].json}}` | `{{$node["HTTP Request"].json}}` | Undefined (case-sensitive) |
| 6 | `{{{$json.field}}}` | `{{$json.field}}` | Literal braces in output |
| 7 | `{{$json.items.0.name}}` | `{{$json.items[0].name}}` | Syntax error |
| 8 | `'{{$json.email}}'` in Code node | `$json.email` | Literal string "{{$json.email}}" |
| 9 | `{{$node[HTTP Request].json}}` | `{{$node["HTTP Request"].json}}` | "Unexpected identifier" |
| 10 | `{{$json.data.items.name}}` (array) | `{{$json.data.items[0].name}}` | Undefined |
| 11 | `Email: ={{$json.email}}` in text | `Email: {{$json.email}}` | Literal "=" prefix (= only for JSON mode) |
| 12 | Dynamic webhook path | Static path or `:paramName` | Doesn't work |
| 13 | `{{$node["X"].data}}` (missing .json) | `{{$node["X"].json.data}}` | Undefined |
| 14 | `` `Hello ${$json.name}` `` | `Hello {{$json.name}}!` | Literal backtick text (auto-concatenation works) |
| 15 | `{{}}` empty brackets | `{{$json.field}}` | Literal text |

---

## Real Workflow Examples

### Webhook Form → Slack
Webhook receives POST `{name, email, company}` — wraps under `.body`:
```
New submission! Name: {{$json.body.name}} | Email: {{$json.body.email}} | Company: {{$json.body.company}}
```

### HTTP API → Database
HTTP returns `{data: {users: [{id, name, email}]}}`:
```sql
INSERT INTO users (user_id, name, synced_at)
VALUES ({{$json.data.users[0].id}}, '{{$json.data.users[0].name}}', '{{$now.toFormat('yyyy-MM-dd HH:mm:ss')}}')
```

### Multi-Node Data Flow (Webhook → HTTP → Email)
```
Subject: Order {{$node["Webhook"].json.body.order_id}} Confirmed
Body: Dear {{$node["HTTP Request"].json.order.customer}},
Total: ${{$node["HTTP Request"].json.order.total}}
Items: {{$node["HTTP Request"].json.order.items.join(', ')}}
```

### Code Node (Direct Access — NO {{ }})
```javascript
const items = $json.body.items;  // ✅ Direct access
const uppercased = items.map(item => item.toUpperCase());
return [{json: {original: items, transformed: uppercased, count: items.length}}];
```

---

## Debugging Expressions

1. Check braces — wrapped in {{ }}?
2. Check data source — webhook? Add `.body`
3. Check spaces — field/node name with spaces? Use brackets
4. Check case — node name matches exactly?
5. Check path — use expression editor (fx icon) for live preview
6. Check context — Code node? Remove {{ }}

Common error messages:
- "Cannot read property 'X' of undefined" → parent object doesn't exist
- "X is not a function" → wrong variable type
- Expression shows as literal text → missing {{ }}
