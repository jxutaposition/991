-- Feedback robustness: weight overrides, signal dedup, pattern detection, overlay versioning

-- Per-agent weight overrides for feedback signal types
ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS weight_overrides JSONB DEFAULT '{}'::jsonb;

-- Self-referencing column for deduplication of feedback signals
ALTER TABLE feedback_signals ADD COLUMN IF NOT EXISTS canonical_signal_id UUID REFERENCES feedback_signals(id);

-- Pattern detection table for recurring failure patterns
CREATE TABLE IF NOT EXISTS feedback_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_slug TEXT NOT NULL,
    pattern_type TEXT NOT NULL,
    description TEXT NOT NULL,
    signal_ids UUID[] NOT NULL,
    session_count INT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feedback_patterns_agent_idx ON feedback_patterns(agent_slug);
CREATE INDEX IF NOT EXISTS feedback_patterns_status_idx ON feedback_patterns(status);

-- Overlay version tracking
ALTER TABLE overlays ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;
ALTER TABLE overlays ADD COLUMN IF NOT EXISTS supersedes UUID REFERENCES overlays(id);
