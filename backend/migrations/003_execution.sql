-- Execution layer: sessions, nodes, events

CREATE TABLE IF NOT EXISTS execution_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID,
    request_text TEXT NOT NULL,
    plan JSONB,
    plan_approved_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'planning',
    -- planning | awaiting_approval | executing | completed | failed
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES execution_sessions(id),
    agent_slug TEXT NOT NULL,
    agent_git_sha TEXT NOT NULL DEFAULT 'unknown',
    task_description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    -- pending | waiting | ready | running | passed | failed | skipped
    requires UUID[] DEFAULT '{}',
    attempt_count INT DEFAULT 0,
    parent_uid UUID REFERENCES execution_nodes(id),
    input JSONB,
    output JSONB,
    judge_score FLOAT,
    judge_feedback TEXT,
    judge_config JSONB DEFAULT '{"threshold": 7.0, "rubric": [], "need_to_know": []}'::jsonb,
    max_iterations INT DEFAULT 15,
    model TEXT DEFAULT 'claude-opus-4-6',
    skip_judge BOOL DEFAULT FALSE,
    token_usage JSONB,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS execution_nodes_session_status_idx
    ON execution_nodes (session_id, status);

CREATE INDEX IF NOT EXISTS execution_nodes_ready_idx
    ON execution_nodes (status)
    WHERE status IN ('ready', 'running');

CREATE TABLE IF NOT EXISTS execution_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES execution_sessions(id),
    node_id UUID REFERENCES execution_nodes(id),
    event_type TEXT NOT NULL,
    -- node_started | node_completed | tool_call | tool_result
    -- critic_start | critic_done | judge_start | judge_done
    -- judge_pass | judge_fail | judge_reject | node_retry
    -- child_agent_spawned | checkpoint_reached | session_completed
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS execution_events_session_idx
    ON execution_events (session_id);

CREATE INDEX IF NOT EXISTS execution_events_node_idx
    ON execution_events (node_id);
