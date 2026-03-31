/// Agent catalog — loads agent definitions from the database.
///
/// On first startup (empty DB), seeds from the agents/ directory on disk.
/// After that, the DB is the source of truth. Agent PRs update the DB directly.
/// An in-memory BTreeMap cache is maintained for fast lookups.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};
use walkdir::WalkDir;

use crate::pg::PgClient;

// ── Agent file formats (used only for disk seeding) ──────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct AgentToml {
    pub slug: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub intents: Vec<String>,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    pub model: Option<String>,
    #[serde(default)]
    pub skip_judge: bool,
    #[serde(default)]
    pub flexible_tool_use: bool,
}

fn default_max_iterations() -> u32 {
    15
}

#[derive(Debug, Clone, Deserialize)]
struct JudgeConfigToml {
    #[serde(default = "default_threshold")]
    pub threshold: f64,
    #[serde(default)]
    pub rubric: Vec<String>,
    #[serde(default)]
    pub need_to_know: Vec<String>,
}

fn default_threshold() -> f64 {
    7.0
}

#[derive(Debug, Clone, Deserialize)]
struct ToolsToml {
    pub tools: Vec<String>,
}

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeConfig {
    pub threshold: f64,
    pub rubric: Vec<String>,
    pub need_to_know: Vec<String>,
}

impl Default for JudgeConfig {
    fn default() -> Self {
        Self {
            threshold: 7.0,
            rubric: Vec::new(),
            need_to_know: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentExample {
    pub input: Value,
    pub output: String,
}

/// A fully-loaded agent definition.
#[derive(Debug, Clone, Serialize)]
pub struct AgentDefinition {
    pub slug: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub intents: Vec<String>,

    pub system_prompt: String,
    pub tools: Vec<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    pub judge_config: JudgeConfig,
    pub examples: Vec<AgentExample>,
    pub knowledge_docs: Vec<String>,

    pub max_iterations: u32,
    pub model: Option<String>,
    pub skip_judge: bool,
    pub flexible_tool_use: bool,

    pub version: i32,
    /// Git SHA kept for backward compat; version is the canonical tracker now.
    pub git_sha: String,
}

/// Execution node status (shared between catalog and work queue).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Waiting,
    Ready,
    Running,
    Passed,
    Failed,
    Skipped,
}

impl NodeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Waiting => "waiting",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Passed | Self::Failed | Self::Skipped)
    }
}

/// A runtime execution node instance (one agent invocation within a session).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlanNode {
    pub uid: uuid::Uuid,
    pub session_id: uuid::Uuid,
    pub agent_slug: String,
    pub agent_git_sha: String,
    pub task_description: String,
    pub status: NodeStatus,
    pub requires: Vec<uuid::Uuid>,
    pub attempt_count: u32,
    pub parent_uid: Option<uuid::Uuid>,
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub judge_score: Option<f64>,
    pub judge_feedback: Option<String>,
    pub judge_config: JudgeConfig,
    pub max_iterations: u32,
    pub model: String,
    pub skip_judge: bool,
    pub variant_group: Option<uuid::Uuid>,
    pub variant_label: Option<String>,
    pub variant_selected: Option<bool>,
    pub client_id: Option<uuid::Uuid>,
}

// ── Catalog ───────────────────────────────────────────────────────────────────

pub struct AgentCatalog {
    agents: RwLock<BTreeMap<String, AgentDefinition>>,
    git_sha: String,
}

impl AgentCatalog {
    /// Load all agent definitions from the database.
    /// If the agent_definitions table is empty, seed from disk first.
    pub async fn load(db: &PgClient, agents_dir: &Path) -> anyhow::Result<Self> {
        let count_rows = db
            .execute("SELECT COUNT(*) as cnt FROM agent_definitions")
            .await?;
        let count = count_rows
            .first()
            .and_then(|r| r.get("cnt").and_then(Value::as_i64))
            .unwrap_or(0);

        if count == 0 {
            info!("agent_definitions table empty — seeding from disk");
            seed_from_disk(db, agents_dir).await?;
        }

        let catalog = Self {
            agents: RwLock::new(BTreeMap::new()),
            git_sha: resolve_git_sha(agents_dir),
        };
        catalog.reload_all(db).await?;
        Ok(catalog)
    }

