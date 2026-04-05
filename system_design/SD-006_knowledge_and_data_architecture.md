# SD-006: Knowledge and Data Architecture

## Summary

The system has five distinct memory layers with different lifecycles, scopes, and retrieval patterns. This document is the canonical reference for Layer 4 (Expert Corpus) and the multi-channel learning pipeline that feeds Layer 2 (Learned Knowledge). It covers ingestion, retrieval, contextual embeddings, hybrid search, and overlay distillation.

For orchestrator architecture, primitives, and overlay mechanics, see SD-003. For credential management, see SD-002. For the own-stack architectural decision, see ADR-001.

---

## Part 1: Five Memory Layers

| Layer | What | Lifecycle | Injection Method | Storage |
|-------|------|-----------|-----------------|---------|
| 1. System Knowledge | Agent methodology, tool documentation, skill prompts | Static — changes via PRs | Full text appended to system prompt | `agent_definitions.knowledge_docs`, `platform_tools.knowledge`, `skills.base_prompt` |
| 2. Learned Knowledge | Distilled lessons from feedback, observations, corpus analysis | Dynamic — grows with usage | Overlay resolution (base > expert > client > project) concatenated into prompt | `overlays` table with `source` provenance |
| 3. Execution Memory | Conversation state within a running session | Per-session | `conversation_state` JSONB reloaded per LLM call | `execution_nodes.conversation_state`, `node_messages`, `thinking_blocks` |
| 4. Expert Corpus | Uploaded playbooks, ICP docs, battle cards, transcripts | Grows continuously | RAG retrieval via `search_knowledge` tool | `knowledge_documents`, `knowledge_chunks` with pgvector |
| 5. Observation Memory | Browser extension events, screenshots, abstracted tasks | Behavioral capture | Future: pattern extraction feeds Layer 2 | `observation_sessions`, `action_events`, `abstracted_tasks` |

Layer 1 is curated methodology (rarely changes). Layer 2 is distilled lessons (small, high-signal). Layer 4 is the raw expert corpus (large, semi-structured). Layer 4 is too large for full-text prompt injection and requires RAG.

The key relationship: Layer 4 feeds Layer 2. The Corpus Analyzer reads uploaded documents and distills actionable rules into overlays. The Pattern Promoter then promotes those overlays through the scope hierarchy.

---

## Part 2: Expert Corpus Architecture

### Database Schema

**`knowledge_documents`** — one row per uploaded file:

```sql
knowledge_documents (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES clients(id),
    project_id UUID REFERENCES projects(id),
    expert_id UUID REFERENCES experts(id),
    source_filename TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_folder TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'text/markdown',
    storage_key TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    normalized_markdown TEXT,
    raw_content TEXT,                -- base64-encoded binary for non-text files
    file_size_bytes INTEGER,
    parent_document_id UUID,         -- for ZIP child documents
    chunk_count INTEGER DEFAULT 0,
    inferred_scope TEXT CHECK (inferred_scope IN ('expert', 'client', 'project')),
    inferred_scope_id UUID,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'error')),
    error_message TEXT,
    analyzed_at TIMESTAMPTZ,         -- when Corpus Analyzer last processed this doc
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

**`knowledge_chunks`** — embedded chunks for retrieval:

```sql
knowledge_chunks (
    id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES clients(id),
    project_id UUID REFERENCES projects(id),
    content TEXT NOT NULL,
    context_prefix TEXT,             -- Claude-generated contextual retrieval prefix
    section_title TEXT,
    chunk_index INTEGER NOT NULL,
    token_count INTEGER,
    embedding VECTOR(1536),
    search_vector TSVECTOR,          -- BM25 full-text search
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
)
```

**Indexes:**

- `HNSW` on `embedding` (vector cosine, m=16, ef_construction=64) — approximate nearest neighbor
- `GIN` on `search_vector` — BM25 keyword matching
- B-tree on `tenant_id`, `document_id`, `project_id`

### Folder Conventions and Scope Inference

The corpus UI presents a logical folder structure. Scope is inferred from the path:

```
me/                              → expert-scoped
client/{slug}/                   → client-scoped (tenant_id = resolved client)
client/{slug}/{project-slug}/    → project-scoped (project_id = resolved project)
skills/                          → expert-scoped
transcripts/                     → auto-detected from content
```

Physical storage is flat (Postgres `raw_content` or `normalized_markdown`). The UI reconstructs the tree from `source_path` and `source_folder`.

---

## Part 3: Ingestion Pipeline

### Architecture

```
Upload (Rust backend)                     Processing (Python ingestion worker)
─────────────────────                     ─────────────────────────────────────
POST /api/knowledge/upload                Poll knowledge_documents WHERE status='pending'
  → store content in Postgres               → Parse: Docling (PDF/DOCX/PPTX) or direct markdown
  → infer scope from source_path            → Chunk: header-aware markdown splitting
  → create knowledge_documents row          → Context: Claude generates per-chunk prefix
    with status='pending'                   → Embed: text-embedding-3-small (prefix + content)
                                            → Store: chunks + embeddings + tsvector
                                            → Update status='ready'
