-- Hybrid search + contextual retrieval schema additions.
--
-- Adds BM25 full-text search (tsvector + GIN) and contextual retrieval
-- prefix storage to knowledge_chunks, plus analyzed_at tracking for the
-- Corpus Analyzer on knowledge_documents.

-- Contextual retrieval: store the Claude-generated context prefix separately
-- so it can be displayed/debugged independently of the chunk content.
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS
    context_prefix TEXT;

-- BM25 full-text search: tsvector column for keyword matching.
-- Populated at ingestion time from context_prefix + content.
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS
    search_vector TSVECTOR;

CREATE INDEX IF NOT EXISTS knowledge_chunks_fts_idx
    ON knowledge_chunks USING gin(search_vector);

-- Corpus Analyzer tracking: when was this document analyzed for overlay
-- distillation? NULL means not yet analyzed.
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS
    analyzed_at TIMESTAMPTZ;
