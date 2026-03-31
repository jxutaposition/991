/// Client context module — manages client data, contacts, and cross-session state.
///
/// Clients are the entities that workflows run for. Each client has a brief,
/// contacts, and persistent state that carries across workflow runs.
use serde_json::Value;
use tracing::info;
use uuid::Uuid;

use crate::pg::PgClient;

// ── CRUD ──────────────────────────────────────────────────────────────────────

pub async fn create_client(
    db: &PgClient,
    slug: &str,
    name: &str,
    brief: Option<&str>,
    industry: Option<&str>,
    metadata: Option<&Value>,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    let slug_escaped = slug.replace('\'', "''");
    let name_escaped = name.replace('\'', "''");
    let brief_val = brief
        .map(|b| format!("'{}'", b.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let industry_val = industry
        .map(|i| format!("'{}'", i.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let meta_val = metadata
        .map(|m| format!("'{}'::jsonb", m.to_string().replace('\'', "''")))
        .unwrap_or_else(|| "'{}'::jsonb".to_string());

    let sql = format!(
        r#"INSERT INTO clients (id, slug, name, brief, industry, metadata)
           VALUES ('{id}', '{slug_escaped}', '{name_escaped}', {brief_val}, {industry_val}, {meta_val})"#
    );
    db.execute(&sql).await?;
    info!(client = %id, slug = slug, "created client");
    Ok(id)
}

pub async fn get_client(db: &PgClient, slug: &str) -> anyhow::Result<Option<Value>> {
    let slug_escaped = slug.replace('\'', "''");
    let rows = db
        .execute(&format!(
            "SELECT * FROM clients WHERE slug = '{slug_escaped}'"
        ))
        .await?;
    Ok(rows.into_iter().next())
}

pub async fn list_clients(db: &PgClient) -> anyhow::Result<Vec<Value>> {
    db.execute("SELECT * FROM clients ORDER BY name").await
}

pub async fn add_contact(
    db: &PgClient,
    client_id: Uuid,
    name: &str,
    role: Option<&str>,
    email: Option<&str>,
    notes: Option<&str>,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    let name_escaped = name.replace('\'', "''");
    let role_val = role
        .map(|r| format!("'{}'", r.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let email_val = email
        .map(|e| format!("'{}'", e.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let notes_val = notes
        .map(|n| format!("'{}'", n.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        r#"INSERT INTO client_contacts (id, client_id, name, role, email, notes)
           VALUES ('{id}', '{client_id}', '{name_escaped}', {role_val}, {email_val}, {notes_val})"#
    );
    db.execute(&sql).await?;
    Ok(id)
}

pub async fn get_contacts(db: &PgClient, client_id: Uuid) -> anyhow::Result<Vec<Value>> {
    db.execute(&format!(
        "SELECT * FROM client_contacts WHERE client_id = '{client_id}' ORDER BY name"
    ))
    .await
}

// ── Client State (cross-session persistence) ─────────────────────────────────

pub async fn get_state(
    db: &PgClient,
    client_id: Uuid,
    workflow_slug: Option<&str>,
    state_key: &str,
) -> anyhow::Result<Option<Value>> {
    let key_escaped = state_key.replace('\'', "''");
    let wf_clause = workflow_slug
        .map(|w| format!("workflow_slug = '{}'", w.replace('\'', "''")))
        .unwrap_or_else(|| "workflow_slug IS NULL".to_string());

    let rows = db
        .execute(&format!(
            "SELECT state_value FROM client_state \
             WHERE client_id = '{client_id}' AND {wf_clause} AND state_key = '{key_escaped}'"
        ))
        .await?;

    Ok(rows
        .first()
        .and_then(|r| r.get("state_value").cloned()))
}

pub async fn set_state(
    db: &PgClient,
    client_id: Uuid,
    workflow_slug: Option<&str>,
    state_key: &str,
    state_value: &Value,
) -> anyhow::Result<()> {
    let key_escaped = state_key.replace('\'', "''");
    let value_json = state_value.to_string().replace('\'', "''");
    let wf_val = workflow_slug
        .map(|w| format!("'{}'", w.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        r#"INSERT INTO client_state (client_id, workflow_slug, state_key, state_value)
           VALUES ('{client_id}', {wf_val}, '{key_escaped}', '{value_json}'::jsonb)
           ON CONFLICT (client_id, workflow_slug, state_key)
           DO UPDATE SET state_value = '{value_json}'::jsonb, updated_at = NOW()"#
    );
    db.execute(&sql).await?;
    Ok(())
}

pub async fn list_state(
    db: &PgClient,
    client_id: Uuid,
    workflow_slug: Option<&str>,
) -> anyhow::Result<Vec<Value>> {
    let wf_clause = workflow_slug
        .map(|w| format!("AND workflow_slug = '{}'", w.replace('\'', "''")))
        .unwrap_or_default();

    db.execute(&format!(
        "SELECT state_key, state_value, workflow_slug, updated_at \
         FROM client_state WHERE client_id = '{client_id}' {wf_clause} ORDER BY state_key"
    ))
    .await
}

/// Build a context string for agent system prompts from client data.
pub async fn build_client_context(
    db: &PgClient,
    client_id: Uuid,
    workflow_slug: Option<&str>,
) -> anyhow::Result<String> {
    let client_rows = db
        .execute(&format!(
            "SELECT name, brief, industry FROM clients WHERE id = '{client_id}'"
        ))
        .await?;

    let mut context = String::new();

    if let Some(client) = client_rows.first() {
        let name = client.get("name").and_then(Value::as_str).unwrap_or("Unknown");
        context.push_str(&format!("## Client: {name}\n"));
        if let Some(brief) = client.get("brief").and_then(Value::as_str) {
            context.push_str(&format!("{brief}\n"));
        }
        if let Some(industry) = client.get("industry").and_then(Value::as_str) {
            context.push_str(&format!("Industry: {industry}\n"));
        }
        context.push('\n');
    }

    let contacts = get_contacts(db, client_id).await?;
    if !contacts.is_empty() {
        context.push_str("## Key Contacts\n");
        for c in &contacts {
            let name = c.get("name").and_then(Value::as_str).unwrap_or("?");
            let role = c.get("role").and_then(Value::as_str).unwrap_or("");
            context.push_str(&format!("- {name} ({role})\n"));
        }
        context.push('\n');
    }

    let state = list_state(db, client_id, workflow_slug).await?;
    if !state.is_empty() {
        context.push_str("## Prior Work State\n");
        for s in &state {
            let key = s.get("state_key").and_then(Value::as_str).unwrap_or("?");
            let val = s.get("state_value").map(|v| v.to_string()).unwrap_or_default();
            let preview: String = val.chars().take(200).collect();
            context.push_str(&format!("- {key}: {preview}\n"));
        }
    }

    Ok(context)
}
