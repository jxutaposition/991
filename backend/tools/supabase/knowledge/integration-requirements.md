# Supabase — Integration Requirements

## Credentials

Supabase project URL and API keys (anon key + optional service role key) — configured in Settings > Integrations.

## Access Model

- The anon key respects Row-Level Security (RLS) policies — use for public-facing dashboards.
- The service role key bypasses RLS — use for backend operations (data insertion, schema changes).
- Project URL identifies which Supabase project to interact with.

## Runtime Configuration

None for most use cases — the agent creates tables, edge functions, and RLS policies as needed.

### Dashboard Visibility

When building dashboards backed by Supabase:
- If the dashboard should be publicly viewable, create a `public_read` RLS policy on the relevant tables.
- If the dashboard requires authentication, configure RLS policies that match the auth context.
- The `supabaseUrl` and `supabaseAnonKey` are included in the dashboard spec for live data fetching.

### Existing Tables

If the task references existing Supabase tables, verify they exist before operating on them. Use the PostgREST API: `GET {project_url}/rest/v1/{table_name}?limit=0`. A 200 response confirms the table exists and is accessible.
