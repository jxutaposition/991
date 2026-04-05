# Supabase Platform Knowledge

## How Supabase Works

Supabase is an open-source Firebase alternative built on PostgreSQL. Each project provides:
- REST API (PostgREST) for database CRUD
- Real-time subscriptions via WebSocket
- Auth (JWT-based user management)
- Edge Functions (Deno-based serverless functions)
- Row Level Security (RLS) for fine-grained access control
- Storage for files and assets

## API Access

All database operations go through the PostgREST REST API:
- URL: `{project_url}/rest/v1/{table}`
- Auth: `apikey` header (anon key for public, service_role for admin)
- Use `select`, `insert`, `update`, `delete` query parameters

## Key Concepts

### Row Level Security (RLS)

RLS policies control which rows are visible to which users. Policies are SQL expressions evaluated per-row.
- Enable RLS: `ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;`
- Create policy: `CREATE POLICY "name" ON {table} FOR SELECT USING (condition);`
- Common pattern: public read, authenticated write

### Edge Functions

Server-side Deno functions for computed metrics, aggregations, or data transformations. Deployed via Supabase CLI or management API.

### Environment Variables

Frontend apps connect via two vars:
- `VITE_SUPABASE_URL` — project URL
- `VITE_SUPABASE_PUBLISHABLE_KEY` — anon key (safe for frontend)
- `SUPABASE_SERVICE_ROLE_KEY` — admin key (server-side only, never expose)
