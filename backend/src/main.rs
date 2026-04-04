use std::sync::Arc;

use axum::{
    middleware,
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
    pattern_promoter,
    pg::PgClient,
    routes,
    session::EventBus,
    skills::SkillCatalog,
    state::AppState,
    work_queue,
    workflow,
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

    let db = PgClient::new(&settings.database_url).await?;

    info!("loading agent catalog from DB (seed dir: {:?})", settings.agents_dir);
    let catalog = Arc::new(
        AgentCatalog::load(&db, &settings.agents_dir)
            .await
            .expect("failed to load agent catalog"),
    );
    info!(
        "loaded {} agents (git sha: {})",
        catalog.len(),
        catalog.git_sha()
    );
    // Load skill catalog (seeds from agent_definitions if DB is empty)
    let skill_catalog = Arc::new(
        SkillCatalog::load(&db).await.expect("failed to load skill catalog"),
    );
    info!("loaded {} skills", skill_catalog.len());

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
        skill_catalog: skill_catalog.clone(),
        #[cfg(feature = "slack")]
        slack: slack_client,
    });

    // Spawn work queue background processor
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    work_queue::spawn(
        settings.clone(),
        db.clone(),
        catalog.clone(),
        skill_catalog.clone(),
        event_bus.clone(),
        shutdown_rx.clone(),
    );

    // Spawn workflow scheduler
    workflow::spawn_scheduler(
        db.clone(),
        catalog.clone(),
        shutdown_rx.clone(),
    );

    // Spawn pattern promoter background scheduler
    pattern_promoter::spawn_scheduler(
        db.clone(),
        settings.anthropic_api_key.clone(),
        settings.anthropic_model.clone(),
        shutdown_rx,
    );

    // Build router
    let app = Router::new()
        // Health & config
        .route("/health", get(routes::health))
        .route("/api/models", get(routes::models_list))
        // Agent catalog
        .route("/api/catalog", get(routes::catalog_list))
        .route("/api/catalog/:slug", get(routes::catalog_get))
        // Execution
        .route("/api/execute/sessions", get(routes::execution_sessions_list))
        .route("/api/execute", post(routes::execution_create))
        .route("/api/execute/:session_id/approve", post(routes::execution_approve))
        .route("/api/execute/:session_id/stop", post(routes::execution_stop))
        .route("/api/execute/:session_id", get(routes::execution_get).delete(routes::execution_session_delete))
        .route("/api/execute/:session_id/nodes/:node_id/events", get(routes::execution_node_events))
        .route("/api/execute/:session_id/nodes/:node_id/thinking", get(routes::execution_node_thinking))
        .route("/api/execute/:session_id/nodes/:node_id/stream", get(routes::execution_node_stream))
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
        .route("/api/data/tables/:table/rows", get(routes::data_table_rows))
        // Demo
        .route("/api/demo/run", post(routes::demo_run))
        // Workflows
        .route("/api/workflows", get(routes::workflows_list))
        .route("/api/workflows", post(routes::workflow_create))
        .route("/api/workflows/:slug", get(routes::workflow_get))
        .route("/api/workflows/:slug/run", post(routes::workflow_run))
        .route("/api/execute/:session_id/save-as-workflow", post(routes::execution_save_as_workflow))
        // Clients
        .route("/api/clients", get(routes::clients_list))
        .route("/api/clients", post(routes::client_create))
        .route("/api/clients/:slug", get(routes::client_get))
        .route("/api/clients/:slug/state", post(routes::client_set_state))
        // Experts
        .route("/api/experts", get(routes::experts_list))
        .route("/api/experts", post(routes::expert_create))
        .route("/api/experts/:slug", get(routes::expert_get))
        // Engagements
        .route("/api/engagements", get(routes::engagements_list))
        .route("/api/engagements", post(routes::engagement_create))
        // Feedback
        .route("/api/feedback", get(routes::feedback_list))
        .route("/api/feedback/synthesize", post(routes::feedback_synthesize))
        // Integrations registry
        .route("/api/integrations", get(routes::integrations_list))
        // Credentials
        .route("/api/clients/:slug/credential-check", get(routes::client_credential_check))
        .route("/api/clients/:slug/credentials", get(routes::client_credentials_list))
        .route("/api/clients/:slug/credentials", post(routes::client_credential_set))
        .route("/api/clients/:slug/credentials/:integration_slug", axum::routing::delete(routes::client_credential_delete))
        // OAuth
        .route("/api/oauth/:provider/authorize", get(routes::oauth_authorize))
        .route("/api/oauth/:provider/callback", get(routes::oauth_callback))
        // Auth
        .route("/api/auth/google", post(routes::auth_google))
        .merge(
            Router::new()
                .route("/api/auth/me", get(routes::auth_me))
                .route("/api/auth/workspaces", post(routes::auth_create_workspace))
                .layer(middleware::from_fn_with_state(state.clone(), lele2_backend::auth::auth_middleware))
        )
        // DAG editor
        .route("/api/execute/:session_id/nodes", post(routes::execution_node_add))
        .route("/api/execute/:session_id/nodes/:node_id", axum::routing::patch(routes::execution_node_update))
        .route("/api/execute/:session_id/nodes/:node_id", axum::routing::delete(routes::execution_node_delete))
        .route("/api/execute/:session_id/nodes/:node_id/release", post(routes::execution_node_release))
        // Node conversation
        .route("/api/execute/:session_id/nodes/:node_id/messages", get(routes::execution_node_messages))
        .route("/api/execute/:session_id/nodes/:node_id/reply", post(routes::execution_node_reply))
        // Agent versions & stats
        .route("/api/catalog/:slug/versions", get(routes::catalog_versions))
        .route("/api/catalog/:slug/stats", get(routes::catalog_agent_stats))
        // Skills
        .route("/api/skills", get(routes::skills_list))
        // Projects
        .route("/api/projects", get(routes::projects_list))
        .route("/api/projects", post(routes::project_create))
        // Project credentials
        .route("/api/projects/:project_id/credentials", get(routes::project_credentials_list))
        .route("/api/projects/:project_id/credentials", post(routes::project_credential_set))
        .route("/api/projects/:project_id/credentials/:integration_slug", axum::routing::delete(routes::project_credential_delete))
        .route("/api/projects/:project_id/credential-check", get(routes::project_credential_check))
        // Project members
        .route("/api/projects/:project_id/members", get(routes::project_members_list))
        .route("/api/projects/:project_id/members", post(routes::project_member_invite))
        .route("/api/projects/:project_id/members/:user_id", axum::routing::delete(routes::project_member_remove))
        // Feedback / Learning
        .route("/api/feedback/lesson", post(routes::feedback_record_lesson))
        // Overlays
        .route("/api/overlays", get(routes::overlays_list))
        .route("/api/overlays/promote", post(routes::overlays_promote));

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
