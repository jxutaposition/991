# n8n Validation

## Severity Levels
- **Errors** block execution: missing_required, invalid_value, type_mismatch, invalid_reference, invalid_expression
- **Warnings** advisory: best_practice, deprecated, performance
- **Suggestions** optional

## Validation Profiles
- `minimal` — quick required-field pass
- `runtime` — default for pre-deploy (recommended)
- `ai-friendly` — less noise for AI-configured workflows
- `strict` — noisy, for production hardening

## Fix Patterns
- `missing_required` → `get_node`, add the field
- `invalid_value` → align with allowed enum/options
- `type_mismatch` → correct JSON types (number not "100")
- `invalid_expression` → fix `{{}}` syntax, paths, node names
- `invalid_reference` → fix node name or check existence

## Auto-sanitization (on save)
- Binary IF/Switch ops → strips erroneous `singleValue`
- Unary ops → sets `singleValue: true`
- Does NOT fix: broken connections, Switch rule/output mismatches, corrupt state

## Workflow-level Validation
Checks connections, expressions, graph issues (cycles, multiple triggers, disconnected nodes)

## Recovery
Minimal valid config + incremental adds; `cleanStaleConnections`; `n8n_autofix_workflow` (preview then apply)
