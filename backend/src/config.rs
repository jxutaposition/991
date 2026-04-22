use std::{env, net::SocketAddr, path::PathBuf};

use uuid::Uuid;

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

    // Embeddings (OpenAI text-embedding-3-small for RAG queries)
    pub openai_api_key: Option<String>,

    // Web search (optional)
    pub tavily_api_key: Option<String>,

    /// Path to the agents/ directory.
    pub agents_dir: PathBuf,
    /// Path to the tools/ directory.
    pub tools_dir: PathBuf,

    // Slack integration (optional — disabled if slack_bot_token is None)
    pub slack_bot_token: Option<String>,
    pub slack_app_token: Option<String>,
    pub slack_signing_secret: Option<String>,
    pub slack_mode: String, // "socket" or "http"
    /// Workspace UUID for sessions created from Slack slash commands (required for web/API parity).
    pub slack_default_client_id: Option<Uuid>,

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

    /// Token budget for extended thinking (chain-of-thought).
    /// Set to 0 to disable. Only applies to models that support it.
    pub thinking_budget_tokens: u32,

    /// Max characters to return from HTTP response bodies (tool results sent to LLM).
    /// Claude models support 200k tokens (~800k chars); this caps individual responses.
    pub http_response_max_chars: usize,

    /// Allowed CORS origins. Comma-separated list of origins.
    /// Set to "*" for permissive mode (not recommended in production).
    /// Defaults to "http://localhost:3000".
    pub cors_origins: Vec<String>,
}

impl Settings {
    /// Validate that critical settings are present. Call after `from_env()`.
    /// Panics on missing required values so the server fails fast on startup
    /// rather than surfacing cryptic errors later.
    pub fn validate(&self) {
        assert!(
            !self.database_url.is_empty(),
            "DATABASE_URL is required but not set"
        );
        assert!(
            !self.anthropic_api_key.is_empty(),
            "ANTHROPIC_API_KEY is required but not set"
        );
        assert!(
            self.agents_dir.exists(),
            "AGENTS_DIR does not exist: {}",
            self.agents_dir.display()
        );
        assert!(
            self.tools_dir.exists(),
            "TOOLS_DIR does not exist: {}",
            self.tools_dir.display()
        );

        // Railway/prod fail-fast checks: avoid partially-booting with auth/crypto disabled.
        let app_env = env::var("APP_ENV").unwrap_or_else(|_| "development".to_string());
        let is_production = app_env.eq_ignore_ascii_case("production")
            || env::var("RAILWAY_ENVIRONMENT").is_ok();
        if is_production {
            assert!(
                self.jwt_secret.as_deref().is_some_and(|s| !s.trim().is_empty()),
                "JWT_SECRET is required in production"
            );
            assert!(
                self.credential_master_key
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty()),
                "CREDENTIAL_MASTER_KEY is required in production"
            );
            assert!(
                !self.cors_origins.is_empty(),
                "CORS_ORIGINS must include at least one allowed origin in production"
            );
        }
    }

    pub fn from_env() -> Self {
        let bind = env::var("BIND_ADDR").unwrap_or_else(|_| {
            match env::var("PORT") {
                Ok(port) if !port.trim().is_empty() => format!("0.0.0.0:{}", port.trim()),
                _ => "0.0.0.0:3001".to_string(),
            }
        });
        let bind_addr = bind
            .parse::<SocketAddr>()
            .unwrap_or_else(|_| "0.0.0.0:3001".parse().expect("valid default bind addr"));

        let agents_dir = PathBuf::from(
            env::var("AGENTS_DIR").unwrap_or_else(|_| "./agents".to_string()),
        );

        let s = Self {
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
                .unwrap_or_default(),
            storage_secret_key: env::var("STORAGE_SECRET_KEY")
                .unwrap_or_default(),
            storage_bucket: env::var("STORAGE_BUCKET")
                .unwrap_or_else(|_| "99percent-screenshots".to_string()),
            openai_api_key: env::var("OPENAI_API_KEY").ok().filter(|s| !s.is_empty()),
            tavily_api_key: env::var("TAVILY_API_KEY").ok().filter(|s| !s.is_empty()),
            agents_dir,
            tools_dir: PathBuf::from(
                env::var("TOOLS_DIR").unwrap_or_else(|_| "./tools".to_string()),
            ),
            slack_bot_token: env::var("SLACK_BOT_TOKEN").ok().filter(|s| !s.is_empty()),
            slack_app_token: env::var("SLACK_APP_TOKEN").ok().filter(|s| !s.is_empty()),
            slack_signing_secret: env::var("SLACK_SIGNING_SECRET").ok().filter(|s| !s.is_empty()),
            slack_mode: env::var("SLACK_MODE").unwrap_or_else(|_| "socket".to_string()),
            slack_default_client_id: env::var("SLACK_DEFAULT_CLIENT_ID")
                .ok()
                .filter(|s| !s.is_empty())
                .and_then(|s| s.parse::<Uuid>().ok()),
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
            thinking_budget_tokens: env::var("THINKING_BUDGET_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10_000),
            http_response_max_chars: env::var("HTTP_RESPONSE_MAX_CHARS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(100_000),
            cors_origins: env::var("CORS_ORIGINS")
                .unwrap_or_else(|_| "http://localhost:3000".to_string())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        };

        tracing::info!(
            model = %s.anthropic_model,
            thinking_budget = s.thinking_budget_tokens,
            skip_judge = s.skip_judge,
            bind = %s.bind_addr,
            "settings loaded"
        );

        s
    }
}
