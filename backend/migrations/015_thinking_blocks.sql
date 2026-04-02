-- Dedicated table for LLM extended-thinking (chain-of-thought) blocks.
-- Separate from execution_events because thinking text can be 40k+ chars
-- and would bloat the JSONB event payloads / queries.

CREATE TABLE IF NOT EXISTS thinking_blocks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES execution_sessions(id),
    node_id     UUID NOT NULL REFERENCES execution_nodes(id),
    iteration   INT NOT NULL,
    thinking_text TEXT NOT NULL,
    token_count INT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thinking_blocks_node_idx
    ON thinking_blocks (node_id, iteration);

CREATE INDEX IF NOT EXISTS thinking_blocks_session_idx
    ON thinking_blocks (session_id);
