-- Agent catalog index (rebuilt from backend/agents/ at startup)
-- Stores embeddings for LLM planner semantic search.
-- The files on disk are the source of truth; this table is a cache.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_catalog_index (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    intents TEXT[] NOT NULL DEFAULT '{}',
    embedding VECTOR(1536),
    agent_git_sha TEXT NOT NULL DEFAULT 'unknown',
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_catalog_embedding_idx
    ON agent_catalog_index USING hnsw (embedding vector_cosine_ops);
