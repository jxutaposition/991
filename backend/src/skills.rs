/// Skills module — manages the skill primitive with scoped overlay resolution.
///
/// Skills are teachable units of expertise. At runtime, the orchestrator assembles
/// an agent by selecting skills + tools and resolving scoped overlays to build a
/// rich system prompt.
use std::collections::BTreeMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use crate::agent_catalog::JudgeConfig;
use crate::pg::PgClient;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDefinition {
    pub id: uuid::Uuid,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub base_prompt: String,
    pub base_lessons: Option<String>,
    pub judge_config: JudgeConfig,
    pub examples: Vec<crate::agent_catalog::AgentExample>,
    pub knowledge_docs: Vec<String>,
    pub default_tools: Vec<String>,
    pub max_iterations: u32,
    pub model: Option<String>,
    pub skip_judge: bool,
    pub expert_id: Option<uuid::Uuid>,
}

pub struct SkillCatalog {
    skills: RwLock<BTreeMap<String, SkillDefinition>>,
}

impl SkillCatalog {
    pub async fn load(db: &PgClient) -> anyhow::Result<Self> {
        let catalog = Self {
            skills: RwLock::new(BTreeMap::new()),
        };
        catalog.reload_all(db).await?;

        // If no skills exist, seed from agent_definitions
        if catalog.len() == 0 {
            info!("no skills in DB — seeding from agent_definitions");
            seed_skills_from_agents(db).await?;
            catalog.reload_all(db).await?;
        }

        Ok(catalog)
    }

    pub async fn reload_all(&self, db: &PgClient) -> anyhow::Result<()> {
        let rows = db
            .execute(
                "SELECT id, slug, name, description, base_prompt, base_lessons, \
                 judge_config, examples, knowledge_docs, default_tools, \
                 max_iterations, model, skip_judge, expert_id \
                 FROM skills ORDER BY slug",
            )
            .await?;

        let mut map = BTreeMap::new();
        for row in &rows {
            if let Some(skill) = parse_skill_row(row) {
                map.insert(skill.slug.clone(), skill);
            }
        }

        info!(count = map.len(), "skill catalog loaded from DB");
        let mut skills = self.skills.write().unwrap();
        *skills = map;
        Ok(())
    }

    pub fn get(&self, slug: &str) -> Option<SkillDefinition> {
        self.skills.read().unwrap().get(slug).cloned()
    }

    pub fn all(&self) -> Vec<SkillDefinition> {
        self.skills.read().unwrap().values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.skills.read().unwrap().len()
    }

    pub fn summary(&self) -> String {
        let skills = self.skills.read().unwrap();
        let mut parts = Vec::new();
        for skill in skills.values() {
            parts.push(format!(
                "Skill: {} (slug: \"{}\")\nDescription: {}\nDefault tools: [{}]\n",
                skill.name,
                skill.slug,
                skill.description,
                skill.default_tools.join(", "),
            ));
        }
        parts.join("\n")
    }
}

