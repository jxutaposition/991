/// Feedback pipeline — multi-level review system for feedback signal processing.
///
/// Stage 1: Signal collection (handled by feedback.rs record_* functions)
/// Stage 2: Signal clustering/dedup — group similar signals, mark duplicates
/// Stage 3: Pattern detection — identify recurring failures per agent
/// Stage 4: PR proposal (handled by feedback::synthesize_feedback)
/// Stage 5: Auto-apply with thresholds (handled by feedback::synthesize_feedback)
use serde_json::{json, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::anthropic::{user_message, AnthropicClient};
use crate::feedback;
use crate::pg::PgClient;

const MIN_SESSIONS_FOR_PATTERN: usize = 3;

/// Run the full feedback pipeline: cluster -> detect patterns -> synthesize PRs.
pub async fn run_feedback_pipeline(
    db: &PgClient,
    api_key: &str,
    model: &str,
    catalog: Option<&AgentCatalog>,
) -> anyhow::Result<PipelineResult> {
    let deduped = cluster_signals(db, api_key, model).await?;
    let patterns = detect_patterns(db, api_key, model).await?;
    let prs = feedback::synthesize_feedback(db, api_key, model, catalog).await?;

    let result = PipelineResult {
        signals_deduped: deduped,
        patterns_detected: patterns,
        prs_created: prs,
    };

    info!(
        deduped = result.signals_deduped,
        patterns = result.patterns_detected,
        prs = result.prs_created.len(),
        "feedback pipeline complete"
    );

    Ok(result)
}

#[derive(Debug)]
pub struct PipelineResult {
    pub signals_deduped: usize,
    pub patterns_detected: usize,
    pub prs_created: Vec<Uuid>,
}

// ── Stage 2: Signal Clustering / Dedup ───────────────────────────────────────

/// Cluster unresolved signals by agent + type, then use LLM to identify
/// semantically duplicate signals. Marks duplicates with resolution='deduped'
/// and sets canonical_signal_id.
async fn cluster_signals(
    db: &PgClient,
    api_key: &str,
    model: &str,
) -> anyhow::Result<usize> {
    let groups_sql = r#"
        SELECT agent_slug, signal_type, COUNT(*) as cnt
        FROM feedback_signals
        WHERE resolution IS NULL
        GROUP BY agent_slug, signal_type
        HAVING COUNT(*) >= 2
        ORDER BY COUNT(*) DESC
    "#;

    let groups = db.execute(groups_sql).await?;
    let mut total_deduped = 0;

    for group in &groups {
        let agent_slug = match group.get("agent_slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let signal_type = match group.get("signal_type").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };

        let slug_escaped = agent_slug.replace('\'', "''");
        let type_escaped = signal_type.replace('\'', "''");

        let signals_sql = format!(
            r#"SELECT id, description, session_id
               FROM feedback_signals
               WHERE agent_slug = '{slug_escaped}'
                 AND signal_type = '{type_escaped}'
                 AND resolution IS NULL
               ORDER BY weight DESC, created_at
               LIMIT 20"#
        );
        let signals = db.execute(&signals_sql).await?;

        if signals.len() < 2 {
            continue;
        }

        let clusters = cluster_similar_signals(api_key, model, &signals).await?;

        for cluster in &clusters {
            if cluster.len() < 2 {
                continue;
            }

            let canonical_id = match cluster[0].get("id").and_then(Value::as_str) {
                Some(s) => s,
                None => continue,
            };

            for dup in &cluster[1..] {
                let dup_id = match dup.get("id").and_then(Value::as_str) {
                    Some(s) => s,
                    None => continue,
                };

                let update_sql = format!(
                    "UPDATE feedback_signals \
                     SET resolution = 'deduped', canonical_signal_id = '{canonical_id}'::uuid \
                     WHERE id = '{dup_id}'::uuid AND resolution IS NULL"
                );
                if db.execute(&update_sql).await.is_ok() {
                    total_deduped += 1;
                }
            }

            info!(
                agent = agent_slug,
                signal_type,
                canonical = canonical_id,
                duplicates = cluster.len() - 1,
                "deduped signal cluster"
            );
        }
    }

    Ok(total_deduped)
}

async fn cluster_similar_signals(
    api_key: &str,
    model: &str,
    signals: &[Value],
) -> anyhow::Result<Vec<Vec<Value>>> {
    if signals.len() <= 1 {
        return Ok(vec![signals.to_vec()]);
    }

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    let mut items = String::new();
    for (i, s) in signals.iter().enumerate() {
        let desc = s.get("description").and_then(Value::as_str).unwrap_or("");
        items.push_str(&format!("{}. {}\n", i, desc));
    }

    let system = "You group semantically duplicate feedback signals. Output JSON only.";
    let prompt = format!(
        "Group these feedback signals by semantic similarity. Signals describing \
         the same underlying issue should be grouped together.\n\n{items}\n\n\
         Output: {{\"clusters\": [[0, 2, 5], [1, 3], [4]]}} — arrays of indices. \
         The first index in each cluster is the canonical (most descriptive) signal."
    );

    let response = client
        .messages(system, &[user_message(prompt)], &[], 1024, Some(model))
        .await?;

    let text = response.text();
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: Value = serde_json::from_str(cleaned).unwrap_or(json!({"clusters": []}));
    let cluster_indices = parsed
        .get("clusters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut clusters = Vec::new();
    for cluster in &cluster_indices {
        let indices: Vec<usize> = cluster
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_u64)
                    .map(|n| n as usize)
                    .filter(|&i| i < signals.len())
                    .collect()
            })
            .unwrap_or_default();

        let group: Vec<Value> = indices.iter().map(|&i| signals[i].clone()).collect();
        if !group.is_empty() {
            clusters.push(group);
        }
    }

    Ok(clusters)
}

