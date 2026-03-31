-- High-frequency screenshot capture for vision-based narration

CREATE TABLE IF NOT EXISTS observation_screenshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES observation_sessions(id),
    sequence_number BIGINT NOT NULL,
    image_jpeg BYTEA NOT NULL,
    width INT,
    height INT,
    captured_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (session_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS screenshots_session_idx
    ON observation_screenshots (session_id, sequence_number DESC);
