-- SD-006 Part 8: Knowledge access logging for Observatory.
-- Tracks which chunks/overlays are actually retrieved at runtime.

CREATE TABLE IF NOT EXISTS knowledge_access_log (
    id BIGSERIAL PRIMARY KEY,
    access_type TEXT NOT NULL
        CHECK (access_type IN ('chunk_retrieval', 'overlay_injection', 'narrative_injection')),
    resource_id UUID NOT NULL,
    session_id UUID,
    node_id UUID,
    query_text TEXT,
    similarity_score REAL,
    accessed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kal_resource ON knowledge_access_log(resource_id);
CREATE INDEX IF NOT EXISTS idx_kal_type_time ON knowledge_access_log(access_type, accessed_at DESC);
