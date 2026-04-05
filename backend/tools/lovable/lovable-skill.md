# Skill: Lovable

Use this skill for any task that touches a Lovable project — reading code, making changes, diagnosing issues, or working with the linked Supabase backend.

---

## Project registry (HeyReach)

| Name | Project ID | Live URL | Owner |
|------|-----------|----------|-------|
| Social Listening | `c0e75eb7-7d23-49da-b18d-04beaf2001be` | expert-pulse-dashboard-21.lovable.app | Umer |
| Expert Points | `a3afa877-ccae-4d99-9ddd-bf18f09dd24e` | preview--experts-points-leaderboard.lovable.app | Lele |

**Never infer which project from context alone. If the task says "the Lovable dashboard" or "the dashboard" without specifying — ask Lele before proceeding.**

---

## Source code access

Lovable project source lives in Lovable's cloud editor, not in any local git repo. To read or edit code:

1. Navigate to `https://lovable.dev/projects/{id}?view=codeEditor`
2. Use the file tree on the left to browse files
3. Click a file to open it in the code panel on the right

**Never** delegate a "find code in this Lovable project" task to an Explore subagent pointing at local repos — the code is not there.

### Typical project structure
```
src/
  pages/          <- page components (routes)
  components/     <- UI components
  hooks/          <- data-fetching hooks
  integrations/
    supabase/
      client.ts   <- Supabase client (reads VITE_ env vars)
      types.ts    <- full DB schema as TypeScript types ← READ THIS FIRST
  data/           <- static data or mock fixtures
  lib/            <- utilities
supabase/
  migrations/     <- SQL schema (timestamped)
  functions/      <- Edge Functions (backend TypeScript)
public/
vite-env.d.ts     <- env var type declarations
```

**Start every T-002-style task by reading `types.ts`** — it contains the full authoritative Supabase schema as TypeScript interfaces.

---

## Making code changes

Two methods. Use the one that fits the change:

### Method A — Lovable chat (preferred for most changes)
Type the change request in the chat box at the bottom left. Be specific:
- Good: "In `src/pages/Admin.tsx`, change the Supabase URL in the `addExpert` function from `qufxpoyoukzvddtpfbxa` to `ygtdnpnizmpthgwtvbjw`"
- Bad: "Fix the expert URL"

Lovable will rebuild and show the change in the live preview on the right. Verify before moving on.

### Method B — GitHub sync (for larger changes or batch edits)
Connect the project to GitHub (`GitHub` button top right), push changes via git. Lovable auto-pulls from the connected branch.

Only use Method B if the change spans many files or requires a diff review. For this project (Expert Points, owner: Lele), GitHub is not yet connected — use Method A.

---

## Supabase integration

Each Lovable project has its own linked Supabase project. The frontend connects via two env vars set in Lovable's project settings:
- `VITE_SUPABASE_URL` — the project URL
- `VITE_SUPABASE_PUBLISHABLE_KEY` — the anon/public key

For the **Expert Points** project:
- Supabase project ID: `ygtdnpnizmpthgwtvbjw`
- URL: `https://ygtdnpnizmpthgwtvbjw.supabase.co`
- Clay API key: `R7MEfUGzJCClQJ2nD49ejXUniMz8YQZl`
- Agent API key (direct REST): `_N45i.6_pxn3_P2`
- UI access: only through Lovable editor (no direct Supabase dashboard access)

### Direct REST calls (when Lovable UI doesn't work)
Use the Agent API key with standard Supabase REST:
```
GET/POST https://ygtdnpnizmpthgwtvbjw.supabase.co/rest/v1/{table}
Headers:
  apikey: _N45i.6_pxn3_P2
  Authorization: Bearer _N45i.6_pxn3_P2
  Content-Type: application/json
```

### Reading the schema
Always read `types.ts` (in the code editor) before writing any SQL or REST call. The TypeScript interfaces map 1:1 to the actual table columns.

---

## Diagnosing "data not showing" issues

1. Open the code editor → read `types.ts` for table schema
2. Find the relevant hook/query (usually in `src/hooks/` or `src/pages/Index.tsx`)
3. Identify which Supabase table + columns are queried and what filters apply
4. Check whether the table is actually populated — use direct REST GET with Agent API key
5. If table is empty: identify which external system should be writing to it (Clay, n8n, manual) and trace the gap

---

## Tier assignment for Lovable tasks

| Action | Tier |
|--------|------|
| Read code (editor view only) | 1 |
| Read Supabase data via REST GET | 1 |
| Diagnose issue, draft plan | 1 |
| Make code change via Lovable chat | 3 (irreversible — builds and deploys) |
| Insert/update data via REST POST/PATCH | 3 |
| Run SQL migration | 3 |

---

## Common gotchas

- **Source not in local git.** Always use the Lovable editor UI for reading code.
- **Two Lovable projects, one HeyReach workspace.** Social Listening (Umer's) vs. Expert Points (Lele's). Always confirm which one.
- **Lovable chat changes deploy immediately.** There is no staging — the live preview IS the deployed app. Treat every Lovable chat prompt as an irreversible action.
- **Supabase and Clay are separate.** Clay does not auto-sync to Supabase. If a table is empty, the Clay → Supabase write step is missing.
- **RLS policies control data visibility.** If data exists in Supabase but doesn't appear in the dashboard, check RLS policies in `supabase/migrations/`.
- **VITE_ prefix required.** Only env vars starting with `VITE_` are accessible in frontend code. Backend secrets go in Supabase Edge Function secrets.
