# 2026-04-05: Breakthrough — Full v3 API Surface Mapped and Validated

## Summary

In a single session, we went from 9 known endpoints (4 from Claymate, 5 from docs) to **37 confirmed endpoints** — and validated **full table CRUD via API** for the first time. This resolves the #1 capability gap (table creation) that was previously considered impossible without the Clay UI.

## Key Discoveries

### 1. Unauthenticated Enumeration Technique (INV-006)

Clay's v3 API returns different error types for valid vs invalid paths:
- **401** = endpoint exists, needs auth
- **400** = endpoint exists, reveals required parameters via Zod validation
- **404 (JSON)** = endpoint does NOT exist

By probing every plausible path, we mapped the full v3 surface without needing session cookies. The 400 responses are especially valuable — Clay's validator tells you exactly which field is missing next, allowing iterative payload discovery.

### 2. Table Creation Payload Discovered

```
POST /v3/tables
{
  "workspaceId": <number>,
  "type": "spreadsheet" | "company" | "people" | "jobs",
  "name": "<string>"
}
```

This was discovered entirely through validation error mining — no browser interception needed.

### 3. Session Cookie Identified

The auth cookie is `claysession` on `.api.clay.com` domain. It's an Express session cookie with 7-day lifetime. It does NOT appear under `app.clay.com` in DevTools — you must filter by `api.clay.com`.

### 4. Full CRUD Validated

Created a test table, added a column, renamed both, deleted both — all via API. Everything works.

## New Capabilities Unlocked

| Before | After |
|---|---|
| Table creation: UI only | `POST /v3/tables` |
| Table deletion: UI only | `DELETE /v3/tables/{id}` |
| Table listing: UI only | `GET /v3/workspaces/{id}/tables` |
| Column update: UI only | `PATCH /v3/tables/{id}/fields/{fId}` |
| Column delete: UI only | `DELETE /v3/tables/{id}/fields/{fId}` |
| Source update: unknown | `PATCH /v3/sources/{id}` |
| Source delete: unknown | `DELETE /v3/sources/{id}` |
| Enrichment trigger (v3): unknown | `PATCH /v3/tables/{id}/run` |
| Action management: unknown | `GET/POST /v3/actions?workspaceId=` |
| Import/export: unknown | `/v3/imports/*`, `/v3/exports/*` |

## Endpoint Count

| Source | Count |
|---|---|
| Previous (Claymate + docs) | 9 |
| INV-006 (enumeration) | +21 new |
| INV-007 (authenticated validation) | +8 refined |
| **Total confirmed** | **37** |

---

## How to Get the Session Cookie (for future sessions)

The `claysession` cookie is required for all v3 API calls. Here's how to extract it:

### Quick Method (30 seconds)

1. Open **app.clay.com** in Chrome (make sure you're logged in)
2. Press **F12** to open DevTools
3. Go to **Application** tab → **Cookies** in the left sidebar
4. **IMPORTANT**: Click on **`https://api.clay.com`** (NOT `app.clay.com`)
5. Find the cookie named **`claysession`**
6. Copy its **Value** (starts with `s%3A...`)

The cookie looks like:
```
s%3ANOD28nwZNUDbAw5T1Ktw6rNtcaasrGZF.XXwYueBeePQPuT1BYBcfYZb9Gplx%2BnxAXg9eQ2kHcgI
```

### Using the Cookie

```bash
CS='claysession=<paste value here>'
curl -H "Cookie: $CS" "https://api.clay.com/v3/me"
```

### Cookie Lifecycle

- **Issued when**: You log into app.clay.com via Google SSO
- **Lifetime**: 7 days from issuance
- **Domain**: `.api.clay.com` (sent to all api.clay.com endpoints)
- **Flags**: HttpOnly (can't read via JS), Secure (HTTPS only), SameSite=None
- **Refresh**: Log out and back in to get a fresh 7-day cookie (or it may auto-refresh on activity — needs testing per GAP-003)

### Where It's Stored in This Project

```
harness/results/.session-cookies.json   — Machine-readable cookie array (DO NOT COMMIT)
harness/results/session-YYYY-MM-DD.json — Metadata (user ID, workspace ID, expiry)
```

### Essential Info Alongside the Cookie

When extracting a new session, also note:
- **Workspace ID**: Found in the Clay URL (`app.clay.com/workspaces/<ID>/...`) or from `ajs_group_id` cookie (URL-encoded as `Workspace%20<ID>`)
- **User ID**: From `ajs_user_id` cookie, or call `GET /v3/me`
- **Frontend version**: Call `GET https://api.clay.com/v3` (no auth needed) — use the `version` field

### Automation Aspirations

Full automation of cookie extraction is blocked by Google 2FA. Options being explored:
1. **Playwright + Xvfb** with manual 2FA approval (semi-automated)
2. **Google OAuth2 device flow** (bypasses browser, but Clay may not accept)
3. **Persistent Playwright context** — login once, reuse browser profile forever
4. **Cookie refresh probing** (GAP-003) — if cookies auto-refresh on activity, we may only need manual extraction once per account

## Gaps Resolved

- **GAP-002**: Table lifecycle — RESOLVED (full CRUD confirmed)
- **GAP-006**: Table listing — RESOLVED (`/v3/workspaces/{id}/tables`)
- **GAP-007**: Column update/delete — RESOLVED (PATCH and DELETE confirmed)
- **GAP-008**: Workbook management — RESOLVED NEGATIVE (no `/v3/workbooks` endpoint; workbooks auto-created with tables)

## Remaining P0 Gaps

- **GAP-003**: Session cookie durability (7-day lifetime confirmed, but refresh mechanism unknown)
- **GAP-017**: Response shapes for all discovered endpoints (partially resolved — many shapes now known)

## Files Modified

- `registry/endpoints.jsonl` — 9 → 37 entries
- `registry/capabilities.md` — major overhaul with confirmed statuses
- `registry/gaps.md` — 4 gaps resolved, 4 new gaps added
- `registry/changelog.md` — INV-006 and INV-007 entries
- `investigations/INV-006_v3-unauthenticated-enumeration.md` — NEW
- `investigations/INV-007_authenticated-v3-validation.md` — NEW
- `investigations/_index.md` — updated
- `harness/results/.session-cookies.json` — NEW (DO NOT COMMIT)
- `harness/results/session-2026-04-05.json` — NEW
