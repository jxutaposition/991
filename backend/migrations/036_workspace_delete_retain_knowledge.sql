-- Hard-delete workspaces while retaining knowledge corpus for a user.
-- Adds library_user_id + nullable tenant_id on knowledge tables.

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS library_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS library_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_tenant_id_fkey;
ALTER TABLE knowledge_documents ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES clients(id) ON DELETE SET NULL;

ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS knowledge_chunks_tenant_id_fkey;
ALTER TABLE knowledge_chunks ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE knowledge_chunks
  ADD CONSTRAINT knowledge_chunks_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS knowledge_documents_library_user_idx
  ON knowledge_documents (library_user_id)
  WHERE tenant_id IS NULL;
