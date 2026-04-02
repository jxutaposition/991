# SD-001: Agent Config Management — DB-Centric Architecture

## Decision

Agent definitions (prompts, tools, judge configs, examples, knowledge docs) are **content, not code**. The database is the single source of truth. Filesystem agent files exist only as seed data for first-run bootstrapping.

This architecture enables:
- Hot-reload on PR approval (no deployments needed)
- Per-client agent customization without forking code
- Distributed auto-updating across all running instances
- Version history with full audit trail

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│  Seed Files (backend/agents/)                        │
│  └─ Only used on first boot when DB is empty         │
│     (one-time bootstrap, then DB owns everything)    │
└────────────────────┬─────────────────────────────────┘
                     ▼ (first run only)
┌──────────────────────────────────────────────────────┐
│  agent_definitions (DB — source of truth)             │
│  ┌─ slug, name, category, description                │
│  ├─ system_prompt (the markdown prompt)              │
│  ├─ tools, judge_config, examples, knowledge_docs    │
│  ├─ version (auto-incremented on each change)        │
│  └─ expert_id (optional ownership)                   │
└────────────────────┬─────────────────────────────────┘
                     │
        ┌────────────┼────────────────┐
        ▼            ▼                ▼
┌──────────────┐ ┌──────────┐ ┌─────────────────┐
│ agent_prs    │ │ agent_   │ │ AgentCatalog    │
│ (proposals)  │ │ versions │ │ (in-memory      │
│              │ │ (audit)  │ │  BTreeMap cache) │
└──────┬───────┘ └──────────┘ └────────┬────────┘
       │                               │
       │  approve → apply_pr()         │
       └───────────────────────────────┘
         Updates DB + hot-reloads cache
```

## PR Lifecycle (How Agent Changes Flow)

### 1. PR Creation (Automated)
The feedback pipeline detects drift between expert behavior and current agent prompts:
- **Drift detector** compares observation sessions against agent output
- Creates `agent_prs` row with `status = 'open'`
- Stores `file_diffs` with before/after content for each changed field
- Stores `proposed_changes` as structured JSON

### 2. PR Review (Human)
The dashboard (`/agent-prs`) shows:
- List of open PRs with type badges, confidence scores, evidence counts
- Detail view with side-by-side diff of current vs proposed content
- Approve & Merge or Reject buttons

### 3. PR Approval (Instant)
When "Approve & Merge" is clicked:
1. `apply_pr()` updates `agent_definitions` in DB (bumps version)
2. Creates `agent_versions` snapshot for audit trail
3. `catalog.reload_agent()` refreshes in-memory cache immediately
4. All subsequent agent invocations use the new definition — zero delay

### 4. PR Rejection
- Sets `status = 'rejected'` with `reviewed_at` timestamp
- Rejection reason stored for future pipeline tuning

## Why Not GitHub PRs?

For a prototype, actual GitHub PRs add complexity without proportional value:
- Requires GitHub Actions / webhooks to sync merges back to DB
- The review UX we need (approve/reject with confidence scores, evidence links) doesn't map to GitHub's PR model
- DB is already the runtime source of truth — adding a file layer creates two sources of truth

**Future consideration**: If agent definitions need to be version-controlled in git (compliance, multi-team review), add a GitHub sync layer that mirrors DB changes to a repo. But DB remains authoritative.

## File Diffs Format

Each PR stores `file_diffs` as JSONB array showing before/after for each changed field:

```json
[
  {
    "file_path": "system_prompt",
    "old_content": "You are a cold email writer...",
    "new_content": "You are a cold email writer...\n\n## Additional Context\nNew section added by drift detection..."
  },
  {
    "file_path": "judge_config",
    "old_content": "{\"threshold\": 7.0, ...}",
    "new_content": "{\"threshold\": 7.0, \"rubric\": [\"new criteria\"], ...}"
  }
]
```

The frontend renders these as unified diffs with added/removed line highlighting — similar to GitHub's diff view but scoped to agent definition fields.

## Hot-Reload Strategy

| Scenario | Behavior |
|----------|----------|
| PR approved | Immediate reload via `catalog.reload_agent()` |
| Server restart | Full reload from DB (`AgentCatalog::load()`) |
| Running workflow mid-execution | Uses cached agent from when step started (consistent within a step) |
| New workflow starts | Gets latest version from catalog |

**No polling, no TTL, no staleness** — changes propagate on write, not on read.

For multi-instance deployments (future): use PostgreSQL `LISTEN/NOTIFY` to broadcast agent version changes to all instances, triggering immediate cache refresh.

## Version Pinning (Future)

For long-running workflows (weeks/months):
- Workflow instances can optionally pin to a specific agent version
- Default behavior: always use latest (since reload is instant)
- Pinning useful when a workflow must complete with consistent agent behavior
- Migration path: admin can force-upgrade pinned workflows to minimum version

## Schema Summary

```sql
-- Source of truth
agent_definitions (slug PK, system_prompt, tools, judge_config, examples, knowledge_docs, version, ...)

-- Audit trail
agent_versions (agent_id FK, version, snapshot JSONB, change_summary, change_source, source_pr_id)

-- Proposal pipeline
agent_prs (id PK, pr_type, target_agent_slug, file_diffs JSONB, proposed_changes JSONB, status, ...)
```

## What This Replaces

| Before | After |
|--------|-------|
| Agent files on disk as source of truth | DB as source of truth, disk as seed only |
| `file_diffs` always empty `[]` | `file_diffs` populated with before/after content |
| Frontend shows only `new_content` | Frontend shows side-by-side diff with highlighting |
| No diff visibility into what changed | Full diff for every changed field |

## Acceptance Criteria

- [x] DB is source of truth (already implemented)
- [x] Hot-reload on approval (already implemented via `catalog.reload_agent()`)
- [x] Version tracking (already implemented via `agent_versions`)
- [x] `file_diffs` populated with before/after content on PR creation
- [x] Frontend renders real unified diffs (added/removed lines highlighted, line numbers)
- [x] New agent PRs show full proposed content as "new file" diff (all green)
- [x] Fallback: older PRs with empty `file_diffs` render `proposed_changes` JSON
