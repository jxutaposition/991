# LELE-021: Replace Startup seed_from_disk with CI-Driven Agent Sync

## Problem

`AgentCatalog::load()` calls `seed_from_disk` on every server startup, walking `backend/agents/` and upserting every directory into the `agent_definitions` table. This couples the server to the filesystem and means the DB can only be updated by restarting the backend. It also required a pruning step (added in the agent consolidation work) to delete stale rows for removed agents.

The DB is the runtime source of truth — the server should only read from it, never from disk at request time. Disk files are the canonical source versioned in git.

## Current Flow

```
Server start → seed_from_disk(agents_dir)
  → walk backend/agents/*/
  → upsert each into agent_definitions
  → prune rows not on disk
  → reload_all from DB into memory
```

## Target Flow

```
PR merged to main (backend/agents/** changed)
  → GitHub Action diffs changed agent dirs
  → Action upserts/deletes affected rows in agent_definitions
  → Action bumps version column

Server start → reload_all from DB into memory (no disk walk)
```

## Acceptance Criteria

- GitHub Action triggers on push to `main` when `backend/agents/**` files change
- Action parses each changed agent's `agent.toml` + `prompt.md` + optional files, upserts to DB
- Action deletes `agent_definitions` rows for removed agent directories
- `seed_from_disk` removed from `AgentCatalog::load()` — startup only calls `reload_all`
- Hot reload (LELE-011) continues to work for single-agent updates via PR approval

## Dependencies

- LELE-011 (Agent Hot Reload) — the reload path after PR approval stays as-is
- LELE-007 (Agent PR System) — PRs that modify agent files trigger the action on merge

## Notes

Until this is implemented, `seed_from_disk` with pruning is the stopgap that keeps disk and DB in parity.
