# LELE-023: Restore OpenAI Embeddings in Knowledge Ingestion

## Problem

The ingestion pipeline was changed to use **dummy embeddings** (fixed-dimension zero vectors) so the worker could run without `OPENAI_API_KEY`. That keeps inserts compatible with `knowledge_chunks.embedding VECTOR(1536)` but **removes semantic signal**: every chunk shares the same vector, so **vector similarity / HNSW retrieval is effectively useless**. Hybrid search may still use full-text (`search_vector`), but embedding-based RAG no longer reflects document content.

## Context

- **`ingestion/embedder.py`** — should call OpenAI `text-embedding-3-small` (1536-d) when configured, matching `backend/migrations/023_knowledge_corpus.sql`.
- **`ingestion/worker.py`** — loads env from repo-root `.env`; logs when skipping OpenAI / using dummy path.
- **Env**: `OPENAI_API_KEY` (never commit values; document in `.env.example` only as placeholder).

## Proposed approach

1. **Primary path**: When `OPENAI_API_KEY` is set and non-empty, `embed_batch()` uses the OpenAI Python client and `text-embedding-3-small` (or documented successor with same dimension), batching as before.
2. **Fallback path**: When the key is missing, keep a clearly logged dev-only behavior (dummy vectors or “embeddings skipped” policy) so local runs do not crash; document trade-offs in `README.md` or ingestion README if added.
3. **Docs**: Update `.env.example` with `OPENAI_API_KEY=` and a one-line note that real RAG requires it. Optionally add a short comment in `ingestion/embedder.py` about dimension contract with Postgres.

## Acceptance Criteria

- [ ] With `OPENAI_API_KEY` set, ingested chunks store **non-trivial** 1536-d vectors (verified by spot-checking DB or a small test that embeddings differ across distinct texts).
- [ ] Without `OPENAI_API_KEY`, ingestion still completes without uncaught failures, with **explicit** logs that vector quality is degraded (current dummy or agreed fallback).
- [ ] `.env.example` mentions `OPENAI_API_KEY` for embedding-backed knowledge search.
- [ ] No secrets committed; only env var names and non-sensitive examples in docs.
