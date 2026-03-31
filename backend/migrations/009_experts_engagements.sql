-- Expert ownership and engagement model.
--
-- Experts are the subject-matter humans whose methodology shapes agents.
-- Engagements link an expert to a client for a specific contract/engagement.
-- agent_definitions.expert_id scopes agent ownership (NULL = shared/system).

-- ============================================================================
-- EXPERTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS experts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    identity TEXT,
    voice TEXT,
    methodology TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- ENGAGEMENTS (contract entity: expert + client)
-- ============================================================================

CREATE TABLE IF NOT EXISTS engagements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    expert_id UUID NOT NULL REFERENCES experts(id),
    client_id UUID NOT NULL REFERENCES clients(id),
    status TEXT NOT NULL DEFAULT 'active',
    -- active | paused | completed | handed_off
    scope TEXT,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS engagements_expert_idx ON engagements(expert_id);
CREATE INDEX IF NOT EXISTS engagements_client_idx ON engagements(client_id);
CREATE INDEX IF NOT EXISTS engagements_status_idx ON engagements(status);

-- ============================================================================
-- ADD expert_id / engagement_id TO EXISTING TABLES
-- ============================================================================

ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS expert_id UUID REFERENCES experts(id);

ALTER TABLE feedback_signals ADD COLUMN IF NOT EXISTS expert_id UUID REFERENCES experts(id);

ALTER TABLE execution_sessions ADD COLUMN IF NOT EXISTS engagement_id UUID REFERENCES engagements(id);
ALTER TABLE execution_sessions ADD COLUMN IF NOT EXISTS expert_id UUID REFERENCES experts(id);

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS engagement_id UUID REFERENCES engagements(id);

ALTER TABLE observation_sessions ADD COLUMN IF NOT EXISTS engagement_id UUID REFERENCES engagements(id);

-- ============================================================================
-- INDEXES for expert-scoped queries
-- ============================================================================

CREATE INDEX IF NOT EXISTS agent_definitions_expert_idx ON agent_definitions(expert_id);
CREATE INDEX IF NOT EXISTS feedback_signals_expert_idx ON feedback_signals(expert_id);
CREATE INDEX IF NOT EXISTS execution_sessions_engagement_idx ON execution_sessions(engagement_id);
