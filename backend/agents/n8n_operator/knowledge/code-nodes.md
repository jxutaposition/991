# n8n Code Nodes (JavaScript and Python)

## JavaScript (preferred)

### Modes
- **Run once for all items** (default): `$input.all()` for batch logic
- **Run once for each item:** `$input.item` for per-item work

### Return Shape (required)
Array of `{ json: { ... } }`. Common mistakes:
- Bare object without array wrapper
- `[{ field }]` without `json` key
- Missing `return` statement

### Data Access
- `$input.all()`, `$input.first()`, `$input.item` (each-item mode)
- Other nodes: `$node["Node Name"].json`
- Webhook: `$json.body` / `$input.first().json.body`

### Built-ins
- `$helpers.httpRequest({ method, url, headers, ... })` (async)
- `DateTime` (Luxon)
- `$jmespath(data, 'query')`

## Python (Beta)

Prefer JavaScript unless specific stdlib is needed. No third-party packages (no requests, pandas, numpy).

### Variables
- `_input`, `_json`, `_node`, `_now`, `_today`, `_jmespath()`
- Same return shape: `[{"json": {...}}, ...]`
- Use `.get()` for safe key access

### Allowed stdlib
json, datetime, re, base64, hashlib, urllib.parse, math, random, statistics

## When to Use Code vs Nodes
- Complex multi-step logic → Code node
- Simple map/filter/IF → Set, Filter, IF, HTTP Request nodes