    /// Reload all agents from DB into the in-memory cache.
    pub async fn reload_all(&self, db: &PgClient) -> anyhow::Result<()> {
        let rows = db
            .execute(
                "SELECT slug, name, category, description, intents, system_prompt, \
                 tools, judge_config, input_schema, output_schema, examples, \
                 knowledge_docs, max_iterations, model, skip_judge, flexible_tool_use, \
                 version FROM agent_definitions ORDER BY slug",
            )
            .await?;

        let mut map = BTreeMap::new();
        for row in &rows {
            if let Some(agent) = parse_agent_row(row, &self.git_sha) {
                map.insert(agent.slug.clone(), agent);
            }
        }

        info!(count = map.len(), "agent catalog loaded from DB");
        let mut agents = self.agents.write().unwrap();
        *agents = map;
        Ok(())
    }

    /// Reload a single agent from DB (called after PR approval).
    pub async fn reload_agent(&self, db: &PgClient, slug: &str) -> anyhow::Result<()> {
        let slug_escaped = slug.replace('\'', "''");
        let rows = db
            .execute(&format!(
                "SELECT slug, name, category, description, intents, system_prompt, \
                 tools, judge_config, input_schema, output_schema, examples, \
                 knowledge_docs, max_iterations, model, skip_judge, flexible_tool_use, \
                 version FROM agent_definitions WHERE slug = '{slug_escaped}'"
            ))
            .await?;

        if let Some(row) = rows.first() {
            if let Some(agent) = parse_agent_row(row, &self.git_sha) {
                info!(slug = %slug, version = agent.version, "reloaded agent from DB");
                let mut agents = self.agents.write().unwrap();
                agents.insert(agent.slug.clone(), agent);
            }
        } else {
            warn!(slug = %slug, "agent not found in DB during reload");
        }
        Ok(())
    }

    pub fn get(&self, slug: &str) -> Option<AgentDefinition> {
        self.agents.read().unwrap().get(slug).cloned()
    }

    pub fn all(&self) -> Vec<AgentDefinition> {
        self.agents.read().unwrap().values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.agents.read().unwrap().len()
    }

    pub fn git_sha(&self) -> &str {
        &self.git_sha
    }

    pub fn catalog_summary(&self) -> String {
        let agents = self.agents.read().unwrap();
        let mut parts = Vec::new();
        for agent in agents.values() {
            parts.push(format!(
                "Agent: {} (slug: \"{}\")\nCategory: {}\nDescription: {}\nIntents: [{}]\n",
                agent.name,
                agent.slug,
                agent.category,
                agent.description,
                agent.intents.join(", "),
            ));
        }
        parts.join("\n")
    }

    // Keep backward compat for code that still calls load_from_disk
    pub fn load_from_disk(agents_dir: &Path) -> anyhow::Result<Self> {
        let git_sha = resolve_git_sha(agents_dir);
        let mut agents = BTreeMap::new();

        for entry in WalkDir::new(agents_dir)
            .min_depth(1)
            .max_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir())
        {
            let agent_dir = entry.path();
            match load_agent_from_disk(agent_dir, &git_sha) {
                Ok(agent) => {
                    agents.insert(agent.slug.clone(), agent);
                }
                Err(e) => {
                    warn!(dir = %agent_dir.display(), error = %e, "skipping agent");
                }
            }
        }

        Ok(Self {
            agents: RwLock::new(agents),
            git_sha,
        })
    }
}

// ── DB row parsing ───────────────────────────────────────────────────────────

fn parse_agent_row(row: &Value, git_sha: &str) -> Option<AgentDefinition> {
    let slug = row.get("slug")?.as_str()?.to_string();
    let name = row.get("name")?.as_str()?.to_string();
    let category = row
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let description = row
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let system_prompt = row.get("system_prompt")?.as_str()?.to_string();
    let version = row.get("version").and_then(Value::as_i64).unwrap_or(1) as i32;

    let intents = parse_text_array(row.get("intents"));
    let tools = parse_text_array(row.get("tools"));
    let knowledge_docs = parse_text_array(row.get("knowledge_docs"));

    let judge_config = row
        .get("judge_config")
        .and_then(|v| serde_json::from_value::<JudgeConfig>(v.clone()).ok())
        .unwrap_or_default();

    let input_schema = row
        .get("input_schema")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let output_schema = row
        .get("output_schema")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let examples = row
        .get("examples")
        .and_then(|v| serde_json::from_value::<Vec<AgentExample>>(v.clone()).ok())
        .unwrap_or_default();

    let max_iterations = row
        .get("max_iterations")
        .and_then(Value::as_i64)
        .unwrap_or(15) as u32;
    let model = row
        .get("model")
        .and_then(Value::as_str)
        .map(String::from);
    let skip_judge = row
        .get("skip_judge")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let flexible_tool_use = row
        .get("flexible_tool_use")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    Some(AgentDefinition {
        slug,
        name,
        category,
        description,
        intents,
        system_prompt,
        tools,
        input_schema,
        output_schema,
        judge_config,
        examples,
        knowledge_docs,
        max_iterations,
        model,
        skip_judge,
        flexible_tool_use,
        version,
        git_sha: git_sha.to_string(),
    })
}

