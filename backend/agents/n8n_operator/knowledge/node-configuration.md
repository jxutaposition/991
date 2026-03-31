# n8n Node Configuration

## Principles
- Operation-aware: `resource` + `operation` determine required fields
- Fields show/hide based on other values (displayOptions)

## Discovery Flow
1. `get_node` with default detail ("standard", ~1-2K tokens) — start here
2. Stuck on a field → `mode: "search_properties", propertyQuery: "..."`
3. Still insufficient → `detail: "full"` (large; use sparingly)

## Iterate
Minimal config → `validate_node` → add fields validation demands → repeat (2-3 rounds typical)

## Common Patterns
- **Resource/operation nodes:** pick resource → operation → fill required fields
- **HTTP:** method drives body; `sendBody: true` required for POST/PUT/PATCH
- **Database nodes:** operation drives query/table/where fields
- **IF node:** binary ops need two values; unary ops (`isEmpty`, etc.) use `singleValue: true`

## Anti-patterns
- Dumping every optional field upfront
- Deploying without validation
- Changing operation without re-checking required fields
- Fighting auto-sanitization for IF/Switch operators
