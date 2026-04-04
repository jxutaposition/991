use std::{env, net::SocketAddr, path::PathBuf};

#[derive(Debug, Clone)]
pub struct Settings {
    pub bind_addr: SocketAddr,

    // Postgres
    pub database_url: String,

    // LLM
    pub anthropic_api_key: String,
    pub anthropic_model: String,

    /// When true, bypass critic+judge for all agents.
    pub skip_judge: bool,

    // Object storage (MinIO locally, S3 in prod)
    pub storage_endpoint: String,
    pub storage_access_key: String,
    pub storage_secret_key: String,
    pub storage_bucket: String,

    // Web search (optional)
    pub tavily_api_key: Option<String>,

    /// Path to the agents/ directory.
    pub agents_dir: PathBuf,

    // Slack integration (optional — disabled if slack_bot_token is None)
    pub slack_bot_token: Option<String>,
    pub slack_app_token: Option<String>,
    pub slack_signing_secret: Option<String>,
    pub slack_mode: String, // "socket" or "http"

    // Credential encryption
    pub credential_master_key: Option<String>,

    // OAuth2 providers
    pub notion_oauth_client_id: Option<String>,
    pub notion_oauth_client_secret: Option<String>,
    pub hubspot_oauth_client_id: Option<String>,
    pub hubspot_oauth_client_secret: Option<String>,
    pub oauth_redirect_base_url: Option<String>,

    // Google sign-in / Google APIs (Ads, Sheets)
    pub google_oauth_client_id: Option<String>,
    pub google_oauth_client_secret: Option<String>,
    pub jwt_secret: Option<String>,

    // Meta (Facebook) OAuth
    pub meta_oauth_client_id: Option<String>,
    pub meta_oauth_client_secret: Option<String>,

    // Slack OAuth
    pub slack_oauth_client_id: Option<String>,
    pub slack_oauth_client_secret: Option<String>,

    // Apollo.io OAuth
    pub apollo_oauth_client_id: Option<String>,
    pub apollo_oauth_client_secret: Option<String>,

    // n8n (global fallback for local/shared instance)
    pub n8n_base_url: Option<String>,
    pub n8n_api_key: Option<String>,

    /// Token budget for extended thinking (chain-of-thought).
    /// Set to 0 to disable. Only applies to models that support it.
    pub thinking_budget_tokens: u32,
}

impl Settings {
    pub fn from_env() -> Self {
        let bind = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3001".to_string());
        let bind_addr = bind
            .parse::<SocketAddr>()
            .unwrap_or_else(|_| "0.0.0.0:3001".parse().expect("valid default bind addr"));

        let agents_dir = PathBuf::from(
            env::var("AGENTS_DIR").unwrap_or_else(|_| "./agents".to_string()),
        );

        Self {
            bind_addr,
            database_url: env::var("DATABASE_URL").unwrap_or_default(),
            anthropic_api_key: env::var("ANTHROPIC_API_KEY").unwrap_or_default(),
            anthropic_model: env::var("ANTHROPIC_MODEL")
                .unwrap_or_else(|_| "claude-haiku-4-5-20251001".to_string()),
            skip_judge: env::var("SKIP_JUDGE")
                .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
                .unwrap_or(false),
            storage_endpoint: env::var("STORAGE_ENDPOINT")
                .unwrap_or_else(|_| "http://localhost:9000".to_string()),
            storage_access_key: env::var("STORAGE_ACCESS_KEY")
                .unwrap_or_else(|_| "minioadmin".to_string()),
            storage_secret_key: env::var("STORAGE_SECRET_KEY")
                .unwrap_or_else(|_| "minioadmin".to_string()),
            storage_bucket: env::var("STORAGE_BUCKET")
                .unwrap_or_else(|_| "lele-screenshots".to_string()),
            tavily_api_key: env::var("TAVILY_API_KEY").ok().filter(|s| !s.is_empty()),
            agents_dir,
            slack_bot_token: env::var("SLACK_BOT_TOKEN").ok().filter(|s| !s.is_empty()),
            slack_app_token: env::var("SLACK_APP_TOKEN").ok().filter(|s| !s.is_empty()),
            slack_signing_secret: env::var("SLACK_SIGNING_SECRET").ok().filter(|s| !s.is_empty()),
            slack_mode: env::var("SLACK_MODE").unwrap_or_else(|_| "socket".to_string()),
            credential_master_key: env::var("CREDENTIAL_MASTER_KEY").ok().filter(|s| !s.is_empty()),
            notion_oauth_client_id: env::var("NOTION_OAUTH_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            notion_oauth_client_secret: env::var("NOTION_OAUTH_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            hubspot_oauth_client_id: env::var("HUBSPOT_OAUTH_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            hubspot_oauth_client_secret: env::var("HUBSPOT_OAUTH_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            oauth_redirect_base_url: env::var("OAUTH_REDIRECT_BASE_URL").ok().filter(|s| !s.is_empty()),
            google_oauth_client_id: env::var("GOOGLE_OAUTH_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            google_oauth_client_secret: env::var("GOOGLE_OAUTH_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            jwt_secret: env::var("JWT_SECRET").ok().filter(|s| !s.is_empty()),
            meta_oauth_client_id: env::var("META_OAUTH_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            meta_oauth_client_secret: env::var("META_OAUTH_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            slack_oauth_client_id: env::var("SLACK_OAUTH_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            slack_oauth_client_secret: env::var("SLACK_OAUTH_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            apollo_oauth_client_id: env::var("APOLLO_OAUTH_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            apollo_oauth_client_secret: env::var("APOLLO_OAUTH_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            n8n_base_url: env::var("N8N_BASE_URL").ok().filter(|s| !s.is_empty()),
            n8n_api_key: env::var("N8N_API_KEY").ok().filter(|s| !s.is_empty()),
            thinking_budget_tokens: env::var("THINKING_BUDGET_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10_000),
        }
    }
}
