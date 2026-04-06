/// Workflow module — CRUD for workflow templates and instantiation into execution sessions.
///
/// Workflows are saved DAG templates that compose agents for business processes.
/// They live in the DB and evolve through observation and direct editing.
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::pg::PgClient;
use crate::pg_args;
use crate::tier;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Workflow {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub client_id: Option<Uuid>,
    pub version: i32,
    pub schedule: Option<String>,
    pub next_run_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowStep {
    pub id: Uuid,
    pub workflow_id: Uuid,
    pub step_number: i32,
    pub agent_slug: String,
    pub task_description_template: Option<String>,
    pub requires: Vec<Uuid>,
    pub tier_override: Option<String>,
    pub breakpoint: bool,
    pub config: Value,
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

pub async fn create_workflow(
    db: &PgClient,
    slug: &str,
    name: &str,
    description: Option<&str>,
    client_id: Option<Uuid>,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    let desc_owned = description.map(|d| d.to_string());

    db.execute_with(
        "INSERT INTO workflows (id, slug, name, description, client_id) \
         VALUES ($1, $2, $3, $4, $5)",
        pg_args!(id, slug.to_string(), name.to_string(), desc_owned, client_id),
    ).await?;
    info!(workflow = %id, slug = slug, "created workflow");
    Ok(id)
}

pub async fn add_step(
    db: &PgClient,
    workflow_id: Uuid,
    step_number: i32,
    agent_slug: &str,
    task_description_template: Option<&str>,
    requires: &[Uuid],
    tier_override: Option<&str>,
    breakpoint: bool,
    config: Option<&Value>,
) -> anyhow::Result<Uuid> {
    let step_id = Uuid::new_v4();
    let template_owned = task_description_template.map(|t| t.to_string());
    let tier_owned = tier_override.map(|t| t.to_string());
    let config_val = config.cloned().unwrap_or(json!({}));
    let requires_vec = requires.to_vec();

    db.execute_with(
        "INSERT INTO workflow_steps \
            (id, workflow_id, step_number, agent_slug, task_description_template, \
             requires, tier_override, breakpoint, config) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
        pg_args!(step_id, workflow_id, step_number, agent_slug.to_string(),
                 template_owned, requires_vec, tier_owned, breakpoint, config_val),
    ).await?;
    Ok(step_id)
}

pub async fn get_workflow(db: &PgClient, slug: &str) -> anyhow::Result<Option<Workflow>> {
    let rows = db
        .execute_with(
            "SELECT id, slug, name, description, client_id, version, schedule, next_run_at \
             FROM workflows WHERE slug = $1",
            pg_args!(slug.to_string()),
        )
        .await?;

    Ok(rows.first().and_then(parse_workflow_row))
}

pub async fn get_workflow_steps(
    db: &PgClient,
    workflow_id: Uuid,
) -> anyhow::Result<Vec<WorkflowStep>> {
    let rows = db
        .execute_with(
            "SELECT id, workflow_id, step_number, agent_slug, task_description_template, \
             requires, tier_override, breakpoint, config \
             FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_number",
            pg_args!(workflow_id),
        )
        .await?;

    Ok(rows.iter().filter_map(parse_step_row).collect())
}

pub async fn list_workflows(db: &PgClient) -> anyhow::Result<Vec<Workflow>> {
    let rows = db
        .execute(
            "SELECT id, slug, name, description, client_id, version, schedule, next_run_at \
             FROM workflows ORDER BY name",
        )
        .await?;

    Ok(rows.iter().filter_map(parse_workflow_row).collect())
}

// ── Instantiation ─────────────────────────────────────────────────────────────

/// Create an execution session from a workflow template.
/// Fills in task_description_template placeholders with request context.
pub async fn instantiate_workflow(
    db: &PgClient,
    catalog: &AgentCatalog,
    workflow_slug: &str,
    request_text: &str,
) -> anyhow::Result<Uuid> {
    let workflow = get_workflow(db, workflow_slug)
        .await?
        .ok_or_else(|| anyhow::anyhow!("workflow not found: {workflow_slug}"))?;

    let steps = get_workflow_steps(db, workflow.id).await?;
    if steps.is_empty() {
        return Err(anyhow::anyhow!("workflow has no steps: {workflow_slug}"));
    }

    let session_id = Uuid::new_v4();

    db.execute_with(
        "INSERT INTO execution_sessions (id, request_text, status, workflow_id, client_id) \
         VALUES ($1, $2, 'awaiting_approval', $3, $4)",
        pg_args!(session_id, request_text.to_string(), workflow.id, workflow.client_id),
    ).await?;

    let mut step_to_node: std::collections::HashMap<Uuid, Uuid> = std::collections::HashMap::new();

    for step in &steps {
        let node_id = Uuid::new_v4();
        step_to_node.insert(step.id, node_id);

        let task_desc = step
            .task_description_template
            .as_deref()
            .unwrap_or("")
            .replace("{{request}}", request_text);

        let requires: Vec<Uuid> = step
            .requires
            .iter()
            .filter_map(|req_step_id| step_to_node.get(req_step_id).copied())
            .collect();

        let status = if requires.is_empty() {
            "pending"
        } else {
            "waiting"
        };

        let computed_tier = tier::compute_tier(db, &step.agent_slug, &task_desc).await;

        let agent = catalog.get(&step.agent_slug);
        let model = agent
            .as_ref()
            .and_then(|a| a.model.as_deref())
            .unwrap_or("claude-haiku-4-5-20251001")
            .to_string();
        let max_iterations = agent.as_ref().map(|a| a.max_iterations).unwrap_or(15) as i32;
        let skip_judge = agent.as_ref().map(|a| a.skip_judge).unwrap_or(false);
        let judge_config = agent
            .as_ref()
            .map(|a| serde_json::to_value(&a.judge_config).unwrap_or(json!({})))
            .unwrap_or_else(|| json!({"threshold":7.0,"rubric":[],"need_to_know":[]}));
        let tier_override_owned = step.tier_override.clone();
        let version_str = format!("db-v{}", workflow.version);

        db.execute_with(
            "INSERT INTO execution_nodes \
                (id, session_id, agent_slug, agent_git_sha, task_description, status, \
                 requires, model, max_iterations, skip_judge, judge_config, \
                 computed_tier, tier_override, breakpoint, workflow_id, workflow_step_id, client_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17)",
            pg_args!(
                node_id, session_id, step.agent_slug.clone(), version_str,
                task_desc, status.to_string(), requires, model, max_iterations,
                skip_judge, judge_config, computed_tier, tier_override_owned,
                step.breakpoint, workflow.id, step.id, workflow.client_id
            ),
        ).await?;
    }

    info!(
        session = %session_id,
        workflow = workflow_slug,
        nodes = steps.len(),
        "instantiated workflow"
    );

    Ok(session_id)
}

/// Save an existing execution session's DAG as a new workflow template.
pub async fn save_session_as_workflow(
    db: &PgClient,
    session_id: Uuid,
    slug: &str,
    name: &str,
    description: Option<&str>,
) -> anyhow::Result<Uuid> {
    let nodes = db.execute_with(
        "SELECT id, agent_slug, task_description, requires, tier_override, breakpoint, client_id \
         FROM execution_nodes WHERE session_id = $1 ORDER BY created_at",
        pg_args!(session_id),
    ).await?;

    if nodes.is_empty() {
        return Err(anyhow::anyhow!("session has no nodes"));
    }

    let client_id = nodes
        .first()
        .and_then(|n| n.get("client_id").and_then(Value::as_str))
        .and_then(|s| s.parse::<Uuid>().ok());

    let workflow_id = create_workflow(db, slug, name, description, client_id).await?;

    let mut node_id_to_step_id: std::collections::HashMap<String, Uuid> =
        std::collections::HashMap::new();

    for (i, node) in nodes.iter().enumerate() {
        let node_id_str = node
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let agent_slug = node
            .get("agent_slug")
            .and_then(Value::as_str)
            .unwrap_or("");
        let task_desc = node
            .get("task_description")
            .and_then(Value::as_str)
            .unwrap_or("");

        let requires_nodes: Vec<String> = node
            .get("requires")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();

        let requires_steps: Vec<Uuid> = requires_nodes
            .iter()
            .filter_map(|nid| node_id_to_step_id.get(nid).copied())
            .collect();

        let tier_override = node
            .get("tier_override")
            .and_then(Value::as_str);
        let breakpoint = node
            .get("breakpoint")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let step_id = add_step(
            db,
            workflow_id,
            i as i32,
            agent_slug,
            Some(task_desc),
            &requires_steps,
            tier_override,
            breakpoint,
            None,
        )
        .await?;

        node_id_to_step_id.insert(node_id_str, step_id);
    }

    let _ = db.execute_with(
        "UPDATE workflows SET created_from_session = $1 WHERE id = $2",
        pg_args!(session_id, workflow_id),
    ).await;

    info!(workflow = %workflow_id, slug = slug, steps = nodes.len(), "saved session as workflow");
    Ok(workflow_id)
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

fn parse_workflow_row(row: &Value) -> Option<Workflow> {
    Some(Workflow {
        id: row.get("id")?.as_str()?.parse().ok()?,
        slug: row.get("slug")?.as_str()?.to_string(),
        name: row.get("name")?.as_str()?.to_string(),
        description: row.get("description").and_then(Value::as_str).map(String::from),
        client_id: row
            .get("client_id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok()),
        version: row.get("version").and_then(Value::as_i64).unwrap_or(1) as i32,
        schedule: row.get("schedule").and_then(Value::as_str).map(String::from),
        next_run_at: row.get("next_run_at").and_then(Value::as_str).map(String::from),
    })
}

fn parse_step_row(row: &Value) -> Option<WorkflowStep> {
    Some(WorkflowStep {
        id: row.get("id")?.as_str()?.parse().ok()?,
        workflow_id: row.get("workflow_id")?.as_str()?.parse().ok()?,
        step_number: row.get("step_number")?.as_i64()? as i32,
        agent_slug: row.get("agent_slug")?.as_str()?.to_string(),
        task_description_template: row
            .get("task_description_template")
            .and_then(Value::as_str)
            .map(String::from),
        requires: row
            .get("requires")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str()?.parse().ok())
                    .collect()
            })
            .unwrap_or_default(),
        tier_override: row
            .get("tier_override")
            .and_then(Value::as_str)
            .map(String::from),
        breakpoint: row
            .get("breakpoint")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        config: row
            .get("config")
            .cloned()
            .unwrap_or(json!({})),
    })
}

// ── Scheduling poller ────────────────────────────────────────────────────────

const SCHEDULE_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Background task that checks for scheduled workflows whose next_run_at <= NOW()
/// and instantiates them. After running, advances next_run_at based on the cron-like
/// schedule field.
pub fn spawn_scheduler(
    db: PgClient,
    catalog: Arc<AgentCatalog>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("workflow scheduler started");
        let mut interval = tokio::time::interval(SCHEDULE_POLL_INTERVAL);

        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        info!("workflow scheduler shutting down");
                        break;
                    }
                }
            }

            if let Err(e) = poll_scheduled_workflows(&db, &catalog).await {
                warn!(error = %e, "scheduler poll failed");
            }
        }

        info!("workflow scheduler stopped");
    })
}

