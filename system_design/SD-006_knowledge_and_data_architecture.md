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

Context prefix: "This chunk is from an uploaded partner tiering playbook, which defines recognition tiers based on engagement signals, referrals, and revenue contribution."

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

Vector-only search fails on exact terms common in GTM content: product names ("Clay", customer names), acronyms ("ICP", "MRR", "ARR"), and technical identifiers ("n8n", "RLS"). BM25 catches these via exact keyword matching. RRF combines both signals without requiring score normalization.

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
| Transcript Analyzer (Chat Learning Pipeline) | Built | `backend/src/chat_analyzer.rs`, see [SD-007](SD-007_chat_learning_pipeline.md) |
| HTTP search endpoint hybrid upgrade | Pending | `backend/src/routes.rs` `knowledge_search()` still uses vector-only |
| Local workspace directory auto-sync into corpus | Designed (GAP WS2) | Not implemented |
| Knowledge Observatory UI | Designed (Part 8) | Not implemented |
| Knowledge Access Log (`knowledge_access_log`) | Designed (Part 8) | Not implemented |

---

## Part 8: Knowledge Observatory

### Motivation

The system has five memory layers (Part 1), a multi-channel learning pipeline (Part 5), and a corpus with hybrid search (Parts 2-4). But there is no unified view that shows a user what the system knows, how that knowledge was acquired, how it has been transformed, and whether it is actually being used. Each piece — corpus documents, chat learnings, feedback signals, overlays, scope narratives — lives behind separate API endpoints and UI pages with no connective tissue.

The Knowledge Observatory is a single page that renders the **complete knowledge hierarchy** for a workspace as a collapsible accordion tree. Each level shows real row counts and can be expanded to inspect the actual data. The structure mirrors the data flow: raw sources at the top, processing in the middle, distilled knowledge at the bottom.

### Design Principle: The Knowledge Tree

The observatory presents knowledge as a nested tree that maps directly to the scope hierarchy and data flow. The user sees the same mental model an engineer would draw on a whiteboard, but populated with live data.

```
Expert: jordan@company.com
│
├── Your Knowledge (expert-scoped — follows you to every workspace)
│   ├── Uploaded Corpus
│   │   └── me/ — N documents → M chunks
│   │       └── [expand: document list with status, chunk count, last accessed]
│   ├── Learned Overlays (scope=expert)
│   │   ├── N promoted from workspaces (source=promoted)
│   │   └── M manual (source=manual)
│   │       └── [expand: overlay content + provenance]
│   └── Agent Knowledge (static, bundled per agent)
│       ├── clay_operator — 3 docs
│       ├── n8n_operator — 7 docs
│       └── ...
│           └── [expand: markdown preview of each knowledge doc]
│
├── Workspace: "Acme Corp" (client-scoped)
│   │
│   ├── 1. Knowledge Corpus
│   │   ├── Summary: N documents (ready/pending/error) → M chunks
│   │   ├── By folder:
│   │   │   ├── client/acme/ — K docs
│   │   │   └── client/acme/q2-campaign/ — J docs
│   │   │       └── [expand: document list with filename, status, chunk count, created_at]
│   │   ├── Chunks: M total across N documents
│   │   │   └── [expand: chunks grouped by document, showing content preview
│   │   │        + section_title + token_count]
│   │   └── Retrieval Activity
│   │       ├── N retrievals (last 7 days)
│   │       └── Top accessed:
│   │           └── [expand: chunk content preview + document name
│   │                + hit count + avg similarity]
│   │
│   ├── 2. Chat Learning
│   │   ├── Summary: N sessions analyzed → M learnings extracted
│   │   ├── Learnings by status:
│   │   │   ├── Applied → overlays: K
│   │   │   ├── Pending conflicts: J
│   │   │   ├── Pending review: I
│   │   │   └── Rejected: H
│   │   │       └── [expand: learning text + source session + status + created_at]
│   │   └── Scope Narratives: N generated
│   │       └── [expand: narrative text + scope + source_overlay_count + generated_at]
│   │
│   ├── 3. Feedback
│   │   ├── Summary: N signals → M patterns → K PRs
│   │   ├── Signals by type:
│   │   │   ├── Expert corrections: N (weight: ground_truth)
│   │   │   ├── User thumbs: M (weight: user)
│   │   │   ├── Automated checks: K (weight: automated)
│   │   │   └── Inferred: J (weight: inferred)
│   │   │       └── [expand: signal text + authority + weight
│   │   │            + agent_slug + created_at]
│   │   ├── Active Patterns: N detected
│   │   │   └── [expand: pattern description + session_count
│   │   │        + severity + agent_slug]
│   │   └── Agent PRs: N proposed
│   │       ├── Open: K
│   │       └── Applied: J
│   │           └── [expand: PR summary + target_agent + confidence
│   │                + evidence_count + diff]
│   │
│   ├── 4. Observations
│   │   ├── Summary: N sessions → M distillations
│   │   └── [expand: session list with distillation count + created_at]
│   │
│   ├── 5. Learned Knowledge (overlays, client-scoped)
│   │   ├── Summary: N active overlays
│   │   ├── By source:
│   │   │   ├── transcript: N (from chat learning)
│   │   │   ├── feedback: M (from user corrections)
│   │   │   ├── corpus: K (distilled from uploads)
│   │   │   ├── promoted: J (generalized from projects)
│   │   │   ├── manual: I (hand-written)
│   │   │   └── execution: H (from execution review)
│   │   │       └── [expand: overlay content + source + scope
│   │   │            + skill_slug + created_at]
│   │   ├── Inherited from expert-scope: M overlays (dimmed)
│   │   └── Scope Narratives: K
│   │       └── [expand: narrative text]
│   │
│   └── Projects
│       ├── "Q2 Campaign"
│       │   ├── Corpus: N docs → M chunks
│       │   ├── Overlays (project-scoped): K
│       │   │   └── Inherited from client-scope: J (dimmed)
│       │   └── [same sub-structure as workspace level]
│       └── "Onboarding Flow"
│           └── ...
```

