-- Binary file upload support for the Knowledge Corpus.
-- Stores raw binary content as base64 so Docling can convert to markdown.
-- No S3 dependency — files stored directly in Postgres for simplicity.

-- Raw binary content (base64-encoded) for non-text files
ALTER TABLE knowledge_documents
    ADD COLUMN IF NOT EXISTS raw_content TEXT;

-- Track the original file size for display purposes
ALTER TABLE knowledge_documents
    ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;

-- Track if this document was extracted from a zip archive
ALTER TABLE knowledge_documents
    ADD COLUMN IF NOT EXISTS parent_document_id UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS knowledge_documents_parent_idx
    ON knowledge_documents(parent_document_id);
