-- 034: Replace one-shot learning_analyzed_at with high-water-mark pattern.
-- Sessions are living projects — the analyzer should incrementally scan
-- new messages since the last scan, not treat sessions as "done or not done."

ALTER TABLE execution_sessions
    ADD COLUMN IF NOT EXISTS learning_scanned_up_to TIMESTAMPTZ;

-- Migrate existing data: carry over any previous analyzed timestamp
UPDATE execution_sessions
SET learning_scanned_up_to = learning_analyzed_at
WHERE learning_analyzed_at IS NOT NULL;

-- Replace the old pending index with one suited to watermark lookups
DROP INDEX IF EXISTS sessions_learning_pending_idx;
CREATE INDEX IF NOT EXISTS sessions_learning_rescan_idx
    ON execution_sessions(id)
    WHERE analysis_skip = FALSE;
