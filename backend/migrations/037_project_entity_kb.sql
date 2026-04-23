-- project_entity_kb — auto-captured name ↔ id mappings for integration entities.
--
-- Populated by two paths:
--   1. live_fetch  — resolver.rs when the preset/KB lookups both miss and we
--                    call the integration's list endpoint.
--   2. write_back  — actions.rs after a successful Clay create-like tool
--                    (create_table, create_workbook, etc.) so subsequent plans
--                    in the same client scope can resolve the new resource by
--                    name without another live fetch.
--
-- Client-scoped (per design: same Clay workspace usually serves all projects
-- under one client). No invalidation in phase 1 — stale entries are deferred
-- tech debt tracked in the plan.

CREATE TABLE IF NOT EXISTS project_entity_kb (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL,
    integration_slug TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    parent_kind TEXT,
    parent_id TEXT,
    source TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, integration_slug, entity_kind, entity_id)
);

CREATE INDEX IF NOT EXISTS project_entity_kb_lookup_idx
    ON project_entity_kb (client_id, integration_slug, entity_kind, lower(name));

CREATE INDEX IF NOT EXISTS project_entity_kb_parent_idx
    ON project_entity_kb (client_id, integration_slug, parent_kind, parent_id)
    WHERE parent_id IS NOT NULL;
