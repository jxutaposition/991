# Lovable Gotchas

- **Changes deploy immediately.** No staging environment. Every change via the Lovable editor is production.
- **Only VITE_-prefixed env vars** are accessible in frontend code. Other env vars are silently ignored.
- **Supabase and Clay are separate systems.** Clay does not auto-sync to Supabase. Missing data usually means a missing Clay -> Supabase write step.
- **RLS policies control visibility.** If data exists in Supabase but doesn't appear in the app, check Row Level Security in migrations.
- **Source code lives in Lovable's cloud editor**, not local git.
- **Confirm which project** before generating prompts. Multiple projects may exist for one client.
- **Computed/aggregated data**: For dynamic dashboards needing aggregated data, build edge functions in Supabase rather than relying on external system rollups.
