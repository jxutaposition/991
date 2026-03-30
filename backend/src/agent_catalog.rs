/// Agent catalog — loads agent definitions from the agents/ directory on disk.
///
/// Each agent is a folder under agents/<slug>/ containing:
///   agent.toml       — identity, config, intents
///   prompt.md        — system prompt (the core artifact)
///   tools.toml       — tool access list
///   input_schema.json
///   output_schema.json
///   judge_config.toml
///   examples/NNN.json — few-shot examples
///   knowledge/*.md   — reference docs
///
/// The file system is the source of truth. Git provides versioning.
/// The DB only caches embeddings for planner search (not implemented in Phase 0).
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};
use walkdir::WalkDir;

// ── Agent file formats ────────────────────────────────────────────────────────

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

    /// Git SHA of the agents/ dir at load time (for provenance).
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
    // Branching variant support
    pub variant_group: Option<uuid::Uuid>,
    pub variant_label: Option<String>,
    pub variant_selected: Option<bool>,
}

// ── Catalog ───────────────────────────────────────────────────────────────────

pub struct AgentCatalog {
    agents: BTreeMap<String, AgentDefinition>,
    git_sha: String,
}

impl AgentCatalog {
    /// Load all agent definitions from the agents/ directory.
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
            match load_agent(agent_dir, &git_sha) {
                Ok(agent) => {
                    info!(slug = %agent.slug, "loaded agent");
                    agents.insert(agent.slug.clone(), agent);
                }
                Err(e) => {
                    warn!(dir = %agent_dir.display(), error = %e, "skipping agent (load error)");
                }
            }
        }

        info!(count = agents.len(), "agent catalog loaded");
        Ok(Self { agents, git_sha })
    }

    pub fn get(&self, slug: &str) -> Option<&AgentDefinition> {
        self.agents.get(slug)
    }

    pub fn all(&self) -> impl Iterator<Item = &AgentDefinition> {
        self.agents.values()
    }

    pub fn len(&self) -> usize {
        self.agents.len()
    }

    pub fn git_sha(&self) -> &str {
        &self.git_sha
    }

    /// Build a catalog summary string for the LLM planner prompt.
    pub fn catalog_summary(&self) -> String {
        let mut parts = Vec::new();
        for agent in self.agents.values() {
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
}

// ── Loading helpers ───────────────────────────────────────────────────────────

fn load_agent(dir: &Path, git_sha: &str) -> anyhow::Result<AgentDefinition> {
    // agent.toml — required
    let toml_path = dir.join("agent.toml");
    let toml_str = std::fs::read_to_string(&toml_path)
        .map_err(|e| anyhow::anyhow!("missing agent.toml in {}: {}", dir.display(), e))?;
    let meta: AgentToml = toml::from_str(&toml_str)
        .map_err(|e| anyhow::anyhow!("invalid agent.toml in {}: {}", dir.display(), e))?;

    // prompt.md — required
    let prompt = std::fs::read_to_string(dir.join("prompt.md"))
        .map_err(|e| anyhow::anyhow!("missing prompt.md in {}: {}", dir.display(), e))?;

    // tools.toml — optional (empty list if absent)
    let tools = if dir.join("tools.toml").exists() {
        let s = std::fs::read_to_string(dir.join("tools.toml"))?;
        let t: ToolsToml = toml::from_str(&s)
            .map_err(|e| anyhow::anyhow!("invalid tools.toml in {}: {}", dir.display(), e))?;
        t.tools
    } else {
        Vec::new()
    };

    // input_schema.json — optional
    let input_schema = read_optional_json(dir.join("input_schema.json"))
        .unwrap_or_else(|| serde_json::json!({}));

    // output_schema.json — optional
    let output_schema = read_optional_json(dir.join("output_schema.json"))
        .unwrap_or_else(|| serde_json::json!({}));

    // judge_config.toml — optional
    let judge_config = if dir.join("judge_config.toml").exists() {
        let s = std::fs::read_to_string(dir.join("judge_config.toml"))?;
        let jc: JudgeConfigToml = toml::from_str(&s)
            .map_err(|e| anyhow::anyhow!("invalid judge_config.toml in {}: {}", dir.display(), e))?;
        JudgeConfig {
            threshold: jc.threshold,
            rubric: jc.rubric,
            need_to_know: jc.need_to_know,
        }
    } else {
        JudgeConfig::default()
    };

    // examples/*.json — optional
    let examples = load_examples(dir);

    // knowledge/*.md — optional
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
    // Try to get the git SHA for the agents/ directory
    Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(path)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}
