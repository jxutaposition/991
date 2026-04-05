-- Conversational editing: threaded discussions anchored to description sections.
-- Users can highlight text, ask questions, or request AI edits on specific
-- parts of the system description.

CREATE TABLE IF NOT EXISTS description_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES execution_sessions(id) ON DELETE CASCADE,
    node_id UUID REFERENCES execution_nodes(id) ON DELETE CASCADE,
    section_path TEXT NOT NULL,    -- e.g. 'architecture.purpose', 'io_contract', '_buddy'
    highlighted_text TEXT,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved', 'archived')),
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS description_threads_session_idx
    ON description_threads(session_id);
CREATE INDEX IF NOT EXISTS description_threads_node_idx
    ON description_threads(node_id);

CREATE TABLE IF NOT EXISTS description_thread_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES description_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    description_patch JSONB,      -- if assistant made a change, the diff
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS description_thread_messages_thread_idx
    ON description_thread_messages(thread_id, created_at);