fn parse_text_array(val: Option<&Value>) -> Vec<String> {
    val.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

// ── Seeding from disk ────────────────────────────────────────────────────────

async fn seed_from_disk(db: &PgClient, agents_dir: &Path) -> anyhow::Result<()> {
    let git_sha = resolve_git_sha(agents_dir);

    for entry in WalkDir::new(agents_dir)
        .min_depth(1)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir())
    {
        let agent_dir = entry.path();
        match load_agent_from_disk(agent_dir, &git_sha) {
            Ok(agent) => {
                if let Err(e) = insert_agent_to_db(db, &agent).await {
                    warn!(slug = %agent.slug, error = %e, "failed to seed agent to DB");
                } else {
                    info!(slug = %agent.slug, "seeded agent to DB");
                }
            }
            Err(e) => {
                warn!(dir = %agent_dir.display(), error = %e, "skipping agent during seed");
            }
        }
    }

    Ok(())
}

async fn insert_agent_to_db(db: &PgClient, agent: &AgentDefinition) -> anyhow::Result<()> {
    let slug = agent.slug.replace('\'', "''");
    let name = agent.name.replace('\'', "''");
    let category = agent.category.replace('\'', "''");
    let description = agent.description.replace('\'', "''");
    let system_prompt = agent.system_prompt.replace('\'', "''");

    let intents_arr = format_pg_text_array(&agent.intents);
    let tools_arr = format_pg_text_array(&agent.tools);
    let knowledge_arr = format_pg_text_array(&agent.knowledge_docs);

    let judge_config_json = serde_json::to_string(&agent.judge_config)
        .unwrap_or_else(|_| r#"{"threshold":7.0,"rubric":[],"need_to_know":[]}"#.to_string())
        .replace('\'', "''");
    let input_schema_json = agent.input_schema.to_string().replace('\'', "''");
    let output_schema_json = agent.output_schema.to_string().replace('\'', "''");
    let examples_json = serde_json::to_string(&agent.examples)
        .unwrap_or_else(|_| "[]".to_string())
        .replace('\'', "''");

    let model_val = agent
        .model
        .as_deref()
        .map(|m| format!("'{}'", m.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        r#"INSERT INTO agent_definitions
            (slug, name, category, description, intents, system_prompt, tools,
             judge_config, input_schema, output_schema, examples, knowledge_docs,
             max_iterations, model, skip_judge, flexible_tool_use, version)
           VALUES
            ('{slug}', '{name}', '{category}', '{description}', {intents_arr}, '{system_prompt}',
             {tools_arr}, '{judge_config_json}'::jsonb, '{input_schema_json}'::jsonb,
             '{output_schema_json}'::jsonb, '{examples_json}'::jsonb, {knowledge_arr},
             {max_iter}, {model_val}, {skip_judge}, {flex_tool}, 1)
           ON CONFLICT (slug) DO NOTHING"#,
        max_iter = agent.max_iterations,
        skip_judge = agent.skip_judge,
        flex_tool = agent.flexible_tool_use,
    );

    db.execute(&sql).await?;

    // Create initial version snapshot
    let snapshot = serde_json::json!({
        "slug": agent.slug,
        "name": agent.name,
        "category": agent.category,
        "description": agent.description,
        "system_prompt": agent.system_prompt,
        "version": 1,
    });
    let snapshot_json = snapshot.to_string().replace('\'', "''");

    let version_sql = format!(
        r#"INSERT INTO agent_versions (agent_id, version, snapshot, change_summary, change_source)
           SELECT id, 1, '{snapshot_json}'::jsonb, 'Initial seed from disk', 'seed'
           FROM agent_definitions WHERE slug = '{slug}'
           ON CONFLICT (agent_id, version) DO NOTHING"#,
    );
    let _ = db.execute(&version_sql).await;

    Ok(())
}

fn format_pg_text_array(items: &[String]) -> String {
    if items.is_empty() {
        "'{}'::text[]".to_string()
    } else {
        let escaped: Vec<String> = items
            .iter()
            .map(|s| format!("\"{}\"", s.replace('"', r#"\""#)))
            .collect();
        format!("'{{{}}}'::text[]", escaped.join(","))
    }
}

// ── Disk loading helpers (used for seeding and backward compat) ──────────────

fn load_agent_from_disk(dir: &Path, git_sha: &str) -> anyhow::Result<AgentDefinition> {
    let toml_path = dir.join("agent.toml");
    let toml_str = std::fs::read_to_string(&toml_path)
        .map_err(|e| anyhow::anyhow!("missing agent.toml in {}: {}", dir.display(), e))?;
    let meta: AgentToml = toml::from_str(&toml_str)
        .map_err(|e| anyhow::anyhow!("invalid agent.toml in {}: {}", dir.display(), e))?;

    let prompt = std::fs::read_to_string(dir.join("prompt.md"))
        .map_err(|e| anyhow::anyhow!("missing prompt.md in {}: {}", dir.display(), e))?;

    let tools = if dir.join("tools.toml").exists() {
        let s = std::fs::read_to_string(dir.join("tools.toml"))?;
        let t: ToolsToml = toml::from_str(&s)
            .map_err(|e| anyhow::anyhow!("invalid tools.toml in {}: {}", dir.display(), e))?;
        t.tools
    } else {
        Vec::new()
    };

    let input_schema =
        read_optional_json(dir.join("input_schema.json")).unwrap_or_else(|| serde_json::json!({}));
    let output_schema =
        read_optional_json(dir.join("output_schema.json")).unwrap_or_else(|| serde_json::json!({}));

    let judge_config = if dir.join("judge_config.toml").exists() {
        let s = std::fs::read_to_string(dir.join("judge_config.toml"))?;
        let jc: JudgeConfigToml = toml::from_str(&s).map_err(|e| {
            anyhow::anyhow!("invalid judge_config.toml in {}: {}", dir.display(), e)
        })?;
        JudgeConfig {
            threshold: jc.threshold,
            rubric: jc.rubric,
            need_to_know: jc.need_to_know,
        }
    } else {
        JudgeConfig::default()
    };

    let examples = load_examples(dir);
    let knowledge_docs = load_knowledge(dir);

    Ok(AgentDefinition {
        slug: meta.slug,
        name: meta.name,
        category: meta.category,
        description: meta.description,
        intents: meta.intents,
        system_prompt: prompt,
        tools,
        input_schema,
        output_schema,
        judge_config,
        examples,
        knowledge_docs,
        max_iterations: meta.max_iterations,
        model: meta.model,
        skip_judge: meta.skip_judge,
        flexible_tool_use: meta.flexible_tool_use,
        version: 1,
        git_sha: git_sha.to_string(),
    })
}

fn read_optional_json(path: PathBuf) -> Option<Value> {
    let s = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&s).ok()
}

fn load_examples(dir: &Path) -> Vec<AgentExample> {
    let examples_dir = dir.join("examples");
    if !examples_dir.exists() {
        return Vec::new();
    }

    let mut examples = Vec::new();
    let mut paths: Vec<_> = WalkDir::new(&examples_dir)
        .min_depth(1)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .map(|e| e.into_path())
        .collect();
    paths.sort();

    for path in paths {
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                let input = v.get("input").cloned().unwrap_or(serde_json::json!({}));
                let output = v
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                examples.push(AgentExample { input, output });
            }
        }
    }
    examples
}

fn load_knowledge(dir: &Path) -> Vec<String> {
    let knowledge_dir = dir.join("knowledge");
    if !knowledge_dir.exists() {
        return Vec::new();
    }

    let mut docs = Vec::new();
    let mut paths: Vec<_> = WalkDir::new(&knowledge_dir)
        .min_depth(1)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        .map(|e| e.into_path())
        .collect();
    paths.sort();

    for path in paths {
        if let Ok(s) = std::fs::read_to_string(&path) {
            docs.push(s);
        }
    }
    docs
}

fn resolve_git_sha(path: &Path) -> String {
    Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(path)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}
