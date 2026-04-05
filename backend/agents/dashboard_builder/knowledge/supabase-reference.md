# Supabase PostgREST & RLS Reference

## PostgREST Query Syntax

All data operations go through the REST API at `https://{project}.supabase.co/rest/v1/`.
Auth headers (apikey + Bearer) are auto-injected for `supabase.co` URLs.

### Read (SELECT)

```
GET /rest/v1/{table}?select={columns}&{filters}
```

**Column selection**: `select=id,name,score` or `select=*` for all columns.
**Nested/joined**: `select=*,profiles(name,avatar)` for foreign key joins.

**Filter operators**:
| Operator | Meaning | Example |
|----------|---------|---------|
| `eq` | Equals | `?status=eq.active` |
| `neq` | Not equals | `?status=neq.archived` |
| `gt` / `gte` | Greater than / or equal | `?score=gt.50` |
| `lt` / `lte` | Less than / or equal | `?score=lt.100` |
| `in` | In set | `?tier=in.(Gold,Silver)` |
| `is` | Is null / not null | `?deleted_at=is.null` |
| `like` / `ilike` | Pattern match | `?name=ilike.*john*` |

**Ordering**: `?order=score.desc,name.asc`
**Pagination**: `?limit=25&offset=0`
**Count**: Header `Prefer: count=exact` returns total in `Content-Range` header.

### Insert

```
POST /rest/v1/{table}
Header: Prefer: return=representation
Body: {"name": "...", "score": 85}
```

Bulk insert: send an array `[{...}, {...}]`.

### Update

```
PATCH /rest/v1/{table}?id=eq.{value}
Header: Prefer: return=representation
Body: {"score": 90}
```

Always include filters — PATCH without filters updates ALL rows.

### Upsert

```
POST /rest/v1/{table}
Header: Prefer: resolution=merge-duplicates,return=representation
Body: {"id": "...", "name": "...", "score": 85}
```

Requires unique constraint on the conflict column.

### Delete

```
DELETE /rest/v1/{table}?id=eq.{value}
```

Always include filters — DELETE without filters deletes ALL rows.

## Row Level Security (RLS)

RLS controls which rows are visible to which users. Required for external-facing dashboards.

### Enable RLS
```sql
ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
```

### Common Policies

**Public read (for external dashboards)**:
```sql
CREATE POLICY "public_read" ON {table}
  FOR SELECT USING (true);
```

**Authenticated read (for internal dashboards)**:
```sql
CREATE POLICY "auth_read" ON {table}
  FOR SELECT TO authenticated USING (true);
```

**Row-level ownership**:
```sql
CREATE POLICY "owner_access" ON {table}
  FOR ALL USING (auth.uid() = user_id);
```

**Key gotcha**: Anon key = public access. If RLS is enabled but no policy allows anon SELECT, the Lovable app (which uses the anon key) will see empty results even if data exists. This is the #1 cause of "data not showing" issues.

## Edge Functions

Deno-based serverless functions for computed metrics, aggregations, or server-side logic.

**Deploy via**: Supabase CLI or Management API
**Invoke**: `POST /functions/v1/{function_name}` with JSON body
**Auth**: Same apikey/Bearer headers as REST API

Common use cases for dashboards:
- Aggregated metrics (total score, avg MRR, tier distribution counts)
- Complex queries that need server-side computation
- Cron-triggered data refreshes
