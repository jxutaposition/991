# n8n Gotchas

- **Webhook payloads** live under `$json.body`, not at root level.
- **Never use `{{}}`** inside Code nodes — use direct JavaScript/Python variable access.
- **Operation drives required fields.** Always check what fields are required for the specific `resource` + `operation` combination.
- **Auto-sanitization** happens on save — binary IF/Switch ops strip erroneous fields automatically.
- **OAuth2 credentials** may require manual browser consent. Flag this as a blocker if encountered.
- **Build iteratively**: create workflow, add nodes one at a time, validate after each. Don't build entire workflows in one shot.
- **API key is auto-injected** via the X-N8N-API-KEY header. Never include it manually.
- **Multi-project n8n workspaces:** API calls may need a `projectId` (or equivalent) query parameter. Confirm the correct project ID from **task context, integrations metadata, or tenant-uploaded runbooks** — do not assume a fixed tenant or project name.
