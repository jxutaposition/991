# SD-007: Chat Learning Pipeline

## Summary

The Chat Learning Pipeline is a three-stage background system that periodically analyzes completed chat transcripts from all interaction surfaces (orchestrator, sub-agents, Slack) and distills them into scoped overlays (Layer 2: Learned Knowledge). It also generates holistic narrative summaries inspired by ChatGPT's "User Knowledge Memories" approach. This is the canonical reference for the Transcript Analyzer described in SD-006 Part 5.

For overlay mechanics and the scope hierarchy, see SD-003 Part 3. For the five-memory-layer model, see SD-006 Part 1. For the Pattern Promoter, see SD-003 Part 4.

---

## Part 1: Motivation and Position in the Memory Architecture

### Where this fits

In SD-006's five-memory-layer model, this pipeline feeds **Layer 2 (Learned Knowledge)** from **Layer 3 (Execution Memory)**. Layer 3 is per-session conversation state that is discarded after a session completes. The Chat Learning Pipeline rescues the durable insights buried in those conversations before they are lost.

### Why chat transcripts are uniquely valuable

Compared to the other learning feeders (Project Learner from explicit feedback, Corpus Analyzer from uploaded docs, Observation Distiller from browser sessions), chat transcripts capture **implicit learnings** — corrections, preferences, and domain rules that users express through natural interaction but would never write down as formal feedback.

Examples:
- User replies "no, use the bulk endpoint instead" → tool usage preference
- User says "always CC legal for this client" → process rule
- User corrects "VP in banking is junior-level" → domain knowledge
- User iterates "shorter, more data-driven" → style preference

These signals are high-quality (the user demonstrated them in context) and frequent (every session generates them). Without this pipeline, they vanish after session completion.

### Existing feeders and how this differs

| Feeder | Input | Trigger | Scope |
|--------|-------|---------|-------|
| Project Learner | Explicit user feedback | Real-time (per feedback) | Always `project` |
| Pattern Promoter | Existing overlays | Scheduled (24h) | Promotes upward |
| Corpus Analyzer | Uploaded documents | On document ready | From `inferred_scope` |
| **Chat Learning Pipeline** | **Chat transcripts** | **Scheduled (2h)** | **LLM-determined** |

The Chat Learning Pipeline is unique in that the scope is **LLM-determined** based on signals in the transcript, not pre-assigned. The "default to most specific" rule applies: if `project_id` exists, default to `project` scope. The Pattern Promoter handles generalization.

---

## Part 2: Data Sources and Transcript Assembly

### Tables read

| Source | Table | Content |
|--------|-------|---------|
| Agent chat | `node_messages` | User/assistant message pairs per node |
| Thinking | `thinking_blocks` | (Available but not used in v1 — too noisy) |
| Slack | `slack_events` via `slack_channel_mappings` | Channel messages linked to sessions |
| Clarifications | `execution_nodes.clarification_request/response` | Slack or UI clarification exchanges |

### Segmented transcript construction

The transcript is **segmented at node boundaries**, not concatenated into a flat blob. Each segment is a `TranscriptSegment` struct:

```rust
struct TranscriptSegment {
    node_id: Uuid,
    agent_slug: String,
    task_description: String,
    messages: Vec<TranscriptMessage>,
}
```

**Why segmented**: Two reasons identified in the review process:

1. **Attribution accuracy** — A correction in node 3 might look like it applies to node 7's domain if the transcript is flat. Segmentation lets the LLM attribute each learning to its originating node.

2. **Attention dilution** — Long sessions with many nodes spread extraction attention too thin. Labeled segments give the LLM clear topic boundaries.

The `collect_session_transcript` function loads nodes ordered by `depth ASC, created_at ASC`, then for each node loads `node_messages` ordered by `created_at ASC`. Only `user` and `assistant` role messages are included (tool_use/tool_result are noise for learning extraction). Clarification exchanges are appended to their node's segment with `[Clarification request/response]` prefixes.

