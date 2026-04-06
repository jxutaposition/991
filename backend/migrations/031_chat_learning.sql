-- 031: Chat Learning Pipeline — periodic extraction of learnings from chat transcripts
-- into scoped overlays. Three-stage pipeline: extract → distill → synthesize narratives.

-- ============================================================================
-- 1. Session analysis tracking
-- ============================================================================

ALTER TABLE execution_sessions
    ADD COLUMN IF NOT EXISTS learning_analyzed_at TIMESTAMPTZ;
ALTER TABLE execution_sessions
    ADD COLUMN IF NOT EXISTS analysis_skip BOOLEAN DEFAULT FALSE;
ALTER TABLE execution_sessions
    ADD COLUMN IF NOT EXISTS analysis_failure_count INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS sessions_learning_pending_idx
    ON execution_sessions(created_at DESC)
    WHERE learning_analyzed_at IS NULL AND analysis_skip = FALSE;

-- ============================================================================
-- 2. Overlay reinforcement, decay, and retirement
-- ============================================================================

ALTER TABLE overlays
    ADD COLUMN IF NOT EXISTS reinforced_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE overlays
    ADD COLUMN IF NOT EXISTS reinforcement_count INT DEFAULT 1;
ALTER TABLE overlays
    ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS overlays_active_idx
    ON overlays(primitive_type, primitive_id)
    WHERE retired_at IS NULL;

-- ============================================================================
-- 3. Scope narratives — holistic summaries per scope (ChatGPT-inspired)
-- ============================================================================

CREATE TABLE IF NOT EXISTS scope_narratives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope TEXT NOT NULL,
    scope_id UUID,
    narrative_text TEXT NOT NULL,
    narrative_text_user TEXT,
    source_overlay_count INT NOT NULL DEFAULT 0,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS scope_narratives_unique_idx
    ON scope_narratives(scope, COALESCE(scope_id::text, ''));

CREATE INDEX IF NOT EXISTS scope_narratives_lookup_idx
    ON scope_narratives(scope, scope_id);

-- ============================================================================
-- 4. Chat learnings — intermediate staging table for extracted candidates
-- ============================================================================

CREATE TABLE IF NOT EXISTS chat_learnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
    learning_text TEXT NOT NULL,
    suggested_scope TEXT NOT NULL,
    suggested_primitive_slug TEXT,
    confidence TEXT NOT NULL DEFAULT 'medium',
    evidence TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    conflicting_overlay_id UUID REFERENCES overlays(id),
    overlay_id UUID REFERENCES overlays(id),
    source_node_id UUID,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_learnings_session_idx ON chat_learnings(session_id);
CREATE INDEX IF NOT EXISTS chat_learnings_status_idx ON chat_learnings(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS chat_learnings_conflict_idx ON chat_learnings(status) WHERE status = 'conflict';