async fn poll_scheduled_workflows(
    db: &PgClient,
    catalog: &AgentCatalog,
) -> anyhow::Result<()> {
    let due = db.execute(
        "SELECT id, slug, schedule \
         FROM workflows \
         WHERE schedule IS NOT NULL \
           AND next_run_at IS NOT NULL \
           AND next_run_at <= NOW() \
         ORDER BY next_run_at \
         LIMIT 5",
    ).await?;

    for row in &due {
        let slug = match row.get("slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let workflow_id = match row.get("id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()) {
            Some(id) => id,
            None => continue,
        };
        let schedule = row.get("schedule").and_then(Value::as_str).unwrap_or("");

        info!(workflow = slug, "running scheduled workflow");

        let request_text = format!("Scheduled run of workflow '{}'", slug);
        match instantiate_workflow(db, catalog, slug, &request_text).await {
            Ok(session_id) => {
                info!(workflow = slug, session = %session_id, "scheduled workflow instantiated");

                // Auto-approve the session so the work queue picks it up
                let _ = db.execute_with(
                    "UPDATE execution_sessions SET status = 'executing', plan_approved_at = NOW() WHERE id = $1",
                    pg_args!(session_id),
                ).await;

                let _ = db.execute_with(
                    "UPDATE execution_nodes SET status = 'ready' WHERE session_id = $1 AND status = 'pending' AND requires = '{}'",
                    pg_args!(session_id),
                ).await;
            }
            Err(e) => {
                warn!(workflow = slug, error = %e, "failed to instantiate scheduled workflow");
            }
        }

        // Advance next_run_at based on schedule interval
        let interval_secs = parse_schedule_interval_secs(schedule);
        let _ = db.execute_with(
            "UPDATE workflows SET next_run_at = NOW() + make_interval(secs => $1) WHERE id = $2",
            pg_args!(interval_secs as f64, workflow_id),
        ).await;
    }

    Ok(())
}

/// Parse a simple schedule string into seconds.
/// Supports: "hourly", "daily", "weekly", "30m", "1h", "6h", "12h", "24h", etc.
fn parse_schedule_interval_secs(schedule: &str) -> u64 {
    match schedule.to_lowercase().trim() {
        "hourly" => 3600,
        "daily" => 86400,
        "weekly" => 604800,
        "monthly" => 2592000,
        s if s.ends_with('m') => {
            let mins: u64 = s.trim_end_matches('m').parse().unwrap_or(60);
            mins * 60
        }
        s if s.ends_with('h') => {
            let hours: u64 = s.trim_end_matches('h').parse().unwrap_or(1);
            hours * 3600
        }
        s if s.ends_with('d') => {
            let days: u64 = s.trim_end_matches('d').parse().unwrap_or(1);
            days * 86400
        }
        _ => 86400,
    }
}
