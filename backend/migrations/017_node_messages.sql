-- 017: Node conversation messages — stores the full LLM message history per node
-- so users can view and reply to agent conversations in the UI.

CREATE TABLE IF NOT EXISTS node_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
    node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
    role TEXT NOT NULL,          -- 'user', 'assistant', 'tool_use', 'tool_result'
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,  -- tool_use_id, tool_name, tool_input, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS node_messages_node_idx ON node_messages(node_id, created_at);
CREATE INDEX IF NOT EXISTS node_messages_session_idx ON node_messages(session_id);

-- Store the full Anthropic message array on the node so we can resume conversations
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS conversation_state JSONB;
-- conversation_state stores: { "messages": [...], "system_prompt": "...", "tools": [...], "model": "..." }
