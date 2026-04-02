-- Encrypted client credentials for external integrations.

CREATE TABLE IF NOT EXISTS client_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    integration_slug TEXT NOT NULL,
    -- e.g. 'tavily', 'hubspot', 'notion', 'clay', 'n8n', 'tolt', 'supabase'
    credential_type TEXT NOT NULL DEFAULT 'api_key',
    -- 'api_key' | 'oauth2' | 'basic_auth' | 'bearer_token'
    encrypted_value BYTEA NOT NULL,
    -- AES-256-GCM: nonce (12 bytes) || ciphertext || tag (16 bytes)
    metadata JSONB DEFAULT '{}'::jsonb,
    -- Non-secret metadata: scopes, account name, expiry, etc.
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, integration_slug)
);

CREATE INDEX IF NOT EXISTS client_credentials_client_idx
    ON client_credentials(client_id);
