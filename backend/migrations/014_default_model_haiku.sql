-- Change default model from opus to haiku 4.5 for cost efficiency.
ALTER TABLE execution_nodes ALTER COLUMN model SET DEFAULT 'claude-haiku-4-5-20251001';
