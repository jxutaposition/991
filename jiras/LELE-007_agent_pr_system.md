# LELE-007: Agent PR System — File Diffs, Review, Write

## Problem
Agent files must only change through an auditable, expert-reviewed process. The extraction pipeline proposes changes; the expert approves or rejects. On approval, file changes are written to disk and committed to git.

## PR Types

| Type | Trigger | Target | Auto-merge eligible? |
|------|---------|--------|---------------------|
| `enhancement` | Drift detector finds gap in `prompt.md` | Existing agent's `prompt.md` | No |
| `new_agent` | 3+ clustered unmatched tasks | New agent folder | No |
| `example_addition` | High-confidence match + no drift detected | `examples/NNN.json` | Yes (high confidence only) |
| `reclassification` | Medium-confidence match to different agent | `abstracted_tasks.matched_agent_slug` | Yes |

## File Diff Format
Each PR stores `file_diffs` as JSONB:
```json
[
  {
    "file_path": "backend/agents/cold_email_writer/prompt.md",
    "old_content": "...current content...",
    "new_content": "...proposed content..."
  }
]
```
The dashboard renders these as side-by-side diffs.

## On Approve

1. Validate that no concurrent PR modifies the same file (check `agent_prs` for other `open` PRs targeting the same agent)
2. Write each `new_content` to the corresponding `file_path` on disk
3. Run `git add <files> && git commit -m "agent(<slug>): <pr_type> from session <session_id>"` — git SHA stored on the PR row
4. Mark `agent_prs.status = 'approved'`
5. Hot-reload the affected agent in `AgentCatalog` (see LELE-011)
6. Re-embed the updated agent and upsert `agent_catalog_index`
7. Trigger backfill: re-run matching on all `unmatched_tasks` (status='unmatched') against the new/updated agent

## On Reject

1. Mark `agent_prs.status = 'rejected'`
2. Store `reject_reason` from the expert's feedback (free text input in UI)
3. Feed the rejection reason back into the extraction pipeline as a "do not generate PRs like this" signal (stored in `extraction_preferences` table, future work)

## Conflict Resolution
If two PRs target the same `prompt.md`, the second PR to be approved must be rebased against the current file content. The UI warns: "This PR was drafted against an older version of the file. Please review carefully — the file has since been updated by PR #[id]."

## Open Questions
- Should there be a staging step where the expert can see the agent running with the proposed changes before committing?
- How do we handle PRs that conflict with each other at the git level?
- Should experts be able to edit the `proposed_addition` before approving?

## Acceptance Criteria
- [ ] Enhancement PR generated when drift detector fires
- [ ] New Agent PR generated when 3+ tasks cluster in unmatched pool
- [ ] Example Addition PR auto-merges at high confidence
- [ ] On approve: file written to disk, git committed, SHA recorded
- [ ] AgentCatalog hot-reloads the modified agent within 5 seconds of approval
- [ ] Conflict detection prevents simultaneous approval of conflicting PRs
