# LELE-006: Extraction Pipeline — Segmentation and Matching

## Problem
Raw narrations are prose descriptions of expert behavior. To update agents, we need to extract atomic, independently-reusable task capabilities from those narrations. This segmentation is the critical transformation from observation data to agent training signal.

## Pipeline Design

**Trigger:** Post-session extraction is triggered automatically when `POST /api/observe/session/{id}/end` is called. It can also be manually triggered for backfill via `POST /api/observe/session/{id}/extract`.

**Step 1 — Segmentation LLM call:**
Input: all `distillations` for the session (sorted by `sequence_ref`), with expert corrections applied.
Output: JSON array of `abstracted_tasks` (see `extractor_system.md` for prompt).
Model: Claude Sonnet 4.x (not Opus — this is a structured extraction task, not creative work).

**Step 2 — Embedding:**
Each `abstracted_task.description` is embedded using `text-embedding-3-small` (OpenAI) or equivalent. Stored as `VECTOR(1536)` in `abstracted_tasks.embedding`.

**Step 3 — Catalog matching:**
For each abstracted task, run:
```sql
SELECT slug, 1 - (embedding <=> $1::vector) AS similarity
FROM agent_catalog_index
ORDER BY embedding <=> $1::vector
LIMIT 3;
```
Apply thresholds:
- ≥ 0.85: High confidence match → auto-draft Enhancement/Example PR
- 0.60-0.85: Medium confidence → add to expert review queue
- < 0.60: Low confidence → accumulate in `unmatched_tasks`

**Step 4 — Unmatched clustering:**
For each new unmatched task, compute cosine similarity against all existing unmatched tasks. If 3+ tasks have mutual similarity > 0.80, create an `unmatched_task_cluster` and trigger a New Agent PR draft.

**Step 5 — Behavior drift detection:**
For high-confidence matches (≥ 0.85), run the drift detector LLM (see `drift_detector.md`):
- Input: matched agent's current `prompt.md` + the abstracted task description
- Output: `drift_detected` flag, `proposed_addition` text
- If drift detected: create Enhancement PR with the proposed addition

## Performance
- Embedding calls: batch up to 100 descriptions per API call
- Total extraction time for a 1-hour session (~50 distillations → ~15 abstracted tasks): estimate 30-60 seconds
- Run async — does not block the session end response

## Open Questions
- Should segmentation happen in real-time (as distillations arrive) or only post-session? Real-time would allow experts to see agent matches during the session.
- How do we handle extraction failures? If the LLM returns malformed JSON, should we retry, skip, or flag?
- Should the `abstracted_tasks` be shown to the expert before PR creation?

## Acceptance Criteria
- [ ] Extraction triggered on session end, runs async
- [ ] Segmentation produces ≥3 abstracted tasks for a 30-minute session
- [ ] All tasks have embeddings stored in `abstracted_tasks.embedding`
- [ ] Matching runs against `agent_catalog_index` and applies threshold logic correctly
- [ ] Drift detector invoked for high-confidence matches
- [ ] Unmatched task clustering creates clusters when 3+ similar tasks accumulate
