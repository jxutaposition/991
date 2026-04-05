-- SD-004: System Ontology and Tool Architecture
-- Adds platform tools (Level 3) alongside the existing tools_registry (Level 4 actions)
-- and tool categories for grouping interchangeable platforms.

-- Tool categories group interchangeable platforms
CREATE TABLE IF NOT EXISTS tool_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Platform tools (software platforms like Lovable, Clay, n8n)
-- Distinct from tools_registry which stores executable actions (Level 4)
CREATE TABLE IF NOT EXISTS platform_tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL REFERENCES tool_categories(id),
    description TEXT,
    knowledge TEXT NOT NULL DEFAULT '',
    gotchas TEXT,
    actions TEXT[] NOT NULL DEFAULT '{}',
    required_credentials TEXT[] DEFAULT '{}',
    tradeoffs JSONB DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT true,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_tools_category_idx ON platform_tools(category);
CREATE INDEX IF NOT EXISTS platform_tools_enabled_idx ON platform_tools(enabled) WHERE enabled = true;

-- Per-project default tool preferences
CREATE TABLE IF NOT EXISTS project_tool_defaults (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool_category TEXT NOT NULL REFERENCES tool_categories(id),
    tool_id TEXT NOT NULL REFERENCES platform_tools(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, tool_category)
);

-- Tool selection columns on execution nodes
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS tool_id TEXT REFERENCES platform_tools(id);
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS tool_reasoning TEXT;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS tool_selected_by TEXT;
-- tool_selected_by: 'orchestrator' | 'user_override' | 'project_default'

-- Seed tool categories
INSERT INTO tool_categories (id, name, description) VALUES
    ('frontend-hosting', 'Frontend Hosting', 'Deploy and host frontend web applications'),
    ('workflow-automation', 'Workflow Automation', 'Build and manage automation workflows'),
    ('data-enrichment', 'Data Enrichment', 'Enrich contact and company data'),
    ('documentation', 'Documentation', 'Store and manage documents, wikis, and knowledge bases'),
    ('referral-management', 'Referral Management', 'Manage referral and partner programs'),
    ('frontend-database', 'Frontend Database', 'Backend database for frontend applications'),
    ('communication', 'Communication', 'Send messages and notifications')
ON CONFLICT (id) DO NOTHING;

-- Seed platform tools
INSERT INTO platform_tools (id, name, category, description, actions, required_credentials, tradeoffs) VALUES
    ('lovable', 'Lovable', 'frontend-hosting',
     'Cloud-hosted web app builder with AI chat editor. No REST API for project editing.',
     ARRAY['http_request', 'git_repo_write', 'request_user_action'],
     ARRAY['supabase'],
     '{"automation": "partial", "api_access": "none", "cost": "free-tier-available"}'::jsonb),

    ('vercel', 'Vercel', 'frontend-hosting',
     'Cloud platform for frontend deployment. Full REST API for project lifecycle.',
     ARRAY['http_request', 'git_repo_write', 'vercel_deploy'],
     ARRAY['vercel'],
     '{"automation": "full", "api_access": "full", "cost": "free-tier-available"}'::jsonb),

    ('clay', 'Clay', 'data-enrichment',
     'Data enrichment and prospecting platform. Limited API — UI required for structural setup.',
     ARRAY['http_request', 'request_user_action'],
     ARRAY['clay'],
     '{"automation": "partial", "api_access": "limited", "cost": "credit-based"}'::jsonb),

    ('n8n', 'n8n', 'workflow-automation',
     'Open-source workflow automation platform with full REST API.',
     ARRAY['http_request'],
     ARRAY['n8n'],
     '{"automation": "full", "api_access": "full", "cost": "self-host-or-cloud"}'::jsonb),

    ('notion', 'Notion', 'documentation',
     'Workspace for docs, wikis, and databases. Full REST API.',
     ARRAY['http_request'],
     ARRAY['notion'],
     '{"automation": "full", "api_access": "full", "cost": "free-tier-available"}'::jsonb),

    ('supabase', 'Supabase', 'frontend-database',
     'Open-source Firebase alternative. PostgreSQL with REST API, auth, edge functions, RLS.',
     ARRAY['http_request'],
     ARRAY['supabase'],
     '{"automation": "full", "api_access": "full", "cost": "free-tier-available"}'::jsonb),

    ('tolt', 'Tolt', 'referral-management',
     'Affiliate and referral management platform. API for partner data and revenue metrics.',
     ARRAY['http_request'],
     ARRAY['tolt'],
     '{"automation": "full", "api_access": "full", "cost": "subscription"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