// ── Stage 3: Pattern Detection ───────────────────────────────────────────────

/// Detect recurring failure patterns by analyzing unresolved and recent signals
/// for each agent. A pattern is identified when the same agent + signal_type
/// appears in 3+ distinct sessions.
async fn detect_patterns(
    db: &PgClient,
    api_key: &str,
    model: &str,
) -> anyhow::Result<usize> {
    let candidates_sql = format!(
        r#"SELECT agent_slug, signal_type,
                  COUNT(DISTINCT session_id) as session_count,
                  array_agg(id) as signal_ids,
                  array_agg(DISTINCT description) as descriptions
           FROM feedback_signals
           WHERE resolution IS NULL OR resolution = 'applied'
           GROUP BY agent_slug, signal_type
           HAVING COUNT(DISTINCT session_id) >= {MIN_SESSIONS_FOR_PATTERN}
           ORDER BY COUNT(DISTINCT session_id) DESC"#
    );

    let candidates = db.execute(&candidates_sql).await?;
    let mut patterns_created = 0;

    for candidate in &candidates {
        let agent_slug = match candidate.get("agent_slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let signal_type = match candidate.get("signal_type").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let session_count = candidate
            .get("session_count")
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32;

        let slug_escaped = agent_slug.replace('\'', "''");
        let type_escaped = signal_type.replace('\'', "''");

        let existing_sql = format!(
            "SELECT 1 FROM feedback_patterns \
             WHERE agent_slug = '{slug_escaped}' \
             AND pattern_type = '{type_escaped}' \
             AND status = 'active' \
             LIMIT 1"
        );
        if let Ok(rows) = db.execute(&existing_sql).await {
            if !rows.is_empty() {
                continue;
            }
        }

        let descriptions = candidate
            .get("descriptions")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n- ")
            })
            .unwrap_or_default();

        let description = summarize_pattern(
            api_key,
            model,
            agent_slug,
            signal_type,
            &descriptions,
        )
        .await
        .unwrap_or_else(|_| {
            format!("Recurring {signal_type} pattern for agent {agent_slug}")
        });

        let signal_ids = extract_signal_ids(candidate);
        let signal_ids_sql = format_uuid_array(&signal_ids);

        let severity = match session_count {
            n if n >= 10 => "critical",
            n if n >= 5 => "high",
            _ => "medium",
        };

        let pattern_id = Uuid::new_v4();
        let desc_escaped = description.replace('\'', "''");

        let insert_sql = format!(
            r#"INSERT INTO feedback_patterns
                (id, agent_slug, pattern_type, description, signal_ids,
                 session_count, severity, status)
               VALUES
                ('{pattern_id}', '{slug_escaped}', '{type_escaped}', '{desc_escaped}',
                 {signal_ids_sql}, {session_count}, '{severity}', 'active')"#
        );

        match db.execute(&insert_sql).await {
            Ok(_) => {
                patterns_created += 1;
                info!(
                    pattern = %pattern_id,
                    agent = agent_slug,
                    signal_type,
                    session_count,
                    severity,
                    "detected recurring failure pattern"
                );
            }
            Err(e) => {
                warn!(agent = agent_slug, signal_type, error = %e, "failed to insert pattern");
            }
        }
    }

    Ok(patterns_created)
}

async fn summarize_pattern(
    api_key: &str,
    model: &str,
    agent_slug: &str,
    signal_type: &str,
    descriptions: &str,
) -> anyhow::Result<String> {
    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    let system = "You summarize recurring feedback patterns into a concise description. \
                  Output only the summary text, no JSON.";
    let prompt = format!(
        "Agent: {agent_slug}\nSignal type: {signal_type}\n\n\
         These feedback signals keep recurring across multiple sessions:\n\
         - {descriptions}\n\n\
         Summarize the core pattern in 1-2 sentences."
    );

    let response = client
        .messages(system, &[user_message(prompt)], &[], 256, Some(model))
        .await?;

    Ok(response.text().trim().to_string())
}

fn extract_signal_ids(candidate: &Value) -> Vec<Uuid> {
    candidate
        .get("signal_ids")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter_map(|s| s.parse::<Uuid>().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn format_uuid_array(ids: &[Uuid]) -> String {
    if ids.is_empty() {
        return "ARRAY[]::uuid[]".to_string();
    }
    let items: Vec<String> = ids.iter().map(|id| format!("'{id}'::uuid")).collect();
    format!("ARRAY[{}]::uuid[]", items.join(", "))
}
