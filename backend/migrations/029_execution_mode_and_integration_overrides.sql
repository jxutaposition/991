-- Add execution_mode and integration_overrides to execution_nodes
ALTER TABLE execution_nodes
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN IF NOT EXISTS integration_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Add automation_mode to agent_definitions
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS automation_mode TEXT;
