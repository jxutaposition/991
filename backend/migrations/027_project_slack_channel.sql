-- Slack channel integration at client (default) and project (override) level.
-- Resolution order: project slack_channel_id → client slack_channel_id → nothing.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS slack_channel_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slack_channel_id TEXT;
