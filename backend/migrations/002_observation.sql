-- Observation layer: browser extension captures + real-time narrator distillations

CREATE TABLE IF NOT EXISTS observation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expert_id UUID NOT NULL,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'recording',
    -- recording | completed | flagged | archived
    coverage_score FLOAT,
    event_count INT DEFAULT 0,
    distillation_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES observation_sessions(id),
    sequence_number BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    -- click | navigation | form_submit | focus_change | screenshot | heartbeat
    url TEXT,
    domain TEXT,
    dom_context JSONB,
    screenshot_key TEXT,  -- MinIO/S3 object key
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (session_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS action_events_session_seq_idx
    ON action_events (session_id, sequence_number);

CREATE INDEX IF NOT EXISTS action_events_session_type_idx
    ON action_events (session_id, event_type);

CREATE TABLE IF NOT EXISTS distillations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES observation_sessions(id),
    sequence_ref BIGINT NOT NULL,
    narrator_text TEXT NOT NULL,
    expert_correction TEXT,
    model TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS distillations_session_idx
    ON distillations (session_id, sequence_ref);

-- Extraction pipeline outputs
CREATE TABLE IF NOT EXISTS abstracted_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES observation_sessions(id),
    description TEXT NOT NULL,
    embedding VECTOR(1536),
    matched_agent_slug TEXT,
    match_confidence FLOAT,
    match_rank INT,
    status TEXT NOT NULL DEFAULT 'pending',
    -- pending | matched | unmatched | flagged_for_review
    pr_id UUID,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS abstracted_tasks_embedding_idx
    ON abstracted_tasks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS abstracted_tasks_session_idx
    ON abstracted_tasks (session_id);

CREATE INDEX IF NOT EXISTS abstracted_tasks_status_idx
    ON abstracted_tasks (status);

CREATE TABLE IF NOT EXISTS unmatched_task_clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_ids UUID[] NOT NULL DEFAULT '{}',
    centroid_embedding VECTOR(1536),
    proposed_slug TEXT,
    pr_id UUID,
    status TEXT DEFAULT 'accumulating',
    -- accumulating | ready_to_draft | drafted
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_prs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pr_type TEXT NOT NULL,
    -- enhancement | new_agent | example_addition | reclassification
    target_agent_slug TEXT,
    proposed_slug TEXT,
    file_diffs JSONB NOT NULL DEFAULT '[]',
    reasoning TEXT NOT NULL DEFAULT '',
    gap_summary TEXT,
    evidence_task_ids UUID[] DEFAULT '{}',
    evidence_session_ids UUID[] DEFAULT '{}',
    confidence FLOAT,
    evidence_count INT DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    -- open | approved | rejected | auto_merged
    auto_merge_eligible BOOL DEFAULT FALSE,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    reject_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_prs_status_idx ON agent_prs (status);
CREATE INDEX IF NOT EXISTS agent_prs_slug_idx ON agent_prs (target_agent_slug);