### Why This Structure

The tree maps 1:1 to the scope hierarchy from SD-003:

```
base > expert > client > project
```

At each scope level, the user sees:

1. **What raw data exists** — corpus documents, chat sessions, feedback signals
2. **How it was processed** — chunks, learnings, patterns
3. **What knowledge was distilled** — overlays, narratives, PRs
4. **What the system inherited** from broader scopes (shown dimmed)

This answers three core questions:

- **What does the system know?** — expand any section to see the actual content
- **Where did it come from?** — overlay `source` field traces provenance (feedback, transcript, corpus, promoted, manual)
- **Is it being used?** — retrieval activity section shows hit counts per chunk (requires access logging, see below)

### Knowledge Access Logging

Currently there is no tracking of which chunks or overlays are actually retrieved at runtime. Adding a lightweight access log enables the "Retrieval Activity" section and surfaces which knowledge is high-value versus dead weight.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS knowledge_access_log (
    id BIGSERIAL PRIMARY KEY,
    access_type TEXT NOT NULL
        CHECK (access_type IN (
            'chunk_retrieval',
            'overlay_injection',
            'narrative_injection'
        )),
    resource_id UUID NOT NULL,      -- chunk_id, overlay_id, or narrative_id
    session_id UUID,                -- execution session that triggered the retrieval
    node_id UUID,                   -- specific node within the session
    query_text TEXT,                -- the search query (for chunk_retrieval only)
    similarity_score REAL,          -- cosine similarity at retrieval time
    accessed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kal_resource ON knowledge_access_log(resource_id);
CREATE INDEX idx_kal_type_time ON knowledge_access_log(access_type, accessed_at DESC);
```

**Instrumentation points:**

| Code path | What to log | access_type |
|-----------|-------------|-------------|
| `agent_runner.rs` `execute_search_knowledge()` | Each chunk returned after reranking | `chunk_retrieval` |
| `planner.rs` `gather_planner_context()` | Each chunk used in planner context | `chunk_retrieval` |
| `agent_runner.rs` overlay resolution in prompt | Each overlay resolved into the prompt | `overlay_injection` |
| `agent_runner.rs` narrative injection in prompt | Each narrative injected | `narrative_injection` |

All logging is fire-and-forget (`tokio::spawn`) so it never blocks the hot path.

**Surfacing high-value knowledge:**

```sql
-- Top accessed chunks in the last 7 days
SELECT resource_id, COUNT(*) as hit_count,
       MAX(accessed_at) as last_accessed,
       AVG(similarity_score) as avg_similarity
FROM knowledge_access_log
WHERE access_type = 'chunk_retrieval'
  AND accessed_at > NOW() - INTERVAL '7 days'
GROUP BY resource_id
ORDER BY hit_count DESC
LIMIT 20
```

High hit-count chunks are candidates for overlay distillation: if the system keeps retrieving the same chunk, its content should be promoted into a compact overlay that gets injected directly into the prompt rather than retrieved via RAG every time.

### Observatory API

**`GET /api/knowledge/observatory?tenant_id=X`**

Returns the full tree structure with counts at every level. Single Rust handler with ~8 parallel queries via `tokio::join!`. The response mirrors the tree:

```json
{
  "expert": {
    "corpus_docs": 10,
    "corpus_chunks": 320,
    "overlays": {
      "total": 20,
      "by_source": { "promoted": 15, "manual": 5 }
    },
    "agents_with_knowledge": 6
  },
  "workspace": {
    "corpus": {
      "total_documents": 32,
      "total_chunks": 960,
      "by_status": { "ready": 30, "pending": 1, "error": 1 },
      "by_folder": [
        { "folder": "client/acme", "doc_count": 25 },
        { "folder": "client/acme/q2-campaign", "doc_count": 7 }
      ]
    },
    "chat_learning": {
      "sessions_analyzed": 156,
      "total_learnings": 89,
      "by_status": {
        "applied": 45, "conflict": 3,
        "pending": 29, "rejected": 12
      },
      "narratives": 12
    },
    "feedback": {
      "total_signals": 234,
      "by_type": {
        "expert_correction": 50,
        "user_thumbs_down": 30,
        "automated": 80,
        "inferred": 74
      },
      "active_patterns": 8,
      "agent_prs": { "open": 2, "applied": 1 }
    },
    "observations": {
      "sessions": 18,
      "distillations": 45
    },
    "overlays": {
      "total_active": 60,
      "by_source": {
        "transcript": 20, "feedback": 15, "corpus": 5,
        "promoted": 10, "manual": 10
      },
      "inherited_expert": 20
    },
    "retrieval_activity": {
      "total_7d": 890,
      "top_chunks": [
        {
          "chunk_id": "...",
          "document_name": "...",
          "content_preview": "...",
          "hit_count": 45,
          "avg_similarity": 0.72
        }
      ]
    },
    "projects": [
      {
        "id": "...",
        "name": "Q2 Campaign",
        "corpus_docs": 7,
        "corpus_chunks": 210,
        "overlays": 35,
        "inherited_client": 60
      }
    ]
  }
}
```

**`GET /api/knowledge/observatory/:section?tenant_id=X&page=1&limit=20`**

Returns paginated rows for drill-down when a user expands a leaf section. The `section` path param maps to:

| Section value | Table(s) queried | Key fields returned |
|---------------|------------------|---------------------|
| `corpus_documents` | `knowledge_documents` | filename, status, chunk_count, scope, folder, created_at |
| `corpus_chunks` | `knowledge_chunks` JOIN `knowledge_documents` | content preview (200 chars), section_title, token_count, document name |
| `chat_learnings` | `chat_learnings` | learning text, status, session_id, created_at |
| `feedback_signals` | `feedback_signals` | signal_type, authority, weight, agent_slug, text, created_at |
| `feedback_patterns` | `feedback_patterns` | description, session_count, severity, agent_slug |
| `agent_prs` | `agent_prs` | pr_type, target_agent, gap_summary, confidence, status |
| `overlays` | `overlays` LEFT JOIN `skills` | content, source, scope, skill_name, created_at |
| `scope_narratives` | `scope_narratives` | narrative_text, scope, source_overlay_count, generated_at |
| `retrieval_hits` | `knowledge_access_log` JOIN `knowledge_chunks` | chunk content, document name, hit_count, last_accessed, avg_similarity |
| `agent_knowledge` | `agent_definitions` | agent slug, name, knowledge_doc count, doc previews |

### UI Implementation

**Route:** `/knowledge/observatory`

**Approach:** Collapsible accordion sections using the existing Tailwind + Radix primitive stack. No additional UI libraries required.

**Layout:**

- Full-width page with the tree structure rendered as nested collapsible sections
- Each section header shows: icon + label + count badge + expand/collapse chevron
- Expanding a summary section reveals sub-sections or a paginated data table
- Inherited overlays (from broader scopes) appear dimmed with a small "inherited" badge
- The "Retrieval Activity" section highlights high-value chunks with a heat indicator (hit count mapped to opacity/color intensity)

**Interaction pattern:**

- Default state: all top-level sections collapsed, showing only counts — the page loads fast
- Click a section header to expand; reveals sub-sections or data rows
- Leaf-level data loads on-demand via the `/:section` API (not preloaded with the summary)
- Each data row is a compact card: content preview (2-3 lines), metadata pills (status, source, scope), timestamp
- Clicking a document row navigates to `/knowledge` filtered to that document for management actions

### Relationship to Existing Pages

| Route | Purpose | Relationship |
|-------|---------|--------------|
| `/knowledge` | Document manager — upload, browse folders, search, preview markdown | Write-oriented |
| `/knowledge/observatory` | Knowledge landscape — understand what the system knows and how | Read-oriented |
| `/feedback` | Feedback signals list | Subset of observatory section 3 |
| `/agent-prs` | PR review queue | Subset of observatory section 3 |

The observatory links to these pages for actions (uploading, approving PRs) but is itself read-only. A tab or link in the nav connects `/knowledge` and `/knowledge/observatory`.