### Transcript size limits

The formatted transcript is capped at 80,000 characters to stay within LLM context window limits. For sessions that exceed this, the transcript is truncated with a `[transcript truncated]` marker.

---

## Part 3: Three-Stage Pipeline Architecture

```
Stage 0: Collect               Stage 1: Extract               Stage 2: Distill                Stage 3: Synthesize
─────────────────               ────────────────               ────────────────                ────────────────────
node_messages       ──→  Segment by node      ──→  LLM: extract learning     ──→  Canonicalize slugs      ──→  Check overlay count
slack_events             + metadata tags            candidates per segment         Batch by primitive           vs. NARRATIVE_THRESHOLD
clarification_*          (agent_slug, task)         (surviving vocabulary)          LLM: classify batch          If exceeded + stale:
                                                                                   novel → write overlay          LLM: synthesize
                         Returns:                   Returns:                       duplicate → reinforce          narrative paragraph
                         Vec<TranscriptSegment>     Vec<LearningCandidate>         refinement → write             Upsert scope_narratives
                                                                                   contradiction → flag
                                                    Writes: chat_learnings         Writes: overlays,
                                                                                   chat_learnings status
```

### Why each stage exists

**Stage 1 (Extract)** prevents garbage-in: the LLM filters routine noise (confirmations, task-specific details) and produces structured candidates. The surviving vocabulary instruction prevents terminology drift that would break downstream dedup.

**Stage 2 (Distill)** prevents duplicates and catches contradictions: without it, the same lesson from different sessions would produce duplicate overlays. Batching by primitive also cuts LLM costs by ~70-80% vs. per-candidate calls.

**Stage 3 (Synthesize)** captures emergent patterns: individual overlays are specific rules, but the narrative captures cross-cutting patterns like "this expert tends to over-engineer auth layers before scoping a product" that are invisible at the per-overlay level.

### The chat_learnings staging table

The `chat_learnings` table is the intermediate state between raw transcripts and durable overlays. Every extracted candidate gets a row regardless of whether it becomes an overlay. This provides:

- **Auditability** — every overlay can be traced back to its extraction
- **Quality monitoring** — the ratio of novel vs. duplicate vs. rejected candidates indicates pipeline health
- **Manual override** — users can reject learnings or resolve conflicts via the API

---

## Part 4: Prompt Design and Trade-offs

### Stage 1: Extraction

Key design choices:

1. **Surviving vocabulary instruction** — "Preserve the user's exact terminology and phrasing. Do not paraphrase, generalize, or substitute synonyms." This was added based on research showing that terminology drift in extraction breaks downstream retrieval and dedup. If the user said "bulk endpoint," the overlay must literally say "bulk endpoint," not "batch API operations."

2. **Skill catalog injection** — The full list of valid skill slugs is injected into the prompt so the LLM picks from a known vocabulary. This constrains hallucination and produces slugs that match the `skills` table. The `"general"` catch-all handles cross-cutting learnings that don't map to a specific skill.

3. **Explicit exclusion list** — Task-specific details, routine confirmations, and reference data are explicitly excluded. Without this, the LLM over-extracts and produces low-quality candidates that dilute the overlay pool.

### Stage 2: Batched Dedup + Conflict Detection

Key design choices:

1. **Batched, not per-candidate** — All candidates for one primitive are sent in a single LLM call alongside all existing overlays for that primitive. This lets the LLM see inter-candidate relationships (two candidates from the same session that partially overlap) and cuts cost dramatically.

2. **Four verdicts** — `novel`, `duplicate`, `refinement`, `contradiction`. The `contradiction` verdict was identified as a critical gap in review: without it, "always CC legal" and "never CC legal directly" would both be written as novel overlays.

