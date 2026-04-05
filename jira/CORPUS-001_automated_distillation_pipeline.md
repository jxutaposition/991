# CORPUS-001: Automated Distillation Pipeline (Corpus Analyzer)

**Type**: Feature
**Priority**: High
**Status**: Backlog
**Dependencies**: Knowledge ingestion pipeline (built), overlay system (built), Pattern Promoter (built)

---

## Summary

When a knowledge document reaches `status='ready'` after ingestion, an LLM-based Corpus Analyzer reads the normalized markdown and extracts actionable lessons, preferences, and rules. These are written as overlays scoped by the document's `inferred_scope`. The Pattern Promoter then handles promotion through the scope hierarchy as usual.

This is the missing bridge between raw uploaded knowledge and permanent agent behavior. Currently, uploaded documents are only available via RAG search (`search_knowledge`). The Corpus Analyzer would additionally distill them into overlays that are injected directly into agent prompts — the "always-on" knowledge path.

## Motivation

The expert uploads a playbook that says "Never include VP titles in banking lead lists — VP in banking is junior-level." Today, an agent would only find this if it happens to call `search_knowledge` with the right query. With the Corpus Analyzer, this rule gets extracted as an overlay and injected into every relevant agent's system prompt automatically.

Two knowledge paths, both needed:
- **RAG** (search_knowledge): agent pulls detailed reference material on-demand ("what are the 12 ICP criteria for enterprise fintech?")
- **Overlays** (Corpus Analyzer): system pushes distilled rules permanently into agent prompts ("exclude VP titles in banking")

## Design

### Trigger

Poll-based background job, matching the Pattern Promoter pattern:

```sql
SELECT id, normalized_markdown, inferred_scope, inferred_scope_id,
       tenant_id, project_id, expert_id, source_filename, source_path
FROM knowledge_documents
WHERE status = 'ready'
  AND analyzed_at IS NULL
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED
```

On claim, set `analyzed_at = NOW()` immediately to prevent double-processing. On failure, set `analyzed_at = NULL` to retry.

### Extraction

Send the full `normalized_markdown` (or first ~30,000 chars for large docs) to Claude with a structured extraction prompt:

```
System: You analyze expert knowledge documents and extract actionable rules,
preferences, and constraints that should guide AI agent behavior. Each lesson
must be specific and prescriptive — not a summary of the document.

Only extract rules that represent a clear preference, constraint, or
methodology that an agent should follow. Skip purely informational content
that is better served by RAG retrieval.

Output JSON array:
[
  {
    "lesson": "Never include VP titles in banking industry lead lists — VP in banking is a junior-level title",
    "primitive_type": "skill",
    "primitive_slug": "clay-lead-gen",
    "confidence": "high",
    "evidence": "Document explicitly states this as a rule in the 'Title Filtering' section"
  }
]
```

### Overlay Writes

For each extracted lesson:
1. Look up `primitive_id` from the skill/tool slug
2. Determine scope from the document's `inferred_scope`:
   - `expert` → `scope='expert'`, `scope_id=expert_id`
   - `client` → `scope='client'`, `scope_id=tenant_id`
   - `project` → `scope='project'`, `scope_id=project_id`
3. Write overlay with `source='corpus'`
4. Store metadata linking back to the source document:

```json
{
  "document_id": "uuid",
  "source_filename": "expert-program-tiering.md",
  "source_path": "client/heyreach/program/expert-program-tiering.md",
  "confidence": "high",
  "evidence": "Document explicitly states..."
}
```

### Downstream

Pattern Promoter already processes overlays regardless of `source` value. Corpus-derived overlays participate in the same promotion pipeline: project → client → expert → base. No changes needed.

## Schema Change

```sql
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS
    analyzed_at TIMESTAMPTZ;
```

This column is added in migration 028 alongside the hybrid search schema changes.

## Implementation Options

**Option A: Rust background task** (recommended)
- Follow `pattern_promoter.rs` pattern: `spawn_scheduler()` with a configurable interval
- Uses existing `AnthropicClient` for Claude calls
- Uses existing overlay write pattern from `project_learner.rs`
- Single language, no cross-process coordination

**Option B: Python job in ingestion worker**
- Add as a post-processing step after `status='ready'` in `worker.py`
- Would need an Anthropic Python client dependency
- Keeps all document processing in one process

## Acceptance Criteria

- [ ] Background job polls for `status='ready' AND analyzed_at IS NULL` documents
- [ ] Claude extracts actionable lessons with primitive_slug, confidence, evidence
- [ ] Extracted lessons are written as overlays with `source='corpus'` at the correct scope
- [ ] Overlay metadata links back to source document for traceability
- [ ] Pattern Promoter successfully promotes corpus-derived overlays
- [ ] Job is idempotent: re-running on an already-analyzed document is a no-op
- [ ] Errors are logged and don't block other documents from processing
- [ ] Documents with no extractable lessons get `analyzed_at` set (not re-processed)

## Open Questions

1. **Primitive slug resolution**: The LLM may output skill slugs that don't exist. Should we create a fuzzy-match against the skill catalog, or reject unmatched lessons?
2. **Re-analysis**: If a document is re-uploaded (same `file_hash`), should we re-analyze? Or deduplicate based on hash?
3. **Confidence threshold**: Should we only write overlays for "high" confidence extractions, or also "medium"?
4. **Rate limiting**: For a bulk upload of 50 documents, the analyzer would make 50 Claude calls. Should we throttle?

## Reference Code

- `backend/src/project_learner.rs` — overlay write pattern (extract lesson → store as overlay)
- `backend/src/pattern_promoter.rs` — background scheduler pattern (poll interval, shutdown signal)
- `backend/src/agent_runner.rs` — `AnthropicClient` usage for structured extraction
- `system_design/SD-003_orchestrator_primitives_and_learning.md` Part 8 — original Corpus Analyzer spec