fn parse_skill_row(row: &Value) -> Option<SkillDefinition> {
    let id = row.get("id")?.as_str()?.parse::<uuid::Uuid>().ok()?;
    let slug = row.get("slug")?.as_str()?.to_string();
    let name = row.get("name")?.as_str()?.to_string();
    let description = row
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let base_prompt = row.get("base_prompt")?.as_str()?.to_string();
    let base_lessons = row
        .get("base_lessons")
        .and_then(Value::as_str)
        .map(String::from);

    let judge_config = row
        .get("judge_config")
        .and_then(|v| serde_json::from_value::<JudgeConfig>(v.clone()).ok())
        .unwrap_or_default();

    let examples = row
        .get("examples")
        .and_then(|v| {
            serde_json::from_value::<Vec<crate::agent_catalog::AgentExample>>(v.clone()).ok()
        })
        .unwrap_or_default();

    let knowledge_docs = row
        .get("knowledge_docs")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let default_tools = row
        .get("default_tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let max_iterations = row
        .get("max_iterations")
        .and_then(Value::as_i64)
        .unwrap_or(15) as u32;
    let model = row.get("model").and_then(Value::as_str).map(String::from);
    let skip_judge = row
        .get("skip_judge")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let expert_id = row
        .get("expert_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<uuid::Uuid>().ok());

    Some(SkillDefinition {
        id,
        slug,
        name,
        description,
        base_prompt,
        base_lessons,
        judge_config,
        examples,
        knowledge_docs,
        default_tools,
        max_iterations,
        model,
        skip_judge,
        expert_id,
    })
}

// ── Overlay Resolution ───────────────────────────────────────────────────────

/// Resolve all overlays for a skill across the scope chain.
/// Returns concatenated overlay content in order: base → expert → client → project.
///
/// Uses a narrative + recency buffer strategy: if a scope has a pre-computed
/// narrative, inject the narrative plus only overlays created after the narrative
/// was generated. If no narrative exists, inject all non-retired overlays.
pub async fn resolve_overlays(
    db: &PgClient,
    skill_id: uuid::Uuid,
    expert_id: Option<uuid::Uuid>,
    client_id: Option<uuid::Uuid>,
    project_id: Option<uuid::Uuid>,
) -> String {
    // Load narratives for the relevant scope chain
    let narratives = load_scope_narratives(db, expert_id, client_id, project_id).await;

    let mut scope_clauses = vec![format!(
        "(primitive_type = 'skill' AND primitive_id = '{skill_id}' AND scope = 'base')"
    )];

    if let Some(eid) = expert_id {
        scope_clauses.push(format!(
            "(primitive_type = 'skill' AND primitive_id = '{skill_id}' AND scope = 'expert' AND scope_id = '{eid}')"
        ));
    }
    if let Some(cid) = client_id {
        scope_clauses.push(format!(
            "(primitive_type = 'skill' AND primitive_id = '{skill_id}' AND scope = 'client' AND scope_id = '{cid}')"
        ));
    }
    if let Some(pid) = project_id {
        scope_clauses.push(format!(
            "(primitive_type = 'skill' AND primitive_id = '{skill_id}' AND scope = 'project' AND scope_id = '{pid}')"
        ));
    }

    let sql = format!(
        "SELECT content, scope, scope_id, created_at FROM overlays \
         WHERE ({}) AND retired_at IS NULL \
         ORDER BY \
         CASE scope WHEN 'base' THEN 0 WHEN 'expert' THEN 1 \
         WHEN 'client' THEN 2 WHEN 'project' THEN 3 END, \
         created_at ASC",
        scope_clauses.join(" OR ")
    );

    let rows = match db.execute(&sql).await {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "failed to resolve overlays");
            return String::new();
        }
    };

    let mut narrative_parts = Vec::new();
    let mut overlay_parts = Vec::new();

    // Inject narratives first
    for (scope_name, narrative_text, _generated_at) in &narratives {
        narrative_parts.push(format!("[{scope_name} context] {narrative_text}"));
    }

    for row in &rows {
        let content = match row.get("content").and_then(Value::as_str) {
            Some(c) => c,
            None => continue,
        };
        let scope = row
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("base");
        let created_at = row
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("");

        // If there is a narrative for this scope, only include overlays newer than it
        let narrative_generated = narratives.iter().find(|(s, _, _)| s == scope);
        if let Some((_, _, gen_at)) = narrative_generated {
            if created_at <= gen_at.as_str() {
                continue; // narrative already covers this overlay
            }
        }

        overlay_parts.push(content.to_string());
    }

    let mut result = String::new();
    if !narrative_parts.is_empty() {
        result.push_str(&narrative_parts.join("\n\n"));
    }
    if !overlay_parts.is_empty() {
        if !result.is_empty() {
            result.push_str("\n\n");
        }
        result.push_str(&overlay_parts.join("\n\n"));
    }
    result
}

