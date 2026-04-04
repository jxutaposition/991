-- Project-scoped credentials (override client-level defaults) and project membership.

-- Per-project credential overrides.  Resolution order:
--   project_credentials[project_id][slug]
--     → client_credentials[client_id][slug]
--       → global env fallback
CREATE TABLE IF NOT EXISTS project_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    integration_slug TEXT NOT NULL,
    credential_type TEXT NOT NULL DEFAULT 'api_key',
    encrypted_value BYTEA NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, integration_slug)
);

CREATE INDEX IF NOT EXISTS project_credentials_project_idx
    ON project_credentials(project_id);

-- Project membership: who can access a project (and its credentials).
-- A user with a role on the parent client automatically has access to all
-- projects under that client (inherited).  project_members grants access to
-- users who don't have a client-level role, or elevates their project-specific
-- permissions.
CREATE TABLE IF NOT EXISTS project_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    invited_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_project_idx ON project_members(project_id);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id);
