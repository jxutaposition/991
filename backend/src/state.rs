/// Shared application state threaded through Axum handlers.
use std::sync::Arc;

use crate::agent_catalog::AgentCatalog;
use crate::config::Settings;
use crate::pg::PgClient;
use crate::session::EventBus;
use crate::skills::SkillCatalog;

pub struct AppState {
    pub settings: Arc<Settings>,
    pub db: PgClient,
    pub event_bus: EventBus,
    pub catalog: Arc<AgentCatalog>,
    pub skill_catalog: Arc<SkillCatalog>,
    #[cfg(feature = "slack")]
    pub slack: Option<Arc<crate::slack::SlackClient>>,
}
