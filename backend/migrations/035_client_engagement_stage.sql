-- Engagement stage captured at client creation (product analytics / painted doors).
-- Values (app-enforced): initial_discovery | proposal_scoping | onboarded | offboarded

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS engagement_stage TEXT;
