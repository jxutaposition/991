-- Slack event logging + unified live events view

CREATE TABLE IF NOT EXISTS slack_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction TEXT NOT NULL,        -- 'inbound' | 'outbound'
    event_type TEXT NOT NULL,       -- 'command' | 'message' | 'button_click' | 'thread_reply' | 'notification'
    slack_channel_id TEXT,
    slack_user_id TEXT,
    session_id UUID,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slack_events_created_idx ON slack_events (created_at DESC);
CREATE INDEX IF NOT EXISTS slack_events_session_idx ON slack_events (session_id);

-- Unified view across all event sources for the data viewer
CREATE OR REPLACE VIEW live_events AS
  SELECT id, created_at, 'browser' AS source, event_type,
         url AS context, dom_context::text AS detail, session_id
  FROM action_events
  UNION ALL
  SELECT id, created_at, 'execution' AS source, event_type,
         NULL AS context, payload::text AS detail, session_id
  FROM execution_events
  UNION ALL
  SELECT id, created_at, 'narration' AS source, 'narration' AS event_type,
         NULL AS context, narrator_text AS detail, session_id
  FROM distillations
  UNION ALL
  SELECT id, created_at, 'slack' AS source, event_type,
         slack_channel_id AS context, payload::text AS detail, session_id
  FROM slack_events;