3. **Duplicate → reinforcement** — Instead of discarding duplicates, we bump `reinforcement_count` and `reinforced_at` on the existing overlay. This provides a signal of overlay importance for future use (Pattern Promoter promotion, usage feedback loop).

### Stage 3: Narrative Synthesis

Key design choices:

1. **Cross-cutting, not per-primitive** — v1 generates one narrative per scope+scope_id (e.g., one for the expert across all skills). This matches ChatGPT's approach and captures the holistic patterns that are most valuable.

2. **Two variants** — Third-person for agent injection ("This expert tends to..."), second-person for user-facing API ("You tend to..."). Generated in the same LLM call for efficiency.

3. **Threshold-based regeneration** — Narratives are only regenerated when overlay count exceeds `NARRATIVE_THRESHOLD` (default 15) AND the existing narrative is older than the newest overlay. An in-memory `HashSet` prevents duplicate regeneration within a single cycle.

---

## Part 5: Narrative Synthesis Layer

### Inspiration: ChatGPT's "User Knowledge Memories"

ChatGPT's memory system was reverse-engineered and found to use no RAG and no vector databases. It injects four pre-computed layers into every prompt, including "User Knowledge Memories" — dense AI-generated paragraphs periodically distilled from all conversation history. The key insight: periodic re-distillation into narrative paragraphs captures emergent patterns that individual facts miss.

### The scope_narratives table

```sql
scope_narratives (
    id UUID,
    scope TEXT,                    -- 'expert', 'client', 'project', 'base'
    scope_id UUID,                 -- nullable for 'base'
    narrative_text TEXT,           -- third-person, agent-facing
    narrative_text_user TEXT,      -- second-person, user-facing
    source_overlay_count INT,      -- how many overlays were distilled
    generated_at TIMESTAMPTZ       -- for staleness checks
)
```

UNIQUE constraint uses COALESCE to handle NULLs correctly: `CREATE UNIQUE INDEX ON scope_narratives(scope, COALESCE(scope_id::text, ''))`.

### Injection in resolve_overlays

The `resolve_overlays` function in `skills.rs` was modified to use a **narrative + recency buffer** strategy:

1. Load scope narratives for the relevant scope chain
2. Load non-retired overlays
3. For each scope: if a narrative exists, inject the narrative + only overlays created **after** the narrative's `generated_at`
4. If no narrative exists, inject all non-retired overlays (unchanged from before)

