# Lovable Platform Knowledge

## How Lovable Works

Lovable is a cloud-hosted web app builder with an AI chat interface. Projects are Vite + React + TypeScript apps connected to Supabase for data.

There is **no REST API for editing projects**. You cannot create or modify Lovable projects programmatically via API.

## Two Ways to Make Changes

### Method A: Lovable Chat Prompts

Generate detailed prompts the user pastes into the Lovable editor:

1. Design the change (component, query, layout)
2. Generate a specific Lovable chat prompt including:
   - What page/component to modify
   - Exact behavior expected
   - Supabase table/column references
   - Environment variables needed
3. Call `request_user_action` with the prompt and step-by-step instructions
4. Resume and verify the deployed result

### Method B: GitHub Sync

If the Lovable project is connected to a GitHub repo, push code changes directly:

1. Clone the repo
2. Make code changes to the appropriate files
3. Commit and push to the connected branch
4. Lovable auto-deploys the changes

## Project Structure

```
src/
  pages/          # Page components (routes)
  components/     # Reusable UI components
  hooks/          # Data-fetching hooks (useQuery pattern)
  integrations/
    supabase/
      client.ts   # Supabase client config
      types.ts    # FULL DB SCHEMA — read this first for any data task
  data/           # Static data or mock fixtures
  lib/            # Utilities
supabase/
  migrations/     # SQL schema
  functions/      # Edge Functions
```

## Supabase Integration

Each project connects to Supabase via two environment variables:
- `VITE_SUPABASE_URL` — the Supabase project URL
- `VITE_SUPABASE_PUBLISHABLE_KEY` — the anon key

Only `VITE_`-prefixed env vars are accessible in frontend code.

## Lovable Chat Prompt Template

When generating prompts for the user to paste into Lovable:

```
Create a {type} dashboard with these pages:

Page: {page_name}
- Component: {component_description}
- Data source: Supabase table "{table_name}", columns: {columns}
- Query: select {columns} from {table} where {filter} order by {sort}
- Display: {visualization_type — table, chart, cards, stat counters}
- Filters: {interactive_filters}

Supabase connection:
- URL: {supabase_url}
- Anon key: {anon_key}
- Use @supabase/supabase-js client

Styling:
- {design_requirements}
- Responsive: mobile-first
- Empty states: show placeholder when no data
```

## Diagnostics Workflow

When data isn't showing in a Lovable app:

1. Check Supabase first — query the relevant table via API to confirm data exists
2. Read types.ts for the full DB schema
3. Trace the query path — which table, columns, filters the component uses
4. Check RLS policies — Row Level Security may be blocking data
5. If data is missing: trace which external system should write it (Clay, n8n, manual)
6. If data exists but UI is wrong: generate a Lovable prompt to fix the component
