# Skill: Lovable

Use this skill for tasks that touch a Lovable (lovable.dev) project: navigating the cloud editor, diagnosing UI or data issues, drafting precise change requests, or reasoning about the linked Supabase backend.

## Project identity

- **Do not infer** Lovable project ID, preview URL, or environment from this generic skill alone.
- Use the **task description**, **upstream agent output**, **credential metadata**, or **tenant-uploaded knowledge** for project UUIDs, URLs, and which app to modify.
- If the task says “the dashboard” or “the Lovable app” and multiple projects exist for the workspace, **ask the user** which project before running high-impact steps.

## Source code access

Source lives in Lovable’s cloud editor unless the customer has connected GitHub sync.

1. Open the project in the editor (URL from context, typically `https://lovable.dev/projects/{project_id}` with code view).
2. Browse the file tree; open files in the code panel.

Do not assume Lovable source exists in a local git checkout for routine tasks.

### Typical project structure

```
src/
  pages/          <- route components
  components/
  hooks/
  integrations/
    supabase/
      client.ts
      types.ts    <- often mirrors DB schema; read early for data tasks
supabase/
  migrations/
  functions/
public/
vite-env.d.ts     <- Vite env var declarations
```

## Making changes

**Method A — Lovable chat (common):** Describe the change with file paths, symbols, and expected behavior. Prefer small, verifiable requests.

**Method B — GitHub sync:** Use only when the project is connected to a repo and batch/diff workflow is appropriate.

Treat chat-driven rebuilds as **potentially immediate deploys** to the preview/production surface the project uses.

## Supabase

Each Lovable app is usually paired with a Supabase project. Connection details (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, or equivalents) are set in Lovable project settings and reflected in `vite-env.d.ts` / client code.

- Use URLs and keys from **integrations / task context / uploaded docs** — never placeholder or guessed credentials.
- For REST or SQL checks, use the same key tier the app uses (anon vs service) per customer policy.

Example of a **good** Lovable chat instruction (values are fake):

> In `src/pages/Admin.tsx`, change the Supabase client initialization so `addExpert` uses the URL from `import.meta.env.VITE_SUPABASE_URL` instead of a hardcoded string.

## Diagnosing “data not showing”

1. Read `types.ts` (or generated schema types) for tables and columns.
2. Trace the hook or page query (filters, RLS-sensitive queries).
3. Verify rows exist via approved Supabase access paths.
4. If empty, trace upstream writers (Clay, n8n, forms, etc.).
5. If rows exist but UI is blank, inspect RLS policies in `supabase/migrations/`.

## Risk tiers (guidance)

| Action | Risk |
|--------|------|
| Read-only navigation in editor | Lower |
| Diagnose + draft chat prompts | Lower |
| Lovable chat that triggers rebuild/deploy | Higher |
| Data writes or migrations | Higher |

## Common gotchas

- **No local source of truth** unless GitHub sync is on.
- **Vite exposure:** only `VITE_*` (or configured) env vars are available in browser bundles.
- **External pipelines:** Clay, spreadsheets, and other tools do not automatically populate Supabase; missing data usually means a broken or missing sync step.
- **RLS:** Data can exist but be invisible to the anon key used by the frontend.