This prevents unbounded prompt growth. The narrative absorbs historical overlays; only the recency buffer (rules the narrative hasn't absorbed yet) is injected as individual items. Prompt size is bounded regardless of total overlay count.

---

## Part 6: Scheduling, Catch-up, and Failure Handling

### Scheduling

The chat analyzer runs every **2 hours** via `spawn_scheduler`, following the same pattern as `pattern_promoter.rs`: a tokio interval with shutdown signal.

### High-water-mark model (migration 034)

Sessions are treated as **living projects** that accumulate messages over time, not discrete runs that complete once. The analyzer uses a high-water-mark pattern via `learning_scanned_up_to` (TIMESTAMPTZ on `execution_sessions`):

- **Session selection**: any session with `analysis_skip = FALSE`, at least one user message, and either `learning_scanned_up_to IS NULL` (never scanned) or messages newer than the watermark.
- **No status filter**: sessions in any status (`executing`, `awaiting_approval`, `completed`, etc.) are eligible as long as they have user messages.
- **On success**: `learning_scanned_up_to` advances to `MAX(node_messages.created_at)`.
- **On failure**: watermark is left unchanged (previous successful scan position is preserved), only `analysis_failure_count` increments.
- **Known limitation**: re-scans currently read the full transcript, not just messages after the watermark. The distill stage's dedup handles most duplicate extractions. Incremental-only transcript collection is a future optimization.

### Catch-up logic

On each cycle:
1. Count the backlog of sessions with new messages (watermark-based)
2. If backlog > `CATCHUP_THRESHOLD` (default 20), increase batch size to `CHAT_ANALYZER_CATCHUP_BATCH_SIZE` (default 5)
3. Otherwise use `CHAT_ANALYZER_BATCH_SIZE` (default 1)

This means a 100-session backlog clears in ~2 days instead of ~8.

### Lookback window

`CHAT_ANALYZER_LOOKBACK_DAYS` (default 30) controls how far back the analyzer considers sessions. Set to 365 for initial historical import on existing instances.

### Failure handling

- On analysis failure: increment `analysis_failure_count`, leave `learning_scanned_up_to` at its previous value
- After 3 failures: set `analysis_skip = TRUE` (permanent exclusion)
- `analysis_skip` is a dedicated boolean column, not an epoch timestamp hack

### Concurrency safety

Session claiming uses `FOR UPDATE SKIP LOCKED` to prevent double-processing in multi-instance deployments.

### Cost model

- Each session: 2-3 LLM calls (1 extraction + 1 batched dedup per primitive group + 0-1 narrative synthesis)
- Baseline: ~12 sessions/day = ~36 calls/day
- Catch-up: up to ~180 calls/day

---

## Part 7: Conflict Detection and Resolution

### What constitutes a contradiction

Two overlays conflict when they give directly opposing instructions for the same skill and context. Example: "Always CC the client's legal team" vs. "Never CC legal team directly."

### Why contradictions are never auto-written

Writing contradictory overlays would inject conflicting instructions into agent prompts, causing unpredictable behavior. Instead, contradictions are flagged with `status = 'conflict'` and `conflicting_overlay_id` pointing to the existing overlay.

### Resolution flow

`POST /api/chat-learnings/:id/resolve-conflict` accepts three actions:

- `accept_new` — write the new overlay, set `retired_at = NOW()` on the conflicting overlay
- `keep_old` — reject the learning
- `keep_both` — write the new overlay without retiring the old one

### Monitoring

`GET /api/chat-learnings/stats` returns `pending_conflicts` count for dashboard alerting.

---

## Part 8: Reinforcement and Decay

### Overlay reinforcement

Two new columns on `overlays`:

- `reinforced_at TIMESTAMPTZ` — last time a duplicate reinforced this overlay
- `reinforcement_count INT` — how many times this overlay was independently validated

When Stage 2 classifies a candidate as `duplicate`, it bumps these instead of discarding. This turns duplicates into a signal of overlay importance.

### Overlay retirement

`retired_at TIMESTAMPTZ` marks overlays that lost conflict resolution. All overlay-reading queries filter `WHERE retired_at IS NULL`:

- `resolve_overlays` in `skills.rs`
- Pattern Promoter's overlay scan in `pattern_promoter.rs`
- Stage 2's existing overlay loading in `chat_analyzer.rs`
- The `overlays/memories` API endpoint

### Future: decay

The `reinforced_at` column provides the axis for future decay logic. An overlay reinforced 6 months ago with `reinforcement_count = 1` is a weaker signal than one reinforced last week with count 15. v1.5 can use this for recency weighting in `resolve_overlays`.

---

## Part 9: User Visibility and Editability

Both ChatGPT and Claude let users see, edit, and delete their memories. Power users self-managing their memory creates a human feedback loop without a formal RLHF pipeline.

### API surface

| Endpoint | Purpose |
|----------|---------|
| `GET /api/overlays/memories` | Browse transcript-derived overlays, filterable by scope and source |
| `PATCH /api/overlays/:id` | Edit overlay content |
| `GET /api/scope-narratives` | View holistic narratives (returns user-facing second-person variant) |
| `POST /api/scope-narratives/:id/regenerate` | Force re-generation |
| `GET /api/chat-learnings/:session_id` | View extracted learnings for a session |
| `POST /api/chat-learnings/:id/reject` | Manually reject a learning |
| `POST /api/chat-learnings/:id/resolve-conflict` | Resolve contradictions |
| `GET /api/chat-learnings/stats` | Dashboard statistics |
| `POST /api/chat-learnings/analyze/:session_id` | Trigger on-demand analysis |

---

## Part 10: Comparison with Production Systems

### vs. ChatGPT

| Dimension | ChatGPT | Lele 2.0 |
|-----------|---------|----------|
| Memory structure | Flat global — no scoping | Scoped hierarchy (project → client → expert → base) |
| Attribution | Unattributed blobs | Per-skill overlays with source tracing |
| Narrative summaries | ~10 holistic paragraphs (their key differentiator) | Cross-cutting scope narratives (borrowed) |
| Scope promotion | None | Pattern Promoter with evidence thresholds |
| Multi-channel capture | Single chat stream | node_messages + Slack + clarifications |
| User editability | Manual delete only | Browse, edit, reject, resolve conflicts |
| Dedup | Opaque | Explicit staging table with 4-verdict classification |

### vs. Claude

| Dimension | Claude | Lele 2.0 |
|-----------|--------|----------|
| Memory model | Explicit, user-editable, inconsistent auto-capture | Automatic extraction + user editability |
| Scoping | None (flat) | Four-level scope hierarchy |
| Cross-AI import | Yes (claude.ai/import-memory) | Not applicable (single system) |

### What we borrowed

1. **Holistic narrative summaries** from ChatGPT — the most impactful addition
2. **User-editable memories** from both — highest ROI quality signal at zero ML cost

### Where we are ahead

1. Scoped hierarchy with evidence-based promotion
2. Per-skill attribution (overlays are not blobs)
3. Multi-channel capture (Slack, clarifications, node messages)
4. Explicit dedup with conflict detection
5. Intermediate staging table for auditability

---

## Part 11: Implementation Status

| Component | Status | Code Location |
|-----------|--------|---------------|
| Migration (session columns, overlay columns, tables) | Built | `backend/migrations/031_chat_learning.sql` |
| Chat analyzer module (Stages 1-3) | Built | `backend/src/chat_analyzer.rs` |
| Slug canonicalization (Levenshtein) | Built | `backend/src/chat_analyzer.rs` `canonicalize_slugs()` |
| Scheduler registration | Built | `backend/src/main.rs`, `backend/src/lib.rs` |
| `resolve_overlays` narrative injection | Built | `backend/src/skills.rs` |
| Pattern Promoter `retired_at` filter | Built | `backend/src/pattern_promoter.rs` |
| Chat learnings API endpoints | Built | `backend/src/routes.rs` |
| Memory visibility API endpoints | Built | `backend/src/routes.rs` |
| Scope narratives API endpoints | Built | `backend/src/routes.rs` |
| Frontend UI for memory management | Not built | — |
| Corpus Analyzer (CORPUS-001) | Designed | `jiras/CORPUS-001_automated_distillation_pipeline.md` |

---

## Part 12: Future Work (v1.5)

**Pattern Promoter reinforcement_count integration** — Use `reinforcement_count` as a promotion signal. Higher reinforcement = stronger evidence for promotion.

**Per-primitive narratives** — v1 builds cross-cutting narratives only. If these prove too generic, add per-skill summaries ("For email-outreach specifically, this expert prefers...").

**Usage feedback loop** — When `resolve_overlays` injects overlays into a prompt, log `overlay_id` in session metadata. Post-session, if successful, increment `reinforcement_count`. This closes the loop between "memory written" and "memory helped."

**Recency weighting** — Annotate recency-buffer overlays with temporal context ("[recent]" / "[established]") so agents see explicit recency signal.

**PR escalation** — When a transcript overlay is promoted to `scope='base'` with strong evidence, propose a permanent change to the skill's `base_prompt` via the agent PR pipeline.

**Frontend memory management UI** — A dedicated page for browsing, editing, and managing transcript-derived overlays and narratives.
