/// Living System Description — project-level descriptions, rich node descriptions, issue tracking.
///
/// The description is the fundamental unit: it starts as a design document, serves as the
/// execution blueprint, and persists as living system documentation. Operational data
/// (credentials, health, artifacts) is derived from real system data, not stored here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::info;
use uuid::Uuid;

use crate::pg::PgClient;
use crate::pg_args;

// ── Project Description ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDescription {
    pub id: Uuid,
    pub project_id: Uuid,
    pub title: String,
    pub summary: Option<String>,
    pub architecture: Value,
    pub data_flows: Value,
    pub integration_map: Value,
    pub version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDescriptionVersion {
    pub id: Uuid,
    pub project_description_id: Uuid,
    pub version: i32,
    pub snapshot: Value,
    pub change_summary: Option<String>,
    pub change_source: String,
    pub changed_by: Option<String>,
}

/// Create a new project description.
pub async fn create_project_description(
    db: &PgClient,
    project_id: Uuid,
    title: &str,
    summary: Option<&str>,
    architecture: &Value,
    data_flows: &Value,
    integration_map: &Value,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    db.execute_with(
        r#"INSERT INTO project_descriptions
            (id, project_id, title, summary, architecture, data_flows, integration_map)
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        pg_args!(id, project_id, title.to_string(), summary.map(|s| s.to_string()), architecture.clone(), data_flows.clone(), integration_map.clone()),
    ).await?;

    // Record initial version
    let snapshot = snapshot_project_description(title, summary, architecture, data_flows, integration_map);
    record_project_description_version(db, id, 1, &snapshot, Some("Initial creation"), "planner", None).await?;

    info!(id = %id, project_id = %project_id, "created project description");
    Ok(id)
}

/// Get the current project description for a project.
pub async fn get_for_project(db: &PgClient, project_id: Uuid) -> anyhow::Result<Option<Value>> {
    let rows = db.execute_with(
        "SELECT * FROM project_descriptions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
        pg_args!(project_id),
    ).await?;
    Ok(rows.into_iter().next())
}

/// Get a project description by ID.
pub async fn get_project_description(db: &PgClient, id: Uuid) -> anyhow::Result<Option<Value>> {
    let rows = db.execute_with(
        "SELECT * FROM project_descriptions WHERE id = $1",
        pg_args!(id),
    ).await?;
    Ok(rows.into_iter().next())
}

