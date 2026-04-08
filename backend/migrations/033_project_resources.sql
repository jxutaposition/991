-- SD-008: Project Resources — discovered/linked external artifacts
-- Stores what exists in external systems (Clay tables, n8n workflows, etc.)
-- Distinct from credentials (which store API keys); a credential gives access,
-- a resource IS a specific Clay table or n8n workflow.

CREATE TABLE IF NOT EXISTS project_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    integration_slug TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    external_url TEXT,
    display_name TEXT NOT NULL,
    discovered_metadata JSONB DEFAULT '{}'::jsonb,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, integration_slug, external_id)
);

CREATE INDEX IF NOT EXISTS project_resources_project_idx
    ON project_resources(project_id);
CREATE INDEX IF NOT EXISTS project_resources_integration_idx
    ON project_resources(project_id, integration_slug);
