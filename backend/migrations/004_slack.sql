-- Slack integration: channel/thread mappings and clarification flow

CREATE TABLE IF NOT EXISTS slack_channel_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slack_team_id TEXT NOT NULL,
    slack_channel_id TEXT NOT NULL,
    slack_user_id TEXT,
    session_id UUID REFERENCES execution_sessions(id),
    thread_ts TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slack_mapping_session_idx
    ON slack_channel_mappings (session_id);

CREATE INDEX IF NOT EXISTS slack_mapping_thread_idx
    ON slack_channel_mappings (slack_channel_id, thread_ts);

-- Support conversational clarification flow
ALTER TABLE execution_nodes
    ADD COLUMN IF NOT EXISTS clarification_request TEXT,
    ADD COLUMN IF NOT EXISTS clarification_response TEXT;