/// Load scope narratives for the given scope chain.
/// Returns Vec of (scope_name, narrative_text, generated_at).
async fn load_scope_narratives(
    db: &PgClient,
    expert_id: Option<uuid::Uuid>,
    client_id: Option<uuid::Uuid>,
    project_id: Option<uuid::Uuid>,
) -> Vec<(String, String, String)> {
    let mut clauses = vec!["(scope = 'base' AND scope_id IS NULL)".to_string()];
    if let Some(eid) = expert_id {
        clauses.push(format!("(scope = 'expert' AND scope_id = '{eid}')"));
    }
    if let Some(cid) = client_id {
        clauses.push(format!("(scope = 'client' AND scope_id = '{cid}')"));
    }
    if let Some(pid) = project_id {
        clauses.push(format!("(scope = 'project' AND scope_id = '{pid}')"));
    }

    let sql = format!(
        "SELECT scope, narrative_text, generated_at FROM scope_narratives WHERE {} \
         ORDER BY CASE scope WHEN 'base' THEN 0 WHEN 'expert' THEN 1 \
         WHEN 'client' THEN 2 WHEN 'project' THEN 3 END",
        clauses.join(" OR ")
    );

    match db.execute(&sql).await {
        Ok(rows) => rows
            .iter()
            .filter_map(|r| {
                let scope = r.get("scope")?.as_str()?.to_string();
                let text = r.get("narrative_text")?.as_str()?.to_string();
                let gen = r.get("generated_at")?.as_str()?.to_string();
                Some((scope, text, gen))
            })
            .collect(),
        Err(_) => vec![],
    }
}

/// Build the full assembled prompt for a spawned agent.
/// Concatenates: skill base_prompt + base_lessons + overlays + orchestrator context + criteria.
pub async fn build_assembled_prompt(
    db: &PgClient,
    skill_slugs: &[String],
    skill_catalog: &SkillCatalog,
    expert_id: Option<uuid::Uuid>,
    client_id: Option<uuid::Uuid>,
    project_id: Option<uuid::Uuid>,
    spawn_context: Option<&str>,
    acceptance_criteria: Option<&[String]>,
    spawn_examples: Option<&str>,
) -> String {
    let mut prompt = String::new();

    for slug in skill_slugs {
        let skill = match skill_catalog.get(slug) {
            Some(s) => s,
            None => {
                warn!(slug = %slug, "skill not found in catalog");
                continue;
            }
        };

        prompt.push_str(&skill.base_prompt);
        prompt.push('\n');

        if let Some(ref lessons) = skill.base_lessons {
            if !lessons.is_empty() {
                prompt.push_str("\n## Lessons Learned\n");
                prompt.push_str(lessons);
                prompt.push('\n');
            }
        }

        if !skill.knowledge_docs.is_empty() {
            prompt.push_str("\n## Reference Knowledge\n");
            for doc in &skill.knowledge_docs {
                prompt.push_str(doc);
                prompt.push('\n');
            }
        }

        let overlays =
            resolve_overlays(db, skill.id, expert_id, client_id, project_id).await;
        if !overlays.is_empty() {
            prompt.push_str("\n## Contextual Lessons & Preferences\n");
            prompt.push_str(&overlays);
            prompt.push('\n');
        }
    }

    if let Some(ctx) = spawn_context {
        if !ctx.is_empty() {
            prompt.push_str("\n## Task Context\n");
            prompt.push_str(ctx);
            prompt.push('\n');
        }
    }

    if let Some(criteria) = acceptance_criteria {
        if !criteria.is_empty() {
            prompt.push_str("\n## Acceptance Criteria\n");
            for (i, c) in criteria.iter().enumerate() {
                prompt.push_str(&format!("{}. {}\n", i + 1, c));
            }
        }
    }

    if let Some(examples) = spawn_examples {
        if !examples.is_empty() {
            prompt.push_str("\n## Examples & References\n");
            prompt.push_str(examples);
            prompt.push('\n');
        }
    }

    prompt
}

