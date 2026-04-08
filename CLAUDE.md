# Lele 2.0 — Agent Rules

## Frontend (Next.js — `frontend/`)

### After every edit under `frontend/src/`

1. **TypeScript check** — run `cd frontend && npx tsc --noEmit` and fix all errors.
2. **Dev-server health** — if the Next.js dev server is running, run:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
   ```
   If it does NOT return 200, the `.next` cache is probably corrupted. Fix:
   ```bash
   fuser -k 3000/tcp          # kill old process
   cd frontend && rm -rf .next
   npx next dev --port 3000   # restart
   ```
3. **Check terminal for runtime errors** — read the dev-server terminal output.
   Look for `Cannot find module`, `MODULE_NOT_FOUND`, or 500 responses.
   These are **not** caught by `tsc` — they only appear at runtime.
   If present, clear the cache (`rm -rf .next`) and restart.
4. **Lint** — run `cd frontend && npx next lint` and fix any errors you introduced.
5. Never leave missing imports, unused variables, or type errors — the TypeScript compiler is the source of truth.

### Common failure: `.next` cache corruption

Errors like `Cannot find module './vendor-chunks/next.js'` or `Cannot find module './627.js'` mean the `.next` build cache is stale. The fix is always: stop server → `rm -rf .next` → restart.

## Backend (Rust — `backend/`)

- After editing Rust files, run `cd backend && cargo check` and fix all errors before reporting the task as done.
- If the backend server is running, verify it still responds after your changes.

### SQL safety — NO STRING-BUILT QUERIES

This is non-negotiable. SQL injection has bitten this repo more than once.

1. **NEVER build a SQL query with `format!()`, `+`, or `write!()`.** Always use parameterized queries:
   ```rust
   // ✅ correct
   db.execute_with(
       "SELECT id FROM observation_sessions WHERE id = $1",
       pg_args!(session_id.clone()),
   ).await?;

   // ❌ forbidden — even if you "know" the value is safe today
   let sql = format!("SELECT id FROM observation_sessions WHERE id = '{session_id}'");
   db.execute_unparameterized(&sql).await?;
   ```

2. **`PgClient::execute_unparameterized` is intentionally ugly.** Its name is a warning. Do not call it from new code. If you see it in existing code, treat it as a migration target — convert to `execute_with` + `pg_args!`.

3. **Allowlist exception** — the only legitimate use of `format!()` for SQL is when the interpolated values come from a *server-controlled allowlist* (e.g. building a column list from a static `&[&str]`, or composing a WHERE clause from validated filter keys). In that case the call site MUST have a comment on the line above:
   ```rust
   // sql-format-ok: <reason — what's interpolated and why it can't reach user input>
   let sql = format!("SELECT COUNT(*) FROM overlays WHERE {filters}");
   ```
   The CI grep gate (`backend/scripts/check-sql-safety.sh`) fails the build on any `format!()` SQL without this comment.

4. **`PgArguments` parameter types**: `pg_args!` accepts owned values or references. UUIDs from path params come in as `String` — pass `id.clone()` rather than `&id` if the borrow checker complains.

5. After ANY change that touches SQL, run `bash backend/scripts/check-sql-safety.sh` before `cargo check`. The script catches new `format!()`-built SQL and new `execute_unparameterized` callers.
