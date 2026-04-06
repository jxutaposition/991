-- Performance indexes for frequently-queried columns lacking index coverage.

-- execution_sessions: filtered by (client_id, status) on dashboard and session lists
CREATE INDEX IF NOT EXISTS execution_sessions_client_status_idx
    ON execution_sessions(client_id, status);

-- execution_sessions: ORDER BY created_at DESC on session listings
CREATE INDEX IF NOT EXISTS execution_sessions_created_idx
    ON execution_sessions(created_at DESC);

-- execution_nodes: ancestor traversal queries use (session_id, parent_uid)
CREATE INDEX IF NOT EXISTS execution_nodes_parent_idx
    ON execution_nodes(session_id, parent_uid);

-- execution_nodes: agent run history lookups by (agent_slug, created_at)
CREATE INDEX IF NOT EXISTS execution_nodes_agent_created_idx
    ON execution_nodes(agent_slug, created_at DESC);

-- feedback_signals: pipeline groups by (agent_slug, signal_type)
CREATE INDEX IF NOT EXISTS feedback_signals_agent_signal_idx
    ON feedback_signals(agent_slug, signal_type);
