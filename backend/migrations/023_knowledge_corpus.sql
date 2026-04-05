-- SD-003 Part 9: Knowledge corpus tables for expert document ingestion and RAG retrieval.

-- Raw uploaded documents (metadata + pointer to S3-stored content)
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    expert_id UUID REFERENCES experts(id) ON DELETE SET NULL,

    -- File identity
    source_filename TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_folder TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'text/markdown',
    storage_key TEXT NOT NULL,
    file_hash TEXT NOT NULL,

    -- Processing output
    normalized_markdown TEXT,
    chunk_count INTEGER DEFAULT 0,

    -- Path-based scope inference (Part 10)
    inferred_scope TEXT CHECK (inferred_scope IN ('expert', 'client', 'project')),
    inferred_scope_id UUID,

    -- Pipeline status
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'error')),
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_documents_tenant_status_idx
    ON knowledge_documents(tenant_id, status);
CREATE INDEX IF NOT EXISTS knowledge_documents_hash_idx
    ON knowledge_documents(file_hash);
CREATE INDEX IF NOT EXISTS knowledge_documents_folder_idx
    ON knowledge_documents(tenant_id, source_folder);

-- Chunked and embedded content for vector retrieval
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,

    content TEXT NOT NULL,
    section_title TEXT,
    chunk_index INTEGER NOT NULL,
    token_count INTEGER,
    embedding VECTOR(1536),

    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_hnsw_idx
    ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_idx
    ON knowledge_chunks(tenant_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
    ON knowledge_chunks(document_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_project_idx
    ON knowledge_chunks(project_id);

-- Extend overlay source values to support new learning channels (Part 7)
ALTER TABLE overlays DROP CONSTRAINT IF EXISTS overlays_source_check;
ALTER TABLE overlays ADD CONSTRAINT overlays_source_check
    CHECK (source IN ('feedback', 'manual', 'shadowing', 'promoted',
                      'corpus', 'execution', 'transcript'));
