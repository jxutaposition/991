/// Shared application state threaded through Axum handlers.
use std::sync::Arc;

use tokio::sync::watch;

use crate::agent_catalog::AgentCatalog;
use crate::config::Settings;
use crate::pg::PgClient;
use crate::session::EventBus;
use crate::skills::SkillCatalog;
use crate::tool_catalog::ToolCatalog;

pub struct AppState {
    pub settings: Arc<Settings>,
    pub db: PgClient,
    pub event_bus: EventBus,
    pub catalog: Arc<AgentCatalog>,
    pub skill_catalog: Arc<SkillCatalog>,
    pub tool_catalog: Arc<ToolCatalog>,
    pub shutdown_rx: watch::Receiver<bool>,
    #[cfg(feature = "slack")]
    pub slack: Option<Arc<crate::slack::SlackClient>>,
}
