/// Tool catalog — loads platform tool definitions from the database.
///
/// On first startup (empty DB), seeds from the tools/ directory on disk.
/// After that, the DB is the source of truth. An in-memory BTreeMap cache is
/// maintained for fast lookups.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};
use walkdir::WalkDir;

use crate::pg::PgClient;

// ── Disk file formats (used only for seeding) ────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct ToolToml {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    #[serde(default)]
    pub required_credentials: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub tradeoffs: Option<toml::Value>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
struct ActionsToml {
    pub actions: Vec<String>,
}

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCategory {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformTool {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub knowledge: String,
    pub gotchas: Option<String>,
    pub actions: Vec<String>,
    pub required_credentials: Vec<String>,
    pub tradeoffs: Value,
    pub enabled: bool,
    pub version: i32,
}

// ── Catalog ──────────────────────────────────────────────────────────────────

pub struct ToolCatalog {
    tools: RwLock<BTreeMap<String, PlatformTool>>,
    categories: RwLock<BTreeMap<String, ToolCategory>>,
}

impl ToolCatalog {
    pub async fn load(db: &PgClient, tools_dir: &Path) -> anyhow::Result<Self> {
        info!("syncing platform tools from disk to DB");
        seed_tools_from_disk(db, tools_dir).await?;

        let catalog = Self {
            tools: RwLock::new(BTreeMap::new()),
            categories: RwLock::new(BTreeMap::new()),
        };
        catalog.reload_all(db).await?;
        Ok(catalog)
    }

    pub async fn reload_all(&self, db: &PgClient) -> anyhow::Result<()> {
        // Load categories
        let cat_rows = db
            .execute("SELECT id, name, description FROM tool_categories ORDER BY id")
            .await?;
        let mut cat_map = BTreeMap::new();
        for row in &cat_rows {
            if let Some(cat) = parse_category_row(row) {
                cat_map.insert(cat.id.clone(), cat);
            }
        }
        info!(count = cat_map.len(), "tool categories loaded from DB");
        *self.categories.write().unwrap() = cat_map;

        // Load tools
        let tool_rows = db
            .execute(
                "SELECT id, name, category, description, knowledge, gotchas, \
                 actions, required_credentials, tradeoffs, enabled, version \
                 FROM platform_tools ORDER BY id",
            )
            .await?;
        let mut tool_map = BTreeMap::new();
        for row in &tool_rows {
            if let Some(tool) = parse_tool_row(row) {
                tool_map.insert(tool.id.clone(), tool);
            }
        }
        info!(count = tool_map.len(), "platform tools loaded from DB");
        *self.tools.write().unwrap() = tool_map;

        Ok(())
    }

    pub fn get_tool(&self, id: &str) -> Option<PlatformTool> {
        self.tools.read().unwrap().get(id).cloned()
    }

    pub fn all_tools(&self) -> Vec<PlatformTool> {
        self.tools.read().unwrap().values().cloned().collect()
    }

    pub fn tools_by_category(&self, category: &str) -> Vec<PlatformTool> {
        self.tools
            .read()
            .unwrap()
            .values()
            .filter(|t| t.category == category && t.enabled)
            .cloned()
            .collect()
    }

    pub fn all_categories(&self) -> Vec<ToolCategory> {
        self.categories.read().unwrap().values().cloned().collect()
    }

    pub fn tool_count(&self) -> usize {
        self.tools.read().unwrap().len()
    }

    pub fn category_count(&self) -> usize {
        self.categories.read().unwrap().len()
    }

    /// Build a summary of tools grouped by category for use in orchestrator prompts.
    pub fn tools_summary(&self) -> String {
        let tools = self.tools.read().unwrap();
        let categories = self.categories.read().unwrap();

        let mut by_category: BTreeMap<&str, Vec<&PlatformTool>> = BTreeMap::new();
        for tool in tools.values() {
            if tool.enabled {
                by_category.entry(&tool.category).or_default().push(tool);
            }
        }

        let mut parts = Vec::new();
        for (cat_id, cat_tools) in &by_category {
            let cat_name = categories
                .get(*cat_id)
                .map(|c| c.name.as_str())
                .unwrap_or(*cat_id);
            let mut section = format!("### {cat_name}\n");
            for tool in cat_tools {
                let creds = if tool.required_credentials.is_empty() {
                    "none".to_string()
                } else {
                    tool.required_credentials.join(", ")
                };
                section.push_str(&format!(
                    "- **{}** (`{}`): {} | credentials: {}\n",
                    tool.name, tool.id, tool.description, creds
                ));
            }
            parts.push(section);
        }
        parts.join("\n")
    }
}

// ── Seeding from disk ────────────────────────────────────────────────────────

async fn seed_tools_from_disk(db: &PgClient, tools_dir: &Path) -> anyhow::Result<()> {
    if !tools_dir.exists() {
        info!(?tools_dir, "tools dir does not exist, skipping seed");
        return Ok(());
    }

    for entry in std::fs::read_dir(tools_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let tool_toml_path = path.join("tool.toml");
        if !tool_toml_path.exists() {
            warn!(?path, "tool dir missing tool.toml, skipping");
            continue;
        }

        let tool_toml_str = std::fs::read_to_string(&tool_toml_path)?;
        let tool_toml: ToolToml = toml::from_str(&tool_toml_str)
            .map_err(|e| anyhow::anyhow!("parse {}: {}", tool_toml_path.display(), e))?;

        let actions_toml_path = path.join("actions.toml");
        let actions: Vec<String> = if actions_toml_path.exists() {
            let actions_str = std::fs::read_to_string(&actions_toml_path)?;
            let at: ActionsToml = toml::from_str(&actions_str)?;
            at.actions
        } else {
            Vec::new()
        };

        let knowledge = load_knowledge(&path);
        let gotchas = load_optional_file(&path.join("gotchas.md"));

        let tradeoffs_json = match &tool_toml.tradeoffs {
            Some(tv) => toml_value_to_json(tv),
            None => "{}".to_string(),
        };

        let id_escaped = tool_toml.id.replace('\'', "''");
        let name_escaped = tool_toml.name.replace('\'', "''");
        let category_escaped = tool_toml.category.replace('\'', "''");
        let desc_escaped = tool_toml.description.replace('\'', "''");
        let knowledge_escaped = knowledge.replace('\'', "''");
        let gotchas_escaped = gotchas
            .as_ref()
            .map(|g| format!("'{}'", g.replace('\'', "''")))
            .unwrap_or_else(|| "NULL".to_string());
        let actions_arr = format!(
            "ARRAY[{}]",
            actions
                .iter()
                .map(|a| format!("'{}'", a.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let creds_arr = format!(
            "ARRAY[{}]",
            tool_toml
                .required_credentials
                .iter()
                .map(|c| format!("'{}'", c.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(", ")
        );

        let sql = format!(
            "INSERT INTO platform_tools (id, name, category, description, knowledge, gotchas, actions, required_credentials, tradeoffs, enabled) \
             VALUES ('{id_escaped}', '{name_escaped}', '{category_escaped}', '{desc_escaped}', \
             '{knowledge_escaped}', {gotchas_escaped}, {actions_arr}, {creds_arr}, \
             '{tradeoffs_json}'::jsonb, {enabled}) \
             ON CONFLICT (id) DO UPDATE SET \
                name = EXCLUDED.name, \
                category = EXCLUDED.category, \
                description = EXCLUDED.description, \
                knowledge = EXCLUDED.knowledge, \
                gotchas = EXCLUDED.gotchas, \
                actions = EXCLUDED.actions, \
                required_credentials = EXCLUDED.required_credentials, \
                tradeoffs = EXCLUDED.tradeoffs, \
                enabled = EXCLUDED.enabled, \
                version = platform_tools.version + 1, \
                updated_at = now()",
            enabled = tool_toml.enabled,
        );

        db.execute(&sql).await?;
        info!(id = %tool_toml.id, "seeded platform tool");
    }

    Ok(())
}

/// Load knowledge from a single knowledge.md or a knowledge/ directory.
fn load_knowledge(tool_dir: &Path) -> String {
    let single_file = tool_dir.join("knowledge.md");
    let knowledge_dir = tool_dir.join("knowledge");

    let mut parts = Vec::new();

    if single_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&single_file) {
            parts.push(content);
        }
    }

    if knowledge_dir.is_dir() {
        let mut files: Vec<PathBuf> = WalkDir::new(&knowledge_dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|ext| ext == "md").unwrap_or(false))
            .map(|e| e.path().to_owned())
            .collect();
        files.sort();

        for file in files {
            if let Ok(content) = std::fs::read_to_string(&file) {
                let relative = file.strip_prefix(&knowledge_dir).unwrap_or(&file);
                parts.push(format!("<!-- {} -->\n{}", relative.display(), content));
            }
        }
    }

    parts.join("\n\n---\n\n")
}

fn load_optional_file(path: &Path) -> Option<String> {
    if path.exists() {
        std::fs::read_to_string(path).ok()
    } else {
        None
    }
}

fn toml_value_to_json(val: &toml::Value) -> String {
    match serde_json::to_string(&toml_to_serde_json(val)) {
        Ok(s) => s.replace('\'', "''"),
        Err(_) => "{}".to_string(),
    }
}

fn toml_to_serde_json(val: &toml::Value) -> Value {
    match val {
        toml::Value::String(s) => Value::String(s.clone()),
        toml::Value::Integer(i) => serde_json::json!(*i),
        toml::Value::Float(f) => serde_json::json!(*f),
        toml::Value::Boolean(b) => Value::Bool(*b),
        toml::Value::Datetime(dt) => Value::String(dt.to_string()),
        toml::Value::Array(arr) => Value::Array(arr.iter().map(toml_to_serde_json).collect()),
        toml::Value::Table(table) => {
            let mut map = serde_json::Map::new();
            for (k, v) in table {
                map.insert(k.clone(), toml_to_serde_json(v));
            }
            Value::Object(map)
        }
    }
}

// ── Row parsing ──────────────────────────────────────────────────────────────

fn parse_category_row(row: &Value) -> Option<ToolCategory> {
    Some(ToolCategory {
        id: row.get("id")?.as_str()?.to_string(),
        name: row.get("name")?.as_str()?.to_string(),
        description: row.get("description").and_then(|v| v.as_str()).map(String::from),
    })
}

fn parse_tool_row(row: &Value) -> Option<PlatformTool> {
    let actions = row
        .get("actions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let required_credentials = row
        .get("required_credentials")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let tradeoffs = row
        .get("tradeoffs")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    Some(PlatformTool {
        id: row.get("id")?.as_str()?.to_string(),
        name: row.get("name")?.as_str()?.to_string(),
        category: row.get("category")?.as_str()?.to_string(),
        description: row.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        knowledge: row.get("knowledge").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        gotchas: row.get("gotchas").and_then(|v| v.as_str()).map(String::from),
        actions,
        required_credentials,
        tradeoffs,
        enabled: row.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        version: row.get("version").and_then(|v| v.as_i64()).unwrap_or(1) as i32,
    })
}
