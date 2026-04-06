-- Soft-delete support for workspaces (clients table).
-- deleted_at != NULL means the workspace is soft-deleted.
-- deleted_by records who initiated the deletion.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id);
