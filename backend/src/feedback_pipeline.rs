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

    let groups = db.execute_unparameterized(groups_sql).await?;
    if groups.is_empty() {
        return Ok(0);
    }

    // Load all unresolved signals in a single query, then group in memory (avoids N+1).
    let all_signals_sql = r#"
        SELECT id, description, session_id, agent_slug, signal_type, weight, created_at
        FROM feedback_signals
        WHERE resolution IS NULL
        ORDER BY weight DESC, created_at
    "#;
    let all_signals = db.execute_unparameterized(all_signals_sql).await?;

    // Group by (agent_slug, signal_type) in memory
    let mut signal_groups: std::collections::HashMap<(String, String), Vec<Value>> =
        std::collections::HashMap::new();
    for signal in all_signals {
        let slug = signal.get("agent_slug").and_then(Value::as_str).unwrap_or("").to_string();
        let stype = signal.get("signal_type").and_then(Value::as_str).unwrap_or("").to_string();
        let group = signal_groups.entry((slug, stype)).or_default();
        if group.len() < 20 {
            group.push(signal);
        }
    }

    let mut total_deduped = 0;

    for group_row in &groups {
        let agent_slug = match group_row.get("agent_slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let signal_type = match group_row.get("signal_type").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };

        let key = (agent_slug.to_string(), signal_type.to_string());
        let signals = match signal_groups.get(&key) {
            Some(s) if s.len() >= 2 => s,
            _ => continue,
        };

        let clusters = cluster_similar_signals(api_key, model, signals).await?;

        for cluster in &clusters {
            if cluster.len() < 2 {
                continue;
            }

            let canonical_id = match cluster[0].get("id").and_then(Value::as_str) {
                Some(s) => s,
                None => continue,
            };

            // Collect all duplicate IDs and batch-update in a single query
            let dup_ids: Vec<&str> = cluster[1..]
                .iter()
                .filter_map(|dup| dup.get("id").and_then(Value::as_str))
                .collect();

            if dup_ids.is_empty() {
                continue;
            }

            let dup_uuids: Vec<Uuid> = dup_ids.iter()
                .filter_map(|id| id.parse::<Uuid>().ok())
                .collect();
            let canonical_uuid = match canonical_id.parse::<Uuid>() {
                Ok(u) => u,
                Err(_) => continue,
            };
            if let Ok(rows) = db.execute_with(
                "UPDATE feedback_signals \
                 SET resolution = 'deduped', canonical_signal_id = $1 \
                 WHERE id = ANY($2) AND resolution IS NULL",
                crate::pg_args!(canonical_uuid, dup_uuids),
            ).await {
                total_deduped += rows.len().max(dup_ids.len());
            }

            info!(
                agent = agent_slug,
                signal_type,
                canonical = canonical_id,
                duplicates = dup_ids.len(),
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

    use std::fmt::Write;
    let mut items = String::with_capacity(signals.len() * 80);
    for (i, s) in signals.iter().enumerate() {
        let desc = s.get("description").and_then(Value::as_str).unwrap_or("");
        let _ = writeln!(items, "{}. {}", i, desc);
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
    // sql-format-ok: MIN_SESSIONS_FOR_PATTERN is a compile-time constant.
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

    let candidates = db.execute_unparameterized(&candidates_sql).await?;
    if candidates.is_empty() {
        return Ok(0);
    }

    // Pre-load all active patterns in one query to avoid per-candidate existence checks (N+1).
    let existing_patterns = db.execute_unparameterized(
        "SELECT agent_slug, pattern_type FROM feedback_patterns WHERE status = 'active'"
    ).await.unwrap_or_default();
    let existing_set: std::collections::HashSet<(String, String)> = existing_patterns
        .iter()
        .filter_map(|row| {
            let slug = row.get("agent_slug").and_then(Value::as_str)?.to_string();
            let ptype = row.get("pattern_type").and_then(Value::as_str)?.to_string();
            Some((slug, ptype))
        })
        .collect();

    // Filter candidates that don't already have an active pattern, and prepare data
    // for concurrent LLM summarization.
    struct PatternCandidate {
        agent_slug: String,
        signal_type: String,
        session_count: i32,
        descriptions: String,
        signal_ids: Vec<Uuid>,
    }

    let mut to_summarize: Vec<PatternCandidate> = Vec::new();
    for candidate in &candidates {
        let agent_slug = match candidate.get("agent_slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let signal_type = match candidate.get("signal_type").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };

        if existing_set.contains(&(agent_slug.to_string(), signal_type.to_string())) {
            continue;
        }

        let session_count = candidate
            .get("session_count")
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32;
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
        let signal_ids = extract_signal_ids(candidate);

        to_summarize.push(PatternCandidate {
            agent_slug: agent_slug.to_string(),
            signal_type: signal_type.to_string(),
            session_count,
            descriptions,
            signal_ids,
        });
    }

    if to_summarize.is_empty() {
        return Ok(0);
    }

    // Fire all LLM summarization calls concurrently instead of sequentially.
    let summary_futures: Vec<_> = to_summarize
        .iter()
        .map(|c| summarize_pattern(api_key, model, &c.agent_slug, &c.signal_type, &c.descriptions))
        .collect();
    let summaries = futures_util::future::join_all(summary_futures).await;

    let mut patterns_created = 0;

    for (candidate, summary_result) in to_summarize.iter().zip(summaries.into_iter()) {
        let description = summary_result.unwrap_or_else(|_| {
            format!("Recurring {} pattern for agent {}", candidate.signal_type, candidate.agent_slug)
        });

        let severity = match candidate.session_count {
            n if n >= 10 => "critical",
            n if n >= 5 => "high",
            _ => "medium",
        };

        let pattern_id = Uuid::new_v4();

        match db.execute_with(
            r#"INSERT INTO feedback_patterns
                (id, agent_slug, pattern_type, description, signal_ids,
                 session_count, severity, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')"#,
            crate::pg_args!(
                pattern_id,
                candidate.agent_slug.clone(),
                candidate.signal_type.clone(),
                description.clone(),
                candidate.signal_ids.clone(),
                candidate.session_count as i64,
                severity.to_string(),
            ),
        ).await {
            Ok(_) => {
                patterns_created += 1;
                info!(
                    pattern = %pattern_id,
                    agent = %candidate.agent_slug,
                    signal_type = %candidate.signal_type,
                    session_count = candidate.session_count,
                    severity,
                    "detected recurring failure pattern"
                );
            }
            Err(e) => {
                warn!(agent = %candidate.agent_slug, signal_type = %candidate.signal_type, error = %e, "failed to insert pattern");
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

