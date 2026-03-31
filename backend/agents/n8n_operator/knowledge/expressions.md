# n8n Expression Syntax

Dynamic values use `{{expression}}`. Plain text without `{{}}` is literal.

## Core Variables
- `$json` — current node output: `$json.field`, `$json['field with spaces']`, `$json.items[0].name`
- `$node["Exact Node Name"]` — prior nodes; name quoted, case-sensitive
- `$now` — Luxon DateTime: `$now.toFormat('yyyy-MM-dd')`, `$now.plus({days: 7})`
- `$env.VAR_NAME` — environment variables

## Webhook Gotcha
Payload lives under `body`, not root.
- Wrong: `{{$json.email}}`
- Right: `{{$json.body.email}}`

Structure: `headers`, `params`, `query`, `body` (user data in `body`).

## Validation Rules
- Always double braces; never nested `{{{ }}}`
- Spaces in keys: bracket notation `{{$json['field name']}}`
- Node refs: `{{$node["HTTP Request"].json...}}`

## Where Expressions Do NOT Apply
- Code nodes: use JS/Python directly, not `{{}}` or `={{}}`
- Webhook path: static paths only
- Credentials: use n8n credential system

## Helpers
String/array methods; Luxon on `$now`; ternary and `||` for defaults; math on numbers.