// ── Seeding ──────────────────────────────────────────────────────────────────

async fn seed_skills_from_agents(db: &PgClient) -> anyhow::Result<()> {
    let rows = db
        .execute(
            "SELECT slug, name, category, description, system_prompt, tools, \
             judge_config, examples, knowledge_docs, max_iterations, model, \
             skip_judge, expert_id FROM agent_definitions ORDER BY slug",
        )
        .await?;

    for row in &rows {
        let slug = match row.get("slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };

        let name = row.get("name").and_then(Value::as_str).unwrap_or("");
        let description = row.get("description").and_then(Value::as_str).unwrap_or("");
        let base_prompt = row.get("system_prompt").and_then(Value::as_str).unwrap_or("");

        let judge_config = row
            .get("judge_config")
            .map(|v| v.to_string())
            .unwrap_or_else(|| r#"{"threshold":7.0,"rubric":[],"need_to_know":[]}"#.to_string());

        let examples = row
            .get("examples")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "[]".to_string());

        // Build knowledge_docs as a PostgreSQL array literal using dollar-quoting.
        // Use a unique delimiter per item to prevent content containing the delimiter
        // from breaking the SQL (e.g. if a doc literally contains "$kd0$").
        let knowledge_docs_val: String = row
            .get("knowledge_docs")
            .and_then(Value::as_array)
            .map(|arr| {
                if arr.is_empty() {
                    return "ARRAY[]::text[]".to_string();
                }
                let items: Vec<String> = arr
                    .iter()
                    .filter_map(Value::as_str)
                    .enumerate()
                    .map(|(i, s)| {
                        // Find a delimiter tag that doesn't appear in the content
                        let mut tag = format!("kd{i}");
                        while s.contains(&format!("${tag}$")) {
                            tag.push('_');
                        }
                        format!("${tag}${s}${tag}$")
                    })
                    .collect();
                format!("ARRAY[{}]::text[]", items.join(","))
            })
            .unwrap_or_else(|| "ARRAY[]::text[]".to_string());

        let tools_val: String = row
            .get("tools")
            .and_then(Value::as_array)
            .map(|arr| {
                if arr.is_empty() {
                    return "ARRAY[]::text[]".to_string();
                }
                let items: Vec<String> = arr
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| format!("\'{}\'", s))
                    .collect();
                format!("ARRAY[{}]::text[]", items.join(","))
            })
            .unwrap_or_else(|| "ARRAY[]::text[]".to_string());

        let max_iter = row.get("max_iterations").and_then(Value::as_i64).unwrap_or(15);
        let model_val = row
            .get("model")
            .and_then(Value::as_str)
            .map(|m| format!("$m${}$m$", m))
            .unwrap_or_else(|| "NULL".to_string());
        let skip_judge = row.get("skip_judge").and_then(Value::as_bool).unwrap_or(false);
        let expert_id_val = row
            .get("expert_id")
            .and_then(Value::as_str)
            .map(|id| format!("\'{id}\'"))
            .unwrap_or_else(|| "NULL".to_string());

        // Use dollar-quoting for all text fields to avoid single-quote escaping issues
        let sql = format!(
            r#"INSERT INTO skills
                (slug, name, description, base_prompt, judge_config, examples,
                 knowledge_docs, default_tools, max_iterations, model, skip_judge, expert_id)
               VALUES
                ($s${slug}$s$, $n${name}$n$, $d${description}$d$, $bp${base_prompt}$bp$,
                 $jc${judge_config}$jc$::jsonb, $ex${examples}$ex$::jsonb,
                 {knowledge_docs_val}, {tools_val}, {max_iter}, {model_val}, {skip_judge},
                 {expert_id_val})
               ON CONFLICT (slug) DO NOTHING"#,
        );

        match db.execute(&sql).await {
            Ok(_) => info!(slug = slug, "seeded skill from agent_definition"),
            Err(e) => warn!(slug = slug, error = %e, "failed to seed skill"),
        }
    }

    Ok(())
}
