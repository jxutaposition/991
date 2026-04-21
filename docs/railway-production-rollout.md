# Railway Production Rollout (Lean)

This runbook is intentionally minimal: launch-critical steps first, hardening second.

## 1) Launch Scope

Ship first with:
- Frontend (`frontend`) service
- Backend (`backend`) service
- Railway Postgres
- Google auth + core execution + SSE

Defer non-critical OAuth providers and optional integrations until post-launch.

## 2) Service Artifacts

- Backend uses `backend/Dockerfile` and `backend/railway.json`.
- Frontend uses `frontend/Dockerfile` and `frontend/railway.json`.
- Backend migration runner is `cargo run --bin migrate` (binary included in backend image at `/app/migrate`).

## 3) Environment Matrix

Set these in Railway before first deploy.

### Backend required
- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `JWT_SECRET`
- `CREDENTIAL_MASTER_KEY`
- `CORS_ORIGINS` (comma-separated allowed frontend origins)
- `FRONTEND_URL` (canonical frontend URL)
- `OAUTH_REDIRECT_BASE_URL` (canonical backend URL)

### Backend recommended
- `APP_ENV=production`
- `BIND_ADDR=0.0.0.0:3001`
- `AGENTS_DIR=/app/agents`
- `TOOLS_DIR=/app/tools`
- `POOL_SIZE=25`
- `HTTP_RESPONSE_MAX_CHARS=100000`
- `OPENAI_API_KEY` (required for knowledge semantic search)

### Frontend required
- `API_BACKEND_URL` (public backend URL, no trailing slash preferred)
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`

## 4) Deterministic Migrations

Staging first, production second.

From local:

```bash
cd backend
cargo run --bin migrate
```

In Railway backend service (release shell / one-off command):

```bash
/app/migrate
```

Notes:
- Applied migrations are tracked in `schema_migrations`.
- Runner verifies checksum for already-applied files and fails on mismatch.
- Migration files execute in deterministic lexicographic filename order.

## 5) Smoke Test Gate (Production)

Required checks immediately after deploy:
- `GET /health` returns 200
- Login works and `/api/auth/me` succeeds
- Frontend `/api/*` rewrite reaches backend
- One execution session emits SSE events

## 6) Hardening Backlog

Post-launch:
- Add backend CI (`cargo check`, tests, migration dry-run)
- Add DB/storage-aware readiness endpoint
- Add monitoring + alerting
- Plan multi-replica event fanout design before horizontal scaling
