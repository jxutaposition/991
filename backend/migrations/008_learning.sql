-- Learning lifecycle: agent definitions in DB, feedback signals, workflows, tiers, client context

-- ============================================================================
-- AGENT DEFINITIONS (replaces file-based agent catalog as source of truth)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    intents TEXT[] DEFAULT '{}',
    system_prompt TEXT NOT NULL,
    tools TEXT[] DEFAULT '{}',
    judge_config JSONB DEFAULT '{"threshold": 7.0, "rubric": [], "need_to_know": []}'::jsonb,
    input_schema JSONB DEFAULT '{}'::jsonb,
    output_schema JSONB DEFAULT '{}'::jsonb,
    examples JSONB DEFAULT '[]'::jsonb,
    knowledge_docs TEXT[] DEFAULT '{}',
    max_iterations INT DEFAULT 15,
    model TEXT,
    skip_judge BOOLEAN DEFAULT FALSE,
    flexible_tool_use BOOLEAN DEFAULT FALSE,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
    version INT NOT NULL,
    snapshot JSONB NOT NULL,
    change_summary TEXT,
    change_source TEXT,
    source_pr_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, version)
);

CREATE INDEX IF NOT EXISTS agent_versions_agent_idx ON agent_versions(agent_id);

-- ============================================================================
-- FEEDBACK SIGNALS (unified learning pipeline)
-- ============================================================================

CREATE TABLE IF NOT EXISTS feedback_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_slug TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    authority TEXT NOT NULL,
    weight REAL NOT NULL,
    session_id UUID,
    sequence_ref INT,
    description TEXT NOT NULL,
    expert_approach TEXT,
    agent_approach TEXT,
    impact TEXT NOT NULL,
    resolution TEXT,
    resolved_pr_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feedback_signals_agent_idx ON feedback_signals(agent_slug);
CREATE INDEX IF NOT EXISTS feedback_signals_unresolved_idx
    ON feedback_signals(agent_slug, impact) WHERE resolution IS NULL;

-- ============================================================================
-- CLIENTS (context model for who the work is for)
-- ============================================================================

CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    brief TEXT,
    industry TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT,
    email TEXT,
    slack_id TEXT,
    notes TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_contacts_client_idx ON client_contacts(client_id);

CREATE TABLE IF NOT EXISTS client_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    workflow_slug TEXT,
    state_key TEXT NOT NULL,
    state_value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, workflow_slug, state_key)
);

CREATE INDEX IF NOT EXISTS client_state_lookup_idx ON client_state(client_id, workflow_slug);

-- ============================================================================
-- WORKFLOWS (saved DAG templates)
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    client_id UUID REFERENCES clients(id),
    version INT NOT NULL DEFAULT 1,
    schedule TEXT,
    next_run_at TIMESTAMPTZ,
    created_from_session UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflows_schedule_idx
    ON workflows(next_run_at) WHERE schedule IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    step_number INT NOT NULL,
    agent_slug TEXT NOT NULL,
    task_description_template TEXT,
    requires UUID[] DEFAULT '{}',
    tier_override TEXT,
    breakpoint BOOLEAN DEFAULT FALSE,
    config JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_steps_workflow_idx ON workflow_steps(workflow_id);

-- ============================================================================
-- AGENT RUN HISTORY (for tier computation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_run_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_slug TEXT NOT NULL,
    task_fingerprint TEXT NOT NULL,
    session_id UUID NOT NULL,
    node_id UUID NOT NULL,
    status TEXT NOT NULL,
    judge_score REAL,
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_run_history_lookup_idx
    ON agent_run_history(agent_slug, task_fingerprint);

-- ============================================================================
-- ALTER EXISTING TABLES
-- ============================================================================

ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS computed_tier TEXT;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS tier_override TEXT;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS breakpoint BOOLEAN DEFAULT FALSE;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS workflow_id UUID;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS workflow_step_id UUID;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS client_id UUID;

ALTER TABLE execution_sessions ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE execution_sessions ADD COLUMN IF NOT EXISTS workflow_id UUID;

ALTER TABLE abstracted_tasks ADD COLUMN IF NOT EXISTS expert_heuristic TEXT;

ALTER TABLE agent_prs ADD COLUMN IF NOT EXISTS proposed_changes JSONB;
