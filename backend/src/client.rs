/// Client context module — manages client data, contacts, and cross-session state.
///
/// Clients are the entities that workflows run for. Each client has a brief,
/// contacts, and persistent state that carries across workflow runs.
use serde_json::Value;
use tracing::info;
use uuid::Uuid;

use crate::pg::PgClient;
use crate::pg_args;

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
    let brief_owned = brief.map(|b| b.to_string());
    let industry_owned = industry.map(|i| i.to_string());
    let meta_val = metadata.cloned().unwrap_or_else(|| serde_json::json!({}));

    db.execute_with(
        "INSERT INTO clients (id, slug, name, brief, industry, metadata) \
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
        pg_args!(id, slug.to_string(), name.to_string(), brief_owned, industry_owned, meta_val),
    ).await?;
    info!(client = %id, slug = slug, "created client");
    Ok(id)
}

pub async fn get_client(db: &PgClient, slug: &str) -> anyhow::Result<Option<Value>> {
    let rows = db
        .execute_with(
            "SELECT * FROM clients WHERE slug = $1 AND deleted_at IS NULL",
            pg_args!(slug.to_string()),
        )
        .await?;
    Ok(rows.into_iter().next())
}

pub async fn list_clients(db: &PgClient) -> anyhow::Result<Vec<Value>> {
    db.execute("SELECT * FROM clients WHERE deleted_at IS NULL ORDER BY name").await
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
    let role_owned = role.map(|r| r.to_string());
    let email_owned = email.map(|e| e.to_string());
    let notes_owned = notes.map(|n| n.to_string());

    db.execute_with(
        "INSERT INTO client_contacts (id, client_id, name, role, email, notes) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        pg_args!(id, client_id, name.to_string(), role_owned, email_owned, notes_owned),
    ).await?;
    Ok(id)
}

pub async fn get_contacts(db: &PgClient, client_id: Uuid) -> anyhow::Result<Vec<Value>> {
    db.execute_with(
        "SELECT * FROM client_contacts WHERE client_id = $1 ORDER BY name",
        pg_args!(client_id),
    )
    .await
}

// ── Client State (cross-session persistence) ─────────────────────────────────

pub async fn get_state(
    db: &PgClient,
    client_id: Uuid,
    workflow_slug: Option<&str>,
    state_key: &str,
) -> anyhow::Result<Option<Value>> {
    let wf = workflow_slug.map(|w| w.to_string());

    let rows = db
        .execute_with(
            "SELECT state_value FROM client_state \
             WHERE client_id = $1 AND workflow_slug IS NOT DISTINCT FROM $2 AND state_key = $3",
            pg_args!(client_id, wf, state_key.to_string()),
        )
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
    let wf = workflow_slug.map(|w| w.to_string());

    db.execute_with(
        "INSERT INTO client_state (client_id, workflow_slug, state_key, state_value) \
         VALUES ($1, $2, $3, $4::jsonb) \
         ON CONFLICT (client_id, workflow_slug, state_key) \
         DO UPDATE SET state_value = $4::jsonb, updated_at = NOW()",
        pg_args!(client_id, wf, state_key.to_string(), state_value.clone()),
    ).await?;
    Ok(())
}

pub async fn list_state(
    db: &PgClient,
    client_id: Uuid,
    workflow_slug: Option<&str>,
) -> anyhow::Result<Vec<Value>> {
    let wf = workflow_slug.map(|w| w.to_string());

    db.execute_with(
        "SELECT state_key, state_value, workflow_slug, updated_at \
         FROM client_state WHERE client_id = $1 \
         AND workflow_slug IS NOT DISTINCT FROM $2 \
         ORDER BY state_key",
        pg_args!(client_id, wf),
    )
    .await
}

/// Build a context string for agent system prompts from client data.
pub async fn build_client_context(
    db: &PgClient,
    client_id: Uuid,
    workflow_slug: Option<&str>,
) -> anyhow::Result<String> {
    let client_rows = db
        .execute_with(
            "SELECT name, brief, industry FROM clients WHERE id = $1",
            pg_args!(client_id),
        )
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

/// Build a context string from expert identity, voice, and methodology.
pub async fn build_expert_context(
    db: &PgClient,
    expert_id: Uuid,
) -> anyhow::Result<String> {
    let rows = db
        .execute_with(
            "SELECT name, identity, voice, methodology FROM experts WHERE id = $1",
            pg_args!(expert_id),
        )
        .await?;

    let mut context = String::new();

    if let Some(expert) = rows.first() {
        let name = expert.get("name").and_then(Value::as_str).unwrap_or("Unknown");
        context.push_str(&format!("## Expert: {}
", name));
        if let Some(identity) = expert.get("identity").and_then(Value::as_str) {
            context.push_str(&format!("{}
", identity));
        }
        if let Some(voice) = expert.get("voice").and_then(Value::as_str) {
            context.push_str(&format!("
### Voice & Style
{}
", voice));
        }
        if let Some(methodology) = expert.get("methodology").and_then(Value::as_str) {
            context.push_str(&format!("
### Methodology
{}
", methodology));
        }
    }

    Ok(context)
}
