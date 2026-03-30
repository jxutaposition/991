-- Branching variant support for execution nodes
-- Nodes in the same variant_group are alternatives for the same step.
-- Only variant_selected=true nodes execute; alternatives are stored for visualization.

ALTER TABLE execution_nodes
  ADD COLUMN IF NOT EXISTS variant_group UUID,
  ADD COLUMN IF NOT EXISTS variant_label TEXT,
  ADD COLUMN IF NOT EXISTS variant_selected BOOLEAN DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS execution_nodes_variant_group_idx
  ON execution_nodes (variant_group) WHERE variant_group IS NOT NULL;
