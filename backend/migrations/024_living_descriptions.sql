-- Living System Description: project-level descriptions, rich node descriptions, issue tracking
-- SD-005: The description is the fundamental unit — it starts as a design document,
-- serves as the execution blueprint, and persists as living system documentation.

-- ============================================================================
-- PROJECT-LEVEL DESCRIPTIONS (versioned, persists across sessions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_descriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT,                             -- 1-3 paragraph system overview
    architecture JSONB DEFAULT '{}'::jsonb,   -- system architecture narrative
    data_flows JSONB DEFAULT '[]'::jsonb,     -- how data moves between components
    integration_map JSONB DEFAULT '{}'::jsonb,-- which platforms, how they connect
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_descriptions_project_idx
    ON project_descriptions(project_id);

-- ============================================================================
-- VERSION HISTORY FOR PROJECT DESCRIPTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_description_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_description_id UUID NOT NULL
        REFERENCES project_descriptions(id) ON DELETE CASCADE,
    version INT NOT NULL,
    snapshot JSONB NOT NULL,                  -- full state at this version
    change_summary TEXT,
    change_source TEXT NOT NULL,              -- 'planner'|'user_edit'|'chat_agent'|'execution_result'
    changed_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_description_versions_desc_idx
    ON project_description_versions(project_description_id, version);

-- ============================================================================
-- RICH DESCRIPTION ON EXECUTION NODES
-- ============================================================================
-- Structured JSONB containing: display_name, architecture, technical_spec,
-- io_contract, optionality, visual_refs, prior_artifacts.
-- Operational data (blockers, health, artifacts) is derived from real system data.

ALTER TABLE execution_nodes
    ADD COLUMN IF NOT EXISTS description JSONB DEFAULT '{}'::jsonb;

-- ============================================================================
-- LINK SESSIONS TO PROJECT DESCRIPTIONS
-- ============================================================================

ALTER TABLE execution_sessions
    ADD COLUMN IF NOT EXISTS project_description_id UUID
        REFERENCES project_descriptions(id);

-- ============================================================================
-- ISSUE / BLOCKER TRACKING PER NODE
-- ============================================================================
-- Lightweight issue tracker. Auto-created by preflight for credential issues.
-- Manually or agent-created for decisions, manual steps, external dependencies.

CREATE TABLE IF NOT EXISTS node_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
    issue_type TEXT NOT NULL
        CHECK (issue_type IN ('credential', 'manual', 'decision', 'external', 'technical')),
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved', 'dismissed')),
    source TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('preflight', 'agent', 'user', 'system')),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS node_issues_node_idx ON node_issues(node_id);
CREATE INDEX IF NOT EXISTS node_issues_session_status_idx ON node_issues(session_id, status);
