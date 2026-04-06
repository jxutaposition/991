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
