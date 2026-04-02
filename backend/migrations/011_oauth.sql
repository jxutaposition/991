-- OAuth2 state for CSRF protection during authorization flows.

CREATE TABLE IF NOT EXISTS oauth_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    state_token TEXT UNIQUE NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
);

CREATE INDEX IF NOT EXISTS oauth_state_token_idx ON oauth_state(state_token);
