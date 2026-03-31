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
    let slug_escaped = slug.replace('\'', "''");
    let name_escaped = name.replace('\'', "''");
    let desc_val = description
        .map(|d| format!("'{}'", d.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let client_val = client_id
        .map(|c| format!("'{c}'::uuid"))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        r#"INSERT INTO workflows (id, slug, name, description, client_id)
           VALUES ('{id}', '{slug_escaped}', '{name_escaped}', {desc_val}, {client_val})"#
    );
    db.execute(&sql).await?;
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
    let slug_escaped = agent_slug.replace('\'', "''");
    let template_val = task_description_template
        .map(|t| format!("'{}'", t.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let tier_val = tier_override
        .map(|t| format!("'{t}'"))
        .unwrap_or_else(|| "NULL".to_string());
    let config_val = config
        .map(|c| format!("'{}'::jsonb", c.to_string().replace('\'', "''")))
        .unwrap_or_else(|| "'{}'::jsonb".to_string());

    let requires_arr = if requires.is_empty() {
        "'{}'::uuid[]".to_string()
    } else {
        let items: Vec<String> = requires.iter().map(|u| format!("\"{u}\"")).collect();
        format!("'{{{}}}'::uuid[]", items.join(","))
    };

    let sql = format!(
        r#"INSERT INTO workflow_steps
            (id, workflow_id, step_number, agent_slug, task_description_template,
             requires, tier_override, breakpoint, config)
           VALUES
            ('{step_id}', '{workflow_id}', {step_number}, '{slug_escaped}',
             {template_val}, {requires_arr}, {tier_val}, {breakpoint}, {config_val})"#
    );
    db.execute(&sql).await?;
    Ok(step_id)
}

pub async fn get_workflow(db: &PgClient, slug: &str) -> anyhow::Result<Option<Workflow>> {
    let slug_escaped = slug.replace('\'', "''");
    let rows = db
        .execute(&format!(
            "SELECT id, slug, name, description, client_id, version, schedule, next_run_at \
             FROM workflows WHERE slug = '{slug_escaped}'"
        ))
        .await?;

    Ok(rows.first().and_then(parse_workflow_row))
}

pub async fn get_workflow_steps(
    db: &PgClient,
    workflow_id: Uuid,
) -> anyhow::Result<Vec<WorkflowStep>> {
    let rows = db
        .execute(&format!(
            "SELECT id, workflow_id, step_number, agent_slug, task_description_template, \
             requires, tier_override, breakpoint, config \
             FROM workflow_steps WHERE workflow_id = '{workflow_id}' ORDER BY step_number"
        ))
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
    let request_escaped = request_text.replace('\'', "''");
    let client_val = workflow
        .client_id
        .map(|c| format!("'{c}'::uuid"))
        .unwrap_or_else(|| "NULL".to_string());

    let session_sql = format!(
        r#"INSERT INTO execution_sessions
            (id, request_text, status, workflow_id, client_id)
           VALUES
            ('{session_id}', '{request_escaped}', 'awaiting_approval',
             '{wf_id}'::uuid, {client_val})"#,
        wf_id = workflow.id,
    );
    db.execute(&session_sql).await?;

    let mut step_to_node: std::collections::HashMap<Uuid, Uuid> = std::collections::HashMap::new();

    for step in &steps {
        let node_id = Uuid::new_v4();
        step_to_node.insert(step.id, node_id);

        let task_desc = step
            .task_description_template
            .as_deref()
            .unwrap_or("")
            .replace("{{request}}", request_text)
            .replace('\'', "''");

        let agent_slug_escaped = step.agent_slug.replace('\'', "''");

        let requires: Vec<Uuid> = step
            .requires
            .iter()
            .filter_map(|req_step_id| step_to_node.get(req_step_id).copied())
            .collect();

        let requires_arr = if requires.is_empty() {
            "'{}'::uuid[]".to_string()
        } else {
            let items: Vec<String> = requires.iter().map(|u| format!("\"{u}\"")).collect();
            format!("'{{{}}}'::uuid[]", items.join(","))
        };

        let status = if requires.is_empty() {
            "pending"
        } else {
            "waiting"
        };

        let computed_tier = tier::compute_tier(db, &step.agent_slug, &task_desc).await;

        let tier_override_val = step
            .tier_override
            .as_deref()
            .map(|t| format!("'{t}'"))
            .unwrap_or_else(|| "NULL".to_string());

        let agent = catalog.get(&step.agent_slug);
        let model = agent
            .as_ref()
            .and_then(|a| a.model.as_deref())
            .unwrap_or("claude-haiku-4-5-20251001");
        let max_iterations = agent.as_ref().map(|a| a.max_iterations).unwrap_or(15);
        let skip_judge = agent.as_ref().map(|a| a.skip_judge).unwrap_or(false);
        let judge_config = agent
            .as_ref()
            .map(|a| serde_json::to_string(&a.judge_config).unwrap_or_default())
            .unwrap_or_else(|| r#"{"threshold":7.0,"rubric":[],"need_to_know":[]}"#.to_string())
            .replace('\'', "''");

        let node_sql = format!(
            r#"INSERT INTO execution_nodes
                (id, session_id, agent_slug, agent_git_sha, task_description, status,
                 requires, model, max_iterations, skip_judge, judge_config,
                 computed_tier, tier_override, breakpoint, workflow_id, workflow_step_id, client_id)
               VALUES
                ('{node_id}', '{session_id}', '{agent_slug_escaped}', 'db-v{version}',
                 '{task_desc}', '{status}', {requires_arr}, '{model}', {max_iterations},
                 {skip_judge}, '{judge_config}'::jsonb,
                 '{computed_tier}', {tier_override_val}, {breakpoint},
                 '{wf_id}'::uuid, '{step_id}'::uuid, {client_val})"#,
            version = workflow.version,
            breakpoint = step.breakpoint,
            wf_id = workflow.id,
            step_id = step.id,
        );
        db.execute(&node_sql).await?;
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
    let nodes_sql = format!(
        "SELECT id, agent_slug, task_description, requires, tier_override, breakpoint, client_id \
         FROM execution_nodes WHERE session_id = '{session_id}' ORDER BY created_at"
    );
    let nodes = db.execute(&nodes_sql).await?;

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

    let update_sql = format!(
        "UPDATE workflows SET created_from_session = '{session_id}'::uuid WHERE id = '{workflow_id}'"
    );
    let _ = db.execute(&update_sql).await;

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
    let due_sql = r#"
        SELECT id, slug, schedule
        FROM workflows
        WHERE schedule IS NOT NULL
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
        ORDER BY next_run_at
        LIMIT 5
    "#;

    let due = db.execute(due_sql).await?;

    for row in &due {
        let slug = match row.get("slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let workflow_id = match row.get("id").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let schedule = row.get("schedule").and_then(Value::as_str).unwrap_or("");

        info!(workflow = slug, "running scheduled workflow");

        let request_text = format!("Scheduled run of workflow '{}'", slug);
        match instantiate_workflow(db, catalog, slug, &request_text).await {
            Ok(session_id) => {
                info!(workflow = slug, session = %session_id, "scheduled workflow instantiated");

                // Auto-approve the session so the work queue picks it up
                let approve_sql = format!(
                    "UPDATE execution_sessions SET status = 'executing', plan_approved_at = NOW() WHERE id = '{session_id}'"
                );
                let _ = db.execute(&approve_sql).await;

                let unblock_sql = format!(
                    "UPDATE execution_nodes SET status = 'ready' WHERE session_id = '{session_id}' AND status = 'pending' AND requires = '{{}}'"
                );
                let _ = db.execute(&unblock_sql).await;
            }
            Err(e) => {
                warn!(workflow = slug, error = %e, "failed to instantiate scheduled workflow");
            }
        }

        // Advance next_run_at based on schedule interval
        let next_interval = parse_schedule_interval(schedule);
        let advance_sql = format!(
            "UPDATE workflows SET next_run_at = NOW() + INTERVAL '{next_interval}' WHERE id = '{workflow_id}'::uuid"
        );
        let _ = db.execute(&advance_sql).await;
    }

    Ok(())
}

/// Parse a simple schedule string into a PostgreSQL interval.
/// Supports: "hourly", "daily", "weekly", "30m", "1h", "6h", "12h", "24h", etc.
fn parse_schedule_interval(schedule: &str) -> String {
    match schedule.to_lowercase().trim() {
        "hourly" => "1 hour".to_string(),
        "daily" => "1 day".to_string(),
        "weekly" => "7 days".to_string(),
        "monthly" => "30 days".to_string(),
        s if s.ends_with('m') => {
            let mins: u64 = s.trim_end_matches('m').parse().unwrap_or(60);
            format!("{mins} minutes")
        }
        s if s.ends_with('h') => {
            let hours: u64 = s.trim_end_matches('h').parse().unwrap_or(1);
            format!("{hours} hours")
        }
        s if s.ends_with('d') => {
            let days: u64 = s.trim_end_matches('d').parse().unwrap_or(1);
            format!("{days} days")
        }
        _ => "1 day".to_string(),
    }
}
