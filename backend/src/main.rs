use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tokio::sync::watch;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

use lele2_backend::{
    agent_catalog::AgentCatalog,
    config::Settings,
    pg::PgClient,
    routes,
    session::EventBus,
    state::AppState,
    work_queue,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env
    dotenvy::dotenv_override().ok();

    // Logging
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_env("RUST_LOG")
                .unwrap_or_else(|_| EnvFilter::new("lele2_backend=debug,tower_http=info")),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let settings = Arc::new(Settings::from_env());

    info!("loading agent catalog from {:?}", settings.agents_dir);
    let catalog = Arc::new(
        AgentCatalog::load_from_disk(&settings.agents_dir)
            .expect("failed to load agent catalog"),
    );
    info!(
        "loaded {} agents (git sha: {})",
        catalog.len(),
        catalog.git_sha()
    );

    let db = PgClient::new(&settings.database_url).await?;
    let event_bus = EventBus::new();

    // Initialize Slack client if configured
    #[cfg(feature = "slack")]
    let slack_client = {
        lele2_backend::slack::log_status(&settings);
        settings.slack_bot_token.as_ref().map(|token| {
            Arc::new(lele2_backend::slack::SlackClient::new(
                token,
                settings.slack_app_token.as_deref(),
                settings.slack_signing_secret.as_deref(),
            ))
        })
    };

    let state = Arc::new(AppState {
        settings: settings.clone(),
        db: db.clone(),
        event_bus: event_bus.clone(),
        catalog: catalog.clone(),
        #[cfg(feature = "slack")]
        slack: slack_client,
    });

    // Spawn work queue background processor
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    work_queue::spawn(
        settings.clone(),
        db.clone(),
        catalog.clone(),
        event_bus.clone(),
        shutdown_rx,
    );

    // Build router
    let app = Router::new()
        // Health
        .route("/health", get(routes::health))
        // Agent catalog
        .route("/api/catalog", get(routes::catalog_list))
        .route("/api/catalog/:slug", get(routes::catalog_get))
        // Execution
        .route("/api/execute/sessions", get(routes::execution_sessions_list))
        .route("/api/execute", post(routes::execution_create))
        .route("/api/execute/:session_id/approve", post(routes::execution_approve))
        .route("/api/execute/:session_id", get(routes::execution_get))
        .route("/api/execute/:session_id/nodes/:node_id/events", get(routes::execution_node_events))
        .route("/api/execute/:session_id/events", get(routes::execution_events_sse))
        // Observation
        .route("/api/observe/session/start", post(routes::observe_session_start))
        .route("/api/observe/session/:session_id/events", post(routes::observe_session_events))
        .route("/api/observe/session/:session_id/narration", get(routes::observe_narration_sse))
        .route("/api/observe/session/:session_id/correction", post(routes::observe_correction))
        .route("/api/observe/session/:session_id/end", post(routes::observe_session_end))
        .route("/api/observe/session/:session_id", get(routes::observe_session_get))
        .route("/api/observe/sessions", get(routes::observe_sessions_list))
        // Agent PRs
        .route("/api/agent-prs", get(routes::agent_prs_list))
        .route("/api/agent-prs/:pr_id", get(routes::agent_pr_get))
        .route("/api/agent-prs/:pr_id/approve", post(routes::agent_pr_approve))
        .route("/api/agent-prs/:pr_id/reject", post(routes::agent_pr_reject))
        // Data Viewer
        .route("/api/data/schemas", get(routes::data_schemas))
        .route("/api/data/query", post(routes::data_query))
        .route("/api/data/tables/:table/rows", get(routes::data_table_rows));

    // Mount Slack routes when the feature is enabled
    #[cfg(feature = "slack")]
    let app = {
        use lele2_backend::slack_routes;
        if state.slack.is_some() {
            info!("mounting Slack routes at /api/slack/*");
        }
        app.route("/api/slack/commands", post(slack_routes::commands_handler))
            .route("/api/slack/interactions", post(slack_routes::interactions_handler))
            .route("/api/slack/events", post(slack_routes::events_handler))
    };

    let app = app
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let bind_addr = settings.bind_addr;
    info!("listening on {}", bind_addr);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("shutting down");
            let _ = shutdown_tx.send(true);
        })
        .await?;

    Ok(())
}
