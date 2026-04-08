/// SD-008: Resource Discovery — auto-discover external resources from connected integrations.
/// Read-only: never modifies external systems.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::credentials::CredentialMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredResource {
    pub external_id: String,
    pub resource_type: String,
    pub display_name: String,
    pub external_url: Option<String>,
    pub metadata: Value,
}

pub async fn discover_resources(
    integration_slug: &str,
    credentials: &CredentialMap,
) -> anyhow::Result<Vec<DiscoveredResource>> {
    match integration_slug {
        "clay" => discover_clay(credentials).await,
        "n8n" => discover_n8n(credentials).await,
        "supabase" => discover_supabase(credentials).await,
        "notion" => discover_notion(credentials).await,
        _ => Ok(vec![]),
    }
}

async fn discover_clay(credentials: &CredentialMap) -> anyhow::Result<Vec<DiscoveredResource>> {
    let cred = credentials.get("clay")
        .ok_or_else(|| anyhow::anyhow!("No Clay credentials found"))?;

    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.clay.com/v1/tables")
        .header("Authorization", format!("Bearer {}", cred.value))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        warn!(status = %status, "Clay discovery failed: {body}");
        anyhow::bail!("Clay API returned {status}");
    }

    let data: Value = resp.json().await?;
    let tables = data.as_array()
        .or_else(|| data.get("tables").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();

    let resources: Vec<DiscoveredResource> = tables.iter().filter_map(|t| {
        let id = t.get("id").and_then(Value::as_str)?;
        let name = t.get("name").and_then(Value::as_str).unwrap_or("Untitled");
        Some(DiscoveredResource {
            external_id: id.to_string(),
            resource_type: "table".to_string(),
            display_name: name.to_string(),
            external_url: Some(format!("https://app.clay.com/tables/{id}")),
            metadata: json!({
                "row_count": t.get("row_count").or_else(|| t.get("rowCount")),
                "columns": t.get("columns").or_else(|| t.get("schema")),
            }),
        })
    }).collect();

    info!(count = resources.len(), "discovered Clay tables");
    Ok(resources)
}

async fn discover_n8n(credentials: &CredentialMap) -> anyhow::Result<Vec<DiscoveredResource>> {
    let cred = credentials.get("n8n")
        .ok_or_else(|| anyhow::anyhow!("No n8n credentials found"))?;

    let parsed: Value = serde_json::from_str(&cred.value).unwrap_or(serde_json::json!({}));
    let api_key = parsed.get("api_key").and_then(Value::as_str)
        .unwrap_or(&cred.value);
    let base_url = parsed.get("base_url").and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| cred.metadata.get("base_url").and_then(Value::as_str))
        .ok_or_else(|| anyhow::anyhow!("n8n base_url not configured — re-save your n8n credential with the instance URL"))?
        .trim_end_matches('/');

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base_url}/api/v1/workflows"))
        .header("X-N8N-API-KEY", api_key)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        warn!(status = %status, "n8n discovery failed: {body}");
        anyhow::bail!("n8n API returned {status}");
    }

    let data: Value = resp.json().await?;
    let workflows = data.get("data").and_then(Value::as_array)
        .or_else(|| data.as_array())
        .cloned()
        .unwrap_or_default();

    let resources: Vec<DiscoveredResource> = workflows.iter().filter_map(|w| {
        let id = w.get("id").and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string())))?;
        let name = w.get("name").and_then(Value::as_str).unwrap_or("Untitled");
        let active = w.get("active").and_then(Value::as_bool).unwrap_or(false);
        let nodes: Vec<String> = w.get("nodes").and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(|n| n.get("type").and_then(Value::as_str).map(String::from)).collect())
            .unwrap_or_default();

        Some(DiscoveredResource {
            external_id: id.clone(),
            resource_type: "workflow".to_string(),
            display_name: name.to_string(),
            external_url: Some(format!("{base_url}/workflow/{id}")),
            metadata: json!({
                "active": active,
                "node_count": nodes.len(),
                "nodes": nodes,
            }),
        })
    }).collect();

    info!(count = resources.len(), "discovered n8n workflows");
    Ok(resources)
}

async fn discover_supabase(credentials: &CredentialMap) -> anyhow::Result<Vec<DiscoveredResource>> {
    let cred = credentials.get("supabase")
        .ok_or_else(|| anyhow::anyhow!("No Supabase credentials found"))?;

    let project_url = cred.metadata.get("project_url")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Supabase project_url not set in credential metadata"))?;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{project_url}/rest/v1/"))
        .header("apikey", &cred.value)
        .header("Authorization", format!("Bearer {}", cred.value))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        warn!(status = %status, "Supabase discovery failed: {body}");
        anyhow::bail!("Supabase API returned {status}");
    }

    let data: Value = resp.json().await?;
    let definitions = data.get("definitions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let resources: Vec<DiscoveredResource> = definitions.keys().map(|table_name| {
        let schema = definitions.get(table_name);
        let properties = schema
            .and_then(|s| s.get("properties"))
            .and_then(Value::as_object);
        let columns: Vec<String> = properties
            .map(|p| p.keys().cloned().collect())
            .unwrap_or_default();

        DiscoveredResource {
            external_id: table_name.clone(),
            resource_type: "table".to_string(),
            display_name: table_name.clone(),
            external_url: Some(format!("{project_url}/rest/v1/{table_name}")),
            metadata: json!({
                "columns": columns,
                "column_count": columns.len(),
            }),
        }
    }).collect();

    info!(count = resources.len(), "discovered Supabase tables");
    Ok(resources)
}

async fn discover_notion(credentials: &CredentialMap) -> anyhow::Result<Vec<DiscoveredResource>> {
    let cred = credentials.get("notion")
        .ok_or_else(|| anyhow::anyhow!("No Notion credentials found"))?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {}", cred.value))
        .header("Notion-Version", "2022-06-28")
        .json(&json!({"page_size": 100}))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        warn!(status = %status, "Notion discovery failed: {body}");
        anyhow::bail!("Notion API returned {status}");
    }

    let data: Value = resp.json().await?;
    let results = data.get("results").and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let resources: Vec<DiscoveredResource> = results.iter().filter_map(|item| {
        let id = item.get("id").and_then(Value::as_str)?;
        let object_type = item.get("object").and_then(Value::as_str).unwrap_or("page");

        let title = extract_notion_title(item);

        Some(DiscoveredResource {
            external_id: id.to_string(),
            resource_type: object_type.to_string(),
            display_name: title,
            external_url: item.get("url").and_then(Value::as_str).map(String::from),
            metadata: json!({
                "object_type": object_type,
                "parent": item.get("parent"),
            }),
        })
    }).collect();

    info!(count = resources.len(), "discovered Notion pages/databases");
    Ok(resources)
}

pub fn extract_notion_title(item: &Value) -> String {
    if let Some(title_arr) = item.pointer("/properties/title/title")
        .or_else(|| item.pointer("/properties/Name/title"))
        .and_then(Value::as_array)
    {
        let text: String = title_arr.iter()
            .filter_map(|t| t.get("plain_text").and_then(Value::as_str))
            .collect();
        if !text.is_empty() { return text; }
    }

    if let Some(title_arr) = item.get("title").and_then(Value::as_array) {
        let text: String = title_arr.iter()
            .filter_map(|t| t.get("plain_text").and_then(Value::as_str))
            .collect();
        if !text.is_empty() { return text; }
    }

    "Untitled".to_string()
}
