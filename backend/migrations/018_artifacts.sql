-- Artifact tracking and step ordering for execution nodes

ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS artifacts JSONB DEFAULT '[]'::jsonb;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS step_index INT;
