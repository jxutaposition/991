-- Add required_integrations column to agent_definitions.
-- Stores the integration slugs (e.g. "notion", "tolt") that an agent needs credentials for.
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS required_integrations TEXT[] NOT NULL DEFAULT '{}';