```

The Python worker communicates through the shared Postgres database. No HTTP sidecar.

### Format Conversion

All files are converted to readable markdown before chunking. This is the most critical step: poor extraction compounds at every downstream stage (chunking, embedding, retrieval).

| Input | Method | Output |
|-------|--------|--------|
| `.md`, `.txt` | Direct UTF-8 decode | Markdown (pass-through) |
| `.json` (Slack export) | `converters.py` — auto-detected by structure (list of `{ts, text, user}`) | Markdown with date headers, @mentions, threads |
| `.json` (generic) | `converters.py` — extracts human-readable fields, structures as sections | Markdown with field labels |
| `.csv`, `.tsv` | `converters.py` — markdown tables with headers, sectioned for large files | Markdown tables |
| `.yaml`, `.yml` | `converters.py` — section headers per top-level key | Structured markdown |
| `.toml` | `converters.py` — section headers per table | Structured markdown |
| `.xml` | `converters.py` — recursive element extraction | Structured markdown |
| `.pdf`, `.docx`, `.pptx`, `.xlsx` | Docling (MIT, handles OCR) | Structured markdown |
| `.zip` | Extract → child `knowledge_documents` rows | Per-file processing |

The conversion step runs in `ingestion/worker.py` via `converters.convert_to_markdown(content, filename)` immediately after `parse_to_markdown()` and before the chunking pipeline. This ensures the chunker always receives clean, semantically meaningful markdown regardless of original file format.

### Chunking Strategy

| Content type | Strategy | Target size |
|-------------|----------|-------------|
| Markdown playbooks | Split on `##`/`###` headers, recursive char split for oversized sections | ~500 tokens |
| Call transcripts | Split on speaker turns, merge small adjacent turns | ~400 tokens |
| Short docs (ICP, battle cards) | Keep whole if under limit | up to 800 tokens |
| PDF/DOCX/PPTX | Docling → markdown → apply markdown strategy | ~500 tokens |

Chunk overlap: 50 tokens between recursive splits to preserve boundary context.

### Contextual Retrieval (Anthropic Technique)

Before embedding, each chunk receives a Claude-generated context prefix that anchors it to the source document. This reduces retrieval failures by 49% per Anthropic's research.

**Process:**
1. After chunking, send the document's `normalized_markdown` (first 8000 chars) + all chunks to Claude
2. Claude generates a 1-2 sentence prefix per chunk identifying the document, topic, and scope
3. The prefix is prepended to the chunk content before computing the embedding
4. The prefix is also stored separately in `context_prefix` for display
5. The combined text (prefix + content) is used for the `search_vector` tsvector

**Example:**

Chunk content: "Premium partners receive amber badges and priority support"

Context prefix: "This chunk is from the HeyReach Expert Program tiering document, which defines four recognition tiers based on LinkedIn engagement, Tolt referrals, and MRR contribution."

The embedding now carries document-level meaning. The BM25 index also benefits from the prefix terms.

**Cost:** One Claude call per document (batching all chunks). With prompt caching on the document text, cost is fractions of a cent per document.

