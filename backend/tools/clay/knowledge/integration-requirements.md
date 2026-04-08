# Clay — Integration Requirements

## Credentials

Clay session cookie + optional API key — configured in Settings > Integrations.
Workspace ID is auto-resolved from the credential (returned in `_workspace_id` on every API response).

## Access Model

- Session cookie gives full access to the entire Clay workspace.
- All workbooks, tables, columns, rows, sources, enrichments are accessible.
- No per-resource configuration needed from the user.
- Enrichment credits are finite — always test on a single row first before bulk runs.

## Runtime Configuration

None — Clay is workspace-scoped. The agent creates workbooks and tables as needed.

### Cross-System Dependencies

If Clay needs to fire webhooks to n8n, the webhook URL comes from the n8n operator's output (upstream dependency), not from the user. Similarly, if Clay needs to route data to Supabase, the Supabase project URL comes from credentials.

### Enrichment Provider Accounts

Some enrichment columns require third-party provider accounts (e.g., Prospeo, Hunter) to be connected in Clay's UI. Check available accounts with `clay_list_app_accounts`. If a required provider account is missing, use `request_user_action` to instruct the user to connect it in Clay's UI (Settings → Integrations within Clay).