/// Update a project description. Increments version and records history.
pub async fn update_project_description(
    db: &PgClient,
    id: Uuid,
    title: Option<&str>,
    summary: Option<&str>,
    architecture: Option<&Value>,
    data_flows: Option<&Value>,
    integration_map: Option<&Value>,
    change_source: &str,
    changed_by: Option<&str>,
) -> anyhow::Result<i32> {
    // Use COALESCE pattern: each field updates only if a new value is provided
    let title_val = title.map(|s| s.to_string());
    let summary_val = summary.map(|s| s.to_string());
    let arch_val = architecture.cloned();
    let flows_val = data_flows.cloned();
    let map_val = integration_map.cloned();

    let rows = db.execute_with(
        r#"UPDATE project_descriptions SET
            version = version + 1,
            updated_at = NOW(),
            title = COALESCE($1, title),
            summary = COALESCE($2, summary),
            architecture = COALESCE($3, architecture),
            data_flows = COALESCE($4, data_flows),
            integration_map = COALESCE($5, integration_map)
           WHERE id = $6
           RETURNING version"#,
        pg_args!(title_val, summary_val, arch_val, flows_val, map_val, id),
    ).await?;

    let new_version = rows
        .first()
        .and_then(|r| r.get("version"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1) as i32;

    // Snapshot current state for version history
    let current = get_project_description(db, id).await?;
    if let Some(current) = current {
        let change_summary = format!("Updated by {}", change_source);
        record_project_description_version(
            db, id, new_version, &current, Some(&change_summary), change_source, changed_by,
        ).await?;
    }

    info!(id = %id, version = new_version, "updated project description");
    Ok(new_version)
}

/// Get version history for a project description.
pub async fn get_project_description_versions(
    db: &PgClient,
    project_description_id: Uuid,
) -> anyhow::Result<Vec<Value>> {
    db.execute_with(
        "SELECT * FROM project_description_versions WHERE project_description_id = $1 ORDER BY version DESC",
        pg_args!(project_description_id),
    ).await
}

/// Record a version snapshot.
async fn record_project_description_version(
    db: &PgClient,
    project_description_id: Uuid,
    version: i32,
    snapshot: &Value,
    change_summary: Option<&str>,
    change_source: &str,
    changed_by: Option<&str>,
) -> anyhow::Result<()> {
    let id = Uuid::new_v4();
    db.execute_with(
        r#"INSERT INTO project_description_versions
            (id, project_description_id, version, snapshot, change_summary, change_source, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        pg_args!(
            id,
            project_description_id,
            version,
            snapshot.clone(),
            change_summary.map(|s| s.to_string()),
            change_source.to_string(),
            changed_by.map(|s| s.to_string())
        ),
    ).await?;
    Ok(())
}

fn snapshot_project_description(
    title: &str,
    summary: Option<&str>,
    architecture: &Value,
    data_flows: &Value,
    integration_map: &Value,
) -> Value {
    json!({
        "title": title,
        "summary": summary,
        "architecture": architecture,
        "data_flows": data_flows,
        "integration_map": integration_map,
    })
}

// ── Node Issues ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeIssue {
    pub id: Uuid,
    pub node_id: Uuid,
    pub session_id: Uuid,
    pub issue_type: String,
    pub description: String,
    pub status: String,
    pub source: String,
}

/// Create an issue on a node.
pub async fn create_issue(
    db: &PgClient,
    node_id: Uuid,
    session_id: Uuid,
    issue_type: &str,
    description: &str,
    source: &str,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    db.execute_with(
        r#"INSERT INTO node_issues (id, node_id, session_id, issue_type, description, source)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
        pg_args!(id, node_id, session_id, issue_type.to_string(), description.to_string(), source.to_string()),
    ).await?;
    info!(id = %id, node_id = %node_id, issue_type = issue_type, "created node issue");
    Ok(id)
}

/// List all issues for a session.
pub async fn list_issues_for_session(
    db: &PgClient,
    session_id: Uuid,
) -> anyhow::Result<Vec<Value>> {
    db.execute_with(
        "SELECT * FROM node_issues WHERE session_id = $1 ORDER BY created_at",
        pg_args!(session_id),
    ).await
}

/// List issues for a specific node.
pub async fn list_issues_for_node(
    db: &PgClient,
    node_id: Uuid,
) -> anyhow::Result<Vec<Value>> {
    db.execute_with(
        "SELECT * FROM node_issues WHERE node_id = $1 ORDER BY created_at",
        pg_args!(node_id),
    ).await
}

/// Resolve an issue.
pub async fn resolve_issue(
    db: &PgClient,
    issue_id: Uuid,
    resolved_by: Option<&str>,
) -> anyhow::Result<()> {
    db.execute_with(
        "UPDATE node_issues SET status = 'resolved', resolved_at = NOW(), resolved_by = $1, updated_at = NOW() WHERE id = $2",
        pg_args!(resolved_by.map(|s| s.to_string()), issue_id),
    ).await?;
    info!(id = %issue_id, "resolved node issue");
    Ok(())
}

/// Dismiss an issue.
pub async fn dismiss_issue(
    db: &PgClient,
    issue_id: Uuid,
) -> anyhow::Result<()> {
    db.execute_with(
        "UPDATE node_issues SET status = 'dismissed', updated_at = NOW() WHERE id = $1",
        pg_args!(issue_id),
    ).await?;
    info!(id = %issue_id, "dismissed node issue");
    Ok(())
}

/// Auto-resolve all credential issues for a node (called after successful execution).
pub async fn auto_resolve_credential_issues(
    db: &PgClient,
    node_id: Uuid,
) -> anyhow::Result<u64> {
    let rows = db.execute_with(
        r#"UPDATE node_issues
           SET status = 'resolved', resolved_at = NOW(), resolved_by = 'system', updated_at = NOW()
           WHERE node_id = $1 AND issue_type = 'credential' AND status = 'open'
           RETURNING id"#,
        pg_args!(node_id),
    ).await?;
    let count = rows.len() as u64;
    if count > 0 {
        info!(node_id = %node_id, count = count, "auto-resolved credential issues after successful execution");
    }
    Ok(count)
}

// ── Node Description Helpers ─────────────────────────────────────────────────

/// Update the description JSONB on an execution node.
pub async fn update_node_description(
    db: &PgClient,
    node_id: Uuid,
    description: &Value,
) -> anyhow::Result<()> {
    db.execute_with(
        "UPDATE execution_nodes SET description = $1 WHERE id = $2",
        pg_args!(description.clone(), node_id),
    ).await?;
    info!(node_id = %node_id, "updated node description");
    Ok(())
}

/// Get the description JSONB for an execution node.
pub async fn get_node_description(
    db: &PgClient,
    node_id: Uuid,
) -> anyhow::Result<Option<Value>> {
    let rows = db.execute_with(
        "SELECT description FROM execution_nodes WHERE id = $1",
        pg_args!(node_id),
    ).await?;
    Ok(rows.first().and_then(|r| r.get("description").cloned()))
}

// ── Description Threads ──────────────────────────────────────────────────────

/// Create a new thread on a description section.
pub async fn create_thread(
    db: &PgClient,
    session_id: Option<Uuid>,
    node_id: Option<Uuid>,
    section_path: &str,
    highlighted_text: Option<&str>,
    initial_message: &str,
    created_by: Option<&str>,
) -> anyhow::Result<Uuid> {
    let thread_id = Uuid::new_v4();
    db.execute_with(
        r#"INSERT INTO description_threads
            (id, session_id, node_id, section_path, highlighted_text, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
        pg_args!(
            thread_id, session_id, node_id,
            section_path.to_string(),
            highlighted_text.map(|s| s.to_string()),
            created_by.map(|s| s.to_string())
        ),
    ).await?;

    // Add the initial user message
    let msg_id = Uuid::new_v4();
    db.execute_with(
        r#"INSERT INTO description_thread_messages (id, thread_id, role, content)
           VALUES ($1, $2, 'user', $3)"#,
        pg_args!(msg_id, thread_id, initial_message.to_string()),
    ).await?;

    info!(thread_id = %thread_id, section = section_path, "created description thread");
    Ok(thread_id)
}

/// List threads for a session.
pub async fn list_threads(
    db: &PgClient,
    session_id: Uuid,
) -> anyhow::Result<Vec<Value>> {
    db.execute_with(
        r#"SELECT t.*,
            (SELECT COUNT(*) FROM description_thread_messages WHERE thread_id = t.id) AS message_count
           FROM description_threads t
           WHERE t.session_id = $1
           ORDER BY t.created_at DESC"#,
        pg_args!(session_id),
    ).await
}

/// List messages for a thread.
pub async fn list_thread_messages(
    db: &PgClient,
    thread_id: Uuid,
) -> anyhow::Result<Vec<Value>> {
    db.execute_with(
        "SELECT * FROM description_thread_messages WHERE thread_id = $1 ORDER BY created_at",
        pg_args!(thread_id),
    ).await
}

/// Add a message to a thread.
pub async fn add_thread_message(
    db: &PgClient,
    thread_id: Uuid,
    role: &str,
    content: &str,
    description_patch: Option<&Value>,
) -> anyhow::Result<Uuid> {
    let msg_id = Uuid::new_v4();
    db.execute_with(
        r#"INSERT INTO description_thread_messages (id, thread_id, role, content, description_patch)
           VALUES ($1, $2, $3, $4, $5)"#,
        pg_args!(
            msg_id, thread_id, role.to_string(), content.to_string(),
            description_patch.cloned()
        ),
    ).await?;

    // Update thread timestamp
    db.execute_with(
        "UPDATE description_threads SET updated_at = NOW() WHERE id = $1",
        pg_args!(thread_id),
    ).await?;

    Ok(msg_id)
}

/// Resolve or archive a thread.
pub async fn update_thread_status(
    db: &PgClient,
    thread_id: Uuid,
    status: &str,
) -> anyhow::Result<()> {
    db.execute_with(
        "UPDATE description_threads SET status = $1, updated_at = NOW() WHERE id = $2",
        pg_args!(status.to_string(), thread_id),
    ).await?;
    info!(thread_id = %thread_id, status = status, "updated thread status");
    Ok(())
}

/// Get a thread with all its messages.
pub async fn get_thread_with_messages(
    db: &PgClient,
    thread_id: Uuid,
) -> anyhow::Result<Option<Value>> {
    let thread_rows = db.execute_with(
        "SELECT * FROM description_threads WHERE id = $1",
        pg_args!(thread_id),
    ).await?;

    let thread = match thread_rows.into_iter().next() {
        Some(t) => t,
        None => return Ok(None),
    };

    let messages = list_thread_messages(db, thread_id).await?;

    Ok(Some(json!({
        "thread": thread,
        "messages": messages,
    })))
}