### Embedding Model

OpenAI `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens). Matches the existing `VECTOR(1536)` schema. Batch embedding during ingestion, single-query embedding at retrieval time.

---

## Part 4: Retrieval Architecture

### Design Principle: Search Then Read

The retrieval pattern follows Cursor's codebase search model: semantic search finds *where* to look, then the agent reads the original for full context. This is a two-step process:

1. **`search_knowledge`** — hybrid search returns compact results (snippets + document IDs + chunk locations)
2. **`read_knowledge`** — agent fetches full continuous text for a specific document section

This avoids wasting context window tokens on full chunk text during search (the agent may discard irrelevant results) and gives the agent control over how much detail to retrieve.

### Step 1: search_knowledge (Find)

```
Agent calls search_knowledge(query="tiering criteria for expert program")
  │
  ▼
[1] Embed query — OpenAI text-embedding-3-small (~100ms)
  │
  ▼
[2] Hybrid search — vector + BM25, merged via Reciprocal Rank Fusion (~50ms)
    • Vector: pgvector HNSW cosine similarity, threshold > 0.25
    • BM25: Postgres tsvector GIN with ts_rank_cd
    • RRF: 1/(60 + rank_vector) + 1/(60 + rank_bm25)
    • Returns top-20 candidates
  │
  ▼
[3] Neighbor expansion — fetch chunk_index ± 1 from same document (~5ms)
  │
  ▼
[4] Claude reranking — haiku scores candidates, returns top-5 (~150ms)
  │
  ▼
[5] Return COMPACT results: snippet (200 chars), context_prefix,
    section_title, document_id, chunk_index, source_path, similarity,
    has_surrounding_chunks flag
```

Total latency: ~300ms. Response includes a hint: "Use read_knowledge(document_id, chunk_index) to fetch full text around any result."

### Step 2: read_knowledge (Drill In)

```
Agent calls read_knowledge(document_id="uuid", chunk_index=42, range=5)
  │
  ▼
[1] Fetch chunks where document_id matches AND chunk_index in [40..44]
  │
  ▼
[2] Concatenate chunk content in order, with section headers
  │
  ▼
