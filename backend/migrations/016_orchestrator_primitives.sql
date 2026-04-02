-- SD-003: Orchestrator primitives — skills, tools registry, overlays, projects

CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    base_prompt TEXT NOT NULL,
    base_lessons TEXT,
    judge_config JSONB DEFAULT '{"threshold": 7.0, "rubric": [], "need_to_know": []}'::jsonb,
    examples JSONB DEFAULT '[]'::jsonb,
    knowledge_docs TEXT[] DEFAULT '{}',
    default_tools TEXT[] DEFAULT '{}',
    max_iterations INT DEFAULT 15,
    model TEXT,
    skip_judge BOOLEAN DEFAULT FALSE,
    expert_id UUID REFERENCES experts(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS skills_expert_idx ON skills(expert_id);

CREATE TABLE IF NOT EXISTS tools_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    input_schema JSONB DEFAULT '{}'::jsonb,
    required_credential TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    expert_id UUID REFERENCES experts(id),
    engagement_id UUID REFERENCES engagements(id),
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, slug)
);

CREATE INDEX IF NOT EXISTS projects_client_idx ON projects(client_id);
CREATE INDEX IF NOT EXISTS projects_expert_idx ON projects(expert_id);

CREATE TABLE IF NOT EXISTS overlays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    primitive_type TEXT NOT NULL CHECK (primitive_type IN ('skill', 'tool')),
    primitive_id UUID NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('base', 'expert', 'client', 'project')),
    scope_id UUID,
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('feedback', 'manual', 'shadowing', 'promoted')),
    promoted_from UUID REFERENCES overlays(id),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS overlays_primitive_idx ON overlays(primitive_type, primitive_id);
CREATE INDEX IF NOT EXISTS overlays_scope_idx ON overlays(scope, scope_id);
CREATE INDEX IF NOT EXISTS overlays_source_idx ON overlays(source);

ALTER TABLE execution_sessions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
ALTER TABLE execution_sessions ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'planned';

ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS spawn_context TEXT;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS acceptance_criteria JSONB;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS spawn_examples TEXT;
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS skill_slugs TEXT[] DEFAULT '{}';
ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS depth INT DEFAULT 0;

INSERT INTO tools_registry (slug, name, description, required_credential) VALUES
    ('search_linkedin_profile', 'Search LinkedIn Profile', 'Search LinkedIn for a person or company profile', 'apollo'),
    ('fetch_company_news', 'Fetch Company News', 'Get recent news articles for a company domain', 'tavily'),
    ('search_company_data', 'Search Company Data', 'Look up company enrichment data', 'apollo'),
    ('find_contacts', 'Find Contacts', 'Find decision-maker contacts at a company', 'apollo'),
    ('read_crm_contact', 'Read CRM Contact', 'Read contact or company data from CRM', 'hubspot'),
    ('write_crm_contact', 'Write CRM Contact', 'Create or update a contact/company record in CRM', 'hubspot'),
    ('read_crm_pipeline', 'Read CRM Pipeline', 'Get deals, pipeline stages, and activity history', 'hubspot'),
    ('write_draft', 'Write Draft', 'Produce a final written draft and store it for review', NULL),
    ('optimize_subject_line', 'Optimize Subject Line', 'Generate and score multiple subject line variants', NULL),
    ('fetch_email_analytics', 'Fetch Email Analytics', 'Get outreach email performance metrics', 'hubspot'),
    ('meta_ads_api', 'Meta Ads API', 'Create or update Meta ad campaigns', 'meta'),
    ('google_ads_api', 'Google Ads API', 'Create or update Google Ads campaigns', 'google_ads'),
    ('fetch_ad_performance', 'Fetch Ad Performance', 'Pull ad campaign performance metrics', NULL),
    ('web_search', 'Web Search', 'Search the web for information', 'tavily'),
    ('fetch_url', 'Fetch URL', 'Fetch and parse web page content', NULL),
    ('http_request', 'HTTP Request', 'Make an HTTP request to an external API', NULL),
    ('browser_action', 'Browser Action', 'Perform browser automation actions', NULL),
    ('read_upstream_output', 'Read Upstream Output', 'Read output of a completed upstream agent', NULL),
    ('write_output', 'Write Output', 'Write agent final structured output', NULL),
    ('spawn_agent', 'Spawn Agent', 'Spawn a child agent for a sub-task', NULL)
ON CONFLICT (slug) DO NOTHING;