[3] Return full continuous text + document metadata + pagination hint
```

Latency: ~10ms (simple indexed query). The agent can call this multiple times to read more of the document, or read different sections.

### Hybrid Search SQL

The core query uses two CTEs (vector_results, bm25_results) merged via FULL OUTER JOIN with RRF scoring. Key details:

- **Vector CTE**: orders by `embedding <=> query_vector`, filters `similarity > 0.25`, limits 20
- **BM25 CTE**: uses `websearch_to_tsquery` for natural language query parsing, filters `search_vector @@ tsquery`, orders by `ts_rank_cd`, limits 20
- **RRF merge**: `1/(60 + rank_v) + 1/(60 + rank_b)` with COALESCE for candidates appearing in only one result set (rank defaults to 1000 for missing)
- **Scoping**: `WHERE c.tenant_id = $tenant AND (c.project_id IS NULL OR c.project_id = $project)`

### Why Hybrid Search

Vector-only search fails on exact terms common in GTM content: product names ("HeyReach", "Clay"), acronyms ("ICP", "MRR", "ARR"), and technical identifiers ("n8n", "RLS"). BM25 catches these via exact keyword matching. RRF combines both signals without requiring score normalization.

Industry benchmarks show hybrid search improves recall by 15-20% on keyword-heavy queries compared to vector-only.

### Similarity Threshold

A floor of 0.25 cosine similarity prevents returning irrelevant results when nothing in the corpus matches the query. When no results pass the threshold, the agent receives: `{"results": [], "note": "No relevant results found in the knowledge corpus."}`.

### Claude Reranking

After hybrid search returns ~20 candidates, Claude (haiku) scores each (query, candidate) pair and returns the top-5 ranked by relevance. This adds ~150ms but significantly improves precision — cross-attention scoring is fundamentally more accurate than comparing pre-computed embeddings.

The reranker is a graceful degradation: if the Claude call fails, results fall back to RRF ordering.

### Neighbor Chunk Expansion

For each matched chunk, the system also fetches `chunk_index - 1` and `chunk_index + 1` from the same document. These are attached as `context_before` and `context_after` fields, giving the agent surrounding context without requiring larger chunks (which would reduce matching precision).

### Tool Wiring

Both `search_knowledge` and `read_knowledge` are in the `always_available` tool set for all agents (alongside `read_upstream_output`, `write_output`, `request_user_action`). Every agent with a `client_id` can search and read the corpus without explicit tool configuration.

**`search_knowledge`** — find relevant content:
- `query` (required): natural language search query
- `limit` (optional, default 5, max 10): number of results to return
- Returns: compact results with `document_id`, `chunk_index`, `snippet`, `context_prefix`, `source_path`

**`read_knowledge`** — read full document sections:
- `document_id` (required): UUID from search results
- `chunk_index` (required): center chunk to read around
- `range` (optional, default 5, max 20): number of chunks to return centered on chunk_index
- Returns: concatenated continuous text, section headers, total chunk count, pagination hint

### Reprocessing API

When ingestion converters or embedding models are updated, existing documents can be reprocessed:

- `POST /api/knowledge/documents/:id/reprocess` — single document
- `POST /api/knowledge/reprocess-bulk` — bulk reprocessing with optional `extensions` filter (e.g. `["json", "csv"]`) and `tenant_id` scope

Reprocessing deletes existing chunks and resets the document to `pending` status for the ingestion worker to pick up.

---

## Part 5: Multi-Channel Learning Pipeline

### Extended Architecture

```
RAW DATA SOURCES                    LEARNING AGENTS                STORAGE
─────────────────                   ───────────────                ───────
User feedback on executions    ──→  Project Learner (real-time)  ──→  overlays (scope=project)
Browser extension observations ──→  Observation Distiller (batch) ──→  overlays (scope=project)
Expert corpus uploads          ──→  Corpus Analyzer (per-doc)     ──→  overlays (scope=expert|client)
Execution artifacts/outputs    ──→  Execution Reviewer (batch)    ──→  overlays (scope=project)
Conversation transcripts       ──→  Transcript Analyzer (per-doc) ──→  overlays (scope=project|client)
                                          │
                                    Pattern Promoter (periodic)
                                          │
                                    project → client → expert → base
                                          │
                                    (high confidence → PR into skill base_prompt)
```

### Built Feeders

**Project Learner** — real-time, runs on every feedback signal. Extracts lessons via Claude and stores as overlays at `scope='project'`, `source='feedback'`. Implemented in `backend/src/project_learner.rs`.

**Pattern Promoter** — periodic (24h), scans project-scoped overlays, clusters by LLM-based semantic similarity, promotes to broader scopes when evidence thresholds are met. Processes overlays regardless of `source` value. Implemented in `backend/src/pattern_promoter.rs`.

Evidence thresholds:
- 3+ projects for one client → promote to `scope='client'`
- 2+ clients for one expert → promote to `scope='expert'`
- 3+ experts → promote to `scope='base'`

### Designed but Not Built

**Corpus Analyzer** — triggered when `knowledge_documents` reaches `status='ready'`. Claude reads the normalized markdown and extracts actionable rules/preferences. Writes overlays scoped by the document's `inferred_scope` with `source='corpus'`. See `jira/CORPUS-001_automated_distillation_pipeline.md` for full spec.

**Observation Distiller** — processes `abstracted_tasks` from browser extension sessions. Extracts workflow lessons. `source='shadowing'`.

**Execution Reviewer** — reviews completed execution graphs for process patterns. `source='execution'`.

**Transcript Analyzer** — parses conversation transcripts for decisions and lessons. `source='transcript'`.

### Overlay Source Values

```sql
CHECK (source IN ('feedback', 'manual', 'shadowing', 'promoted',
                  'corpus', 'execution', 'transcript'))
```

### PR Escalation

When an overlay has been promoted to `scope='base'` with strong evidence (10+ source instances across multiple experts), the system can propose a permanent change to the skill's `base_prompt` via the agent PR pipeline (SD-001). This closes the loop: raw data → project overlay → promoted overlay → permanent skill methodology.

---

## Part 6: Knowledge Corpus UI

### Route: `/knowledge`

1. **File tree sidebar** — collapsible folder tree from `source_folder` values, file counts per folder
2. **Upload zone** — drag-and-drop into any folder; accepts `.md`, `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.csv`, `.zip`; shows upload progress and processing status (pending → processing → ready)
3. **File detail panel** — original filename, upload date, inferred scope (with override), normalized markdown preview, chunk list with section titles and token counts
4. **Bulk upload** — ZIP preserves internal folder structure as `source_path` entries
5. **Staleness indicators** — per-folder "last updated" timestamp
6. **Search** — full-text search across file names and normalized content (complements vector search)

### Upload API

- `POST /api/knowledge/upload` — multipart file upload, stores in Postgres, creates `knowledge_documents` row with `status='pending'`
- `POST /api/knowledge/documents` — JSON upload (base64 content), same pipeline
- `GET /api/knowledge/documents` — list documents, filtered by tenant/folder
- `GET /api/knowledge/documents/:id/progress` — processing status for UI polling
- `POST /api/knowledge/search` — HTTP search endpoint (same hybrid pipeline as agent tool)

---

## Part 7: Implementation Status

| Component | Status | Code Location |
|-----------|--------|---------------|
| `knowledge_documents` schema | Built | `migrations/023_knowledge_corpus.sql`, `026_binary_upload.sql` |
| `knowledge_chunks` with pgvector HNSW | Built | `migrations/023_knowledge_corpus.sql` |
| `context_prefix` + `search_vector` columns | Built | `migrations/028_hybrid_search_and_contextual_retrieval.sql` |
| Upload APIs (JSON + multipart) | Built | `backend/src/routes.rs` |
| Python ingestion worker (Docling, chunking, embedding) | Built | `ingestion/worker.py`, `chunker.py`, `embedder.py` |
| Format converters (JSON/Slack/CSV/YAML/TOML/XML → markdown) | Built | `ingestion/converters.py` |
| Contextual retrieval (Claude prefix generation) | Built | `ingestion/worker.py` `generate_context_prefixes()` |
| tsvector population at ingestion | Built | `ingestion/worker.py` `store_chunks_and_mark_ready()` |
| `search_knowledge` tool (compact results) | Built | `backend/src/actions.rs`, `backend/src/agent_runner.rs` |
| `read_knowledge` tool (full section retrieval) | Built | `backend/src/actions.rs`, `backend/src/agent_runner.rs` |
| Hybrid search (vector + BM25 + RRF) | Built | `backend/src/agent_runner.rs` `execute_search_knowledge()` |
| Neighbor chunk expansion | Built | `backend/src/agent_runner.rs` `execute_search_knowledge()` |
| Claude reranking | Built | `backend/src/agent_runner.rs` `rerank_with_claude()` |
| Both knowledge tools wired to all agents | Built | `backend/src/actions.rs` `always_available` |
| project_id scoping in agent search | Built | `backend/src/agent_runner.rs` |
| Reprocess endpoints (single + bulk) | Built | `backend/src/routes.rs`, `backend/src/main.rs` |
| Frontend `/knowledge` page | Built | `frontend/src/app/knowledge/page.tsx` |
| Project Learner (feedback → overlays) | Built | `backend/src/project_learner.rs` |
| Pattern Promoter (periodic promotion) | Built | `backend/src/pattern_promoter.rs` |
| Corpus Analyzer (doc → overlay distillation) | Designed | `jira/CORPUS-001_automated_distillation_pipeline.md` |
| Observation Distiller | Designed (SD-003 Part 8) | Not implemented |
| Execution Reviewer | Designed (SD-003 Part 8) | Not implemented |
| Transcript Analyzer | Designed (SD-003 Part 8) | Not implemented |
| HTTP search endpoint hybrid upgrade | Pending | `backend/src/routes.rs` `knowledge_search()` still uses vector-only |
| Local `lele/` directory auto-sync | Designed (GAP WS2) | Not implemented |
