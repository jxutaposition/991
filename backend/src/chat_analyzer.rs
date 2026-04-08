/// Chat Analyzer — periodic background pipeline that extracts learnings from
/// completed chat transcripts and distills them into scoped overlays.
///
/// Three stages:
/// 1. Extract: segment transcript by node, LLM extracts learning candidates
/// 2. Distill: batched dedup + conflict detection against existing overlays
/// 3. Synthesize: regenerate cross-cutting scope narratives when thresholds met
use std::collections::{HashMap, HashSet};
use std::env;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::anthropic::{user_message, AnthropicClient};
use crate::pg::PgClient;
use crate::pg_args;

const ANALYSIS_INTERVAL: Duration = Duration::from_secs(7200); // 2 hours
const MAX_FAILURES: i32 = 3;
const MAX_TRANSCRIPT_CHARS: usize = 80_000;

// ── Scheduler ────────────────────────────────────────────────────────────────

pub fn spawn_scheduler(
    db: PgClient,
    api_key: String,
    model: String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("chat analyzer scheduler started");
        let mut interval = tokio::time::interval(ANALYSIS_INTERVAL);
        interval.tick().await; // skip immediate first tick

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    info!("chat analyzer: starting analysis cycle");
                    match run_analysis_cycle(&db, &api_key, &model).await {
                        Ok(count) => info!(sessions = count, "chat analyzer cycle complete"),
                        Err(e) => warn!(error = %e, "chat analyzer cycle failed"),
                    }
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        info!("chat analyzer shutting down");
                        break;
                    }
                }
            }
        }
    })
}

// ── Main Cycle ───────────────────────────────────────────────────────────────

pub async fn run_analysis_cycle(
    db: &PgClient,
    api_key: &str,
    model: &str,
) -> anyhow::Result<usize> {
    let lookback_days: i64 = env::var("CHAT_ANALYZER_LOOKBACK_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let default_batch: i64 = env::var("CHAT_ANALYZER_BATCH_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let catchup_threshold: i64 = env::var("CATCHUP_THRESHOLD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    let catchup_batch: i64 = env::var("CHAT_ANALYZER_CATCHUP_BATCH_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);

    let backlog_rows = db
        .execute_with(
            "SELECT COUNT(*) as cnt FROM execution_sessions es \
             WHERE es.analysis_skip = FALSE \
               AND es.created_at > NOW() - make_interval(days => $1) \
               AND EXISTS (SELECT 1 FROM node_messages nm WHERE nm.session_id = es.id AND nm.role = 'user') \
               AND (es.learning_scanned_up_to IS NULL \
                    OR EXISTS (SELECT 1 FROM node_messages nm2 \
                               WHERE nm2.session_id = es.id AND nm2.created_at > es.learning_scanned_up_to))",
            pg_args!(lookback_days as f64),
        )
        .await?;
    let backlog = backlog_rows
        .first()
        .and_then(|r| r.get("cnt").and_then(Value::as_i64))
        .unwrap_or(0);

    let batch_size = if backlog > catchup_threshold {
        info!(backlog, threshold = catchup_threshold, "catch-up mode activated");
        catchup_batch
    } else {
        default_batch
    };

    let sessions = db
        .execute_with(
            "SELECT es.id, es.request_text, es.project_id, es.client_id, \
                    p.expert_id, p.slug as project_slug \
             FROM execution_sessions es \
             LEFT JOIN projects p ON es.project_id = p.id \
             WHERE es.analysis_skip = FALSE \
               AND es.created_at > NOW() - make_interval(days => $1) \
               AND EXISTS (SELECT 1 FROM node_messages nm WHERE nm.session_id = es.id AND nm.role = 'user') \
               AND (es.learning_scanned_up_to IS NULL \
                    OR EXISTS (SELECT 1 FROM node_messages nm2 \
                               WHERE nm2.session_id = es.id AND nm2.created_at > es.learning_scanned_up_to)) \
             ORDER BY es.created_at DESC \
             LIMIT $2",
            pg_args!(lookback_days as f64, batch_size),
        )
        .await?;

    if sessions.is_empty() {
        return Ok(0);
    }

    let mut narratives_regenerated: HashSet<(String, Option<Uuid>)> = HashSet::new();
    let mut processed = 0;

    for session_row in &sessions {
        let session_id = match session_row
            .get("id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<Uuid>().ok())
        {
            Some(id) => id,
            None => continue,
        };

        match analyze_session(
            db,
            api_key,
            model,
            session_id,
            session_row,
            &mut narratives_regenerated,
        )
        .await
        {
            Ok(_) => {
                // Advance watermark to current max message time on success
                let _ = db
                    .execute_with(
                        "UPDATE execution_sessions \
                         SET learning_scanned_up_to = (SELECT MAX(created_at) FROM node_messages WHERE session_id = $1), \
                             learning_analyzed_at = NOW() \
                         WHERE id = $1",
                        pg_args!(session_id),
                    )
                    .await;
                processed += 1;
            }
            Err(e) => {
                warn!(session = %session_id, error = %e, "session analysis failed");
                let _ = db
                    .execute_with(
                        "UPDATE execution_sessions \
                         SET analysis_failure_count = analysis_failure_count + 1, \
                             analysis_skip = CASE WHEN analysis_failure_count + 1 >= $2 \
                                             THEN TRUE ELSE FALSE END \
                         WHERE id = $1",
                        pg_args!(session_id, MAX_FAILURES),
                    )
                    .await;
            }
        }
    }

    Ok(processed)
}

/// Analyze a single session: collect transcript, extract learnings, distill, synthesize.
pub async fn analyze_session(
    db: &PgClient,
    api_key: &str,
    model: &str,
    session_id: Uuid,
    session_row: &Value,
    narratives_regenerated: &mut HashSet<(String, Option<Uuid>)>,
) -> anyhow::Result<()> {
    let project_id = session_row
        .get("project_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok());
    let client_id = session_row
        .get("client_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok());
    let expert_id = session_row
        .get("expert_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok());

    // Stage 0: Collect transcript
    let segments = collect_session_transcript(db, session_id).await?;
    if segments.is_empty() {
        info!(session = %session_id, "no transcript segments, skipping");
        return Ok(());
    }

    // Load skill catalog for slug vocabulary
    let skill_slugs = load_skill_slugs(db).await?;

    // Stage 1: Extract learnings
    let mut learnings = extract_learnings(api_key, model, &segments, &skill_slugs).await?;
    if learnings.is_empty() {
        info!(session = %session_id, "no learnings extracted");
        return Ok(());
    }

    // Canonicalize slugs before batching
    canonicalize_slugs(&skill_slugs, &mut learnings);

    // Persist raw learnings to chat_learnings table
    for l in &learnings {
        let _ = db
            .execute_with(
                "INSERT INTO chat_learnings \
                 (session_id, learning_text, suggested_scope, suggested_primitive_slug, \
                  confidence, evidence, source_node_id) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
                pg_args!(
                    session_id,
                    l.learning_text.clone(),
                    l.suggested_scope.clone(),
                    l.suggested_primitive_slug.clone(),
                    l.confidence.clone(),
                    l.evidence.clone().unwrap_or_default(),
                    l.source_node_id
                ),
            )
            .await;
    }

    // Stage 2: Batched distill + dedup + conflict detection
    let scope_ctx = ScopeContext {
        project_id,
        client_id,
        expert_id,
    };
    distill_and_store(db, api_key, model, session_id, &learnings, &scope_ctx).await?;

    // Stage 3: Maybe regenerate narratives for affected scopes
    let affected_scopes = collect_affected_scopes(&learnings, &scope_ctx);
    for (scope, scope_id) in affected_scopes {
        maybe_regenerate_narrative(
            db,
            api_key,
            model,
            &scope,
            scope_id,
            narratives_regenerated,
        )
        .await;
    }

    info!(
        session = %session_id,
        learnings = learnings.len(),
        "session analysis complete"
    );
    Ok(())
}

// ── Data Structures ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TranscriptSegment {
    pub node_id: Uuid,
    pub agent_slug: String,
    pub task_description: String,
    pub messages: Vec<TranscriptMessage>,
}

#[derive(Debug, Clone)]
pub struct TranscriptMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningCandidate {
    pub learning_text: String,
    pub suggested_scope: String,
    pub suggested_primitive_slug: String,
    pub confidence: String,
    pub evidence: Option<String>,
    pub source_node_id: Option<Uuid>,
}

struct ScopeContext {
    project_id: Option<Uuid>,
    client_id: Option<Uuid>,
    expert_id: Option<Uuid>,
}

// ── Stage 0: Transcript Collection ───────────────────────────────────────────

// Known limitation: this reads the FULL transcript every time, even for
// incremental re-scans triggered by new messages after the watermark. The
// distill stage's LLM-based dedup should catch most duplicate extractions.
// TODO: accept an optional `since: Option<DateTime>` parameter and filter
// node_messages to `created_at > since` for true incremental analysis.
async fn collect_session_transcript(
    db: &PgClient,
    session_id: Uuid,
) -> anyhow::Result<Vec<TranscriptSegment>> {
    let nodes = db
        .execute_with(
            "SELECT id, agent_slug, task_description, skill_slugs, \
                    clarification_request, clarification_response \
             FROM execution_nodes \
             WHERE session_id = $1 \
             ORDER BY depth ASC, created_at ASC",
            pg_args!(session_id),
        )
        .await?;

    let mut segments = Vec::new();

    for node in &nodes {
        let node_id = match node
            .get("id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<Uuid>().ok())
        {
            Some(id) => id,
            None => continue,
        };
        let agent_slug = node
            .get("agent_slug")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let task_desc = node
            .get("task_description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let msg_rows = db
            .execute_with(
                "SELECT role, content FROM node_messages \
                 WHERE node_id = $1 \
                 ORDER BY created_at ASC",
                pg_args!(node_id),
            )
            .await
            .unwrap_or_default();

        let mut messages: Vec<TranscriptMessage> = msg_rows
            .iter()
            .filter_map(|r| {
                let role = r.get("role")?.as_str()?.to_string();
                let content = r.get("content")?.as_str()?.to_string();
                if role == "user" || role == "assistant" {
                    Some(TranscriptMessage { role, content })
                } else {
                    None
                }
            })
            .collect();

        // Include clarification exchanges (from Slack or UI)
        if let Some(req) = node.get("clarification_request").and_then(Value::as_str) {
            if !req.is_empty() {
                messages.push(TranscriptMessage {
                    role: "assistant".to_string(),
                    content: format!("[Clarification request] {req}"),
                });
            }
        }
        if let Some(resp) = node.get("clarification_response").and_then(Value::as_str) {
            if !resp.is_empty() {
                messages.push(TranscriptMessage {
                    role: "user".to_string(),
                    content: format!("[Clarification response] {resp}"),
                });
            }
        }

        if !messages.is_empty() {
            segments.push(TranscriptSegment {
                node_id,
                agent_slug,
                task_description: task_desc,
                messages,
            });
        }
    }

    Ok(segments)
}

fn format_transcript_for_llm(segments: &[TranscriptSegment]) -> String {
    let mut output = String::new();
    for (i, seg) in segments.iter().enumerate() {
        output.push_str(&format!(
            "\n--- Segment {} (node_id: {}, agent: {}) ---\n",
            i + 1,
            seg.node_id,
            seg.agent_slug
        ));
        if !seg.task_description.is_empty() {
            output.push_str(&format!("Task: {}\n\n", seg.task_description));
        }
        for msg in &seg.messages {
            output.push_str(&format!("[{}]: {}\n", msg.role, msg.content));
        }
    }
    // Truncate if too long
    if output.len() > MAX_TRANSCRIPT_CHARS {
        output.truncate(MAX_TRANSCRIPT_CHARS);
        output.push_str("\n... [transcript truncated]");
    }
    output
}

// ── Stage 1: Extract Learnings ───────────────────────────────────────────────

async fn load_skill_slugs(db: &PgClient) -> anyhow::Result<Vec<String>> {
    let rows = db.execute_unparameterized("SELECT slug FROM skills ORDER BY slug").await?;
    Ok(rows
        .iter()
        .filter_map(|r| r.get("slug").and_then(Value::as_str).map(String::from))
        .collect())
}

async fn extract_learnings(
    api_key: &str,
    model: &str,
    segments: &[TranscriptSegment],
    skill_slugs: &[String],
) -> anyhow::Result<Vec<LearningCandidate>> {
    let client = AnthropicClient::new(api_key.to_string(), model.to_string());
    let transcript = format_transcript_for_llm(segments);
    let slug_list = skill_slugs.join(", ");

    let system = format!(
        "You analyze agent chat transcripts to extract actionable learnings. \
         A \"learning\" is a reusable insight that should influence future agent behavior.\n\n\
         CRITICAL: Preserve the user's exact terminology and phrasing. Do not \
         paraphrase, generalize, or substitute synonyms. If the user said \"bulk \
         endpoint,\" write \"bulk endpoint\" — not \"batch API operations.\"\n\n\
         Categories of learnings:\n\
         - User corrections: \"No, don't do X, do Y instead\"\n\
         - Style preferences: \"I prefer shorter emails\" / \"Always use formal tone\"\n\
         - Domain rules: \"In banking, VP is a junior title\"\n\
         - Process improvements: \"Check the CRM before sending outreach\"\n\
         - Tool usage: \"Use the bulk endpoint instead of individual calls\"\n\n\
         Do NOT extract:\n\
         - Task-specific details with no generalizable lesson\n\
         - Routine confirmations (\"looks good\", \"approved\")\n\
         - Information better served by document search (long reference data)\n\n\
         The transcript is divided into labeled segments. Each segment corresponds \
         to one agent node with its own task. Attribute each learning to the segment \
         where it originates.\n\n\
         SKILL CATALOG (pick suggested_primitive_slug from this list):\n{slug_list}\n\n\
         If a learning is cross-cutting and doesn't map to a specific skill above, \
         use \"general\" as the slug. Every learning MUST have a slug assigned.\n\n\
         For each learning output:\n\
         {{\n\
           \"learning_text\": \"exact phrasing\",\n\
           \"suggested_scope\": \"project|client|expert|base\",\n\
           \"suggested_primitive_slug\": \"slug from catalog above or general\",\n\
           \"confidence\": \"high|medium|low\",\n\
           \"evidence\": \"why this is a learning, citing the segment\",\n\
           \"source_node_id\": \"uuid of the originating node\"\n\
         }}\n\n\
         Output JSON: {{ \"learnings\": [...] }}\n\
         If there are no extractable learnings, output: {{ \"learnings\": [] }}"
    );

    let prompt = format!("Analyze this chat transcript:\n{transcript}");
    let response = client
        .messages(&system, &[user_message(prompt)], &[], 4096, Some(model))
        .await?;

    let text = response.text();
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: Value = serde_json::from_str(cleaned).unwrap_or(json!({"learnings": []}));
    let raw_learnings = parsed
        .get("learnings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut candidates = Vec::new();
    for item in &raw_learnings {
        let learning_text = match item.get("learning_text").and_then(Value::as_str) {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => continue,
        };
        let suggested_scope = item
            .get("suggested_scope")
            .and_then(Value::as_str)
            .unwrap_or("project")
            .to_string();
        let suggested_primitive_slug = item
            .get("suggested_primitive_slug")
            .and_then(Value::as_str)
            .unwrap_or("general")
            .to_string();
        let confidence = item
            .get("confidence")
            .and_then(Value::as_str)
            .unwrap_or("medium")
            .to_string();
        let evidence = item
            .get("evidence")
            .and_then(Value::as_str)
            .map(String::from);
        let source_node_id = item
            .get("source_node_id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<Uuid>().ok());

        candidates.push(LearningCandidate {
            learning_text,
            suggested_scope,
            suggested_primitive_slug,
            confidence,
            evidence,
            source_node_id,
        });
    }

    info!(count = candidates.len(), "extracted learning candidates");
    Ok(candidates)
}

// ── Slug Canonicalization ────────────────────────────────────────────────────

fn canonicalize_slugs(valid_slugs: &[String], learnings: &mut [LearningCandidate]) {
    for l in learnings.iter_mut() {
        if l.suggested_primitive_slug == "general" {
            continue;
        }
        if valid_slugs.contains(&l.suggested_primitive_slug) {
            continue;
        }
        // Fuzzy match: Levenshtein distance <= 2
        let best = valid_slugs
            .iter()
            .map(|s| (s, levenshtein(&l.suggested_primitive_slug, s)))
            .min_by_key(|(_, d)| *d);

        if let Some((matched, dist)) = best {
            if dist <= 2 {
                l.suggested_primitive_slug = matched.clone();
            } else {
                l.suggested_primitive_slug = "general".to_string();
            }
        } else {
            l.suggested_primitive_slug = "general".to_string();
        }
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (m, n) = (a.len(), b.len());
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 0..=m {
        dp[i][0] = i;
    }
    for j in 0..=n {
        dp[0][j] = j;
    }
    for i in 1..=m {
        for j in 1..=n {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }
    dp[m][n]
}

// ── Stage 2: Batched Distill + Dedup + Conflict Detection ────────────────────

async fn distill_and_store(
    db: &PgClient,
    api_key: &str,
    model: &str,
    session_id: Uuid,
    learnings: &[LearningCandidate],
    scope_ctx: &ScopeContext,
) -> anyhow::Result<()> {
    // Group by canonicalized slug
    let mut groups: HashMap<String, Vec<&LearningCandidate>> = HashMap::new();
    for l in learnings {
        groups
            .entry(l.suggested_primitive_slug.clone())
            .or_default()
            .push(l);
    }

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    for (slug, candidates) in &groups {
        // Load existing non-retired overlays for this primitive
        let existing_overlays = load_existing_overlays(db, slug).await;

        // Build the batched classification prompt
        let mut prompt = String::from("EXISTING OVERLAYS:\n");
        if existing_overlays.is_empty() {
            prompt.push_str("(none)\n");
        }
        for (i, (id, content)) in existing_overlays.iter().enumerate() {
            prompt.push_str(&format!("  [{}] id={}: {}\n", i, id, content));
        }

        prompt.push_str("\nNEW CANDIDATES:\n");
        for (i, c) in candidates.iter().enumerate() {
            prompt.push_str(&format!(
                "  [{}] text: {} | scope: {} | confidence: {}\n",
                i, c.learning_text, c.suggested_scope, c.confidence
            ));
        }

        prompt.push_str("\nClassify each candidate.");

        let system = "You are classifying new learning candidates against existing overlays \
            for the same skill/agent. You receive ALL candidates for one primitive plus \
            ALL existing overlays in a single batch.\n\n\
            For each candidate, determine:\n\
            - \"novel\" — genuinely new, not covered by any existing overlay\n\
            - \"duplicate\" — semantically equivalent to an existing overlay (cite which)\n\
            - \"refinement\" — adds meaningful nuance to an existing overlay (cite which)\n\
            - \"contradiction\" — directly conflicts with an existing overlay (cite which)\n\n\
            Also check candidates against each other for overlap or contradiction.\n\n\
            Output JSON:\n\
            {\n\
              \"classifications\": [\n\
                {\n\
                  \"candidate_index\": 0,\n\
                  \"verdict\": \"novel|duplicate|refinement|contradiction\",\n\
                  \"existing_overlay_id\": \"uuid or null\",\n\
                  \"reason\": \"brief explanation\"\n\
                }\n\
              ]\n\
            }";

        let response = client
            .messages(system, &[user_message(prompt)], &[], 2048, Some(model))
            .await?;

        let text = response.text();
        let cleaned = text
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        let parsed: Value =
            serde_json::from_str(cleaned).unwrap_or(json!({"classifications": []}));
        let classifications = parsed
            .get("classifications")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        for cls in &classifications {
            let idx = cls.get("candidate_index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if idx >= candidates.len() {
                continue;
            }
            let candidate = &candidates[idx];
            let verdict = cls
                .get("verdict")
                .and_then(Value::as_str)
                .unwrap_or("novel");
            let existing_overlay_id = cls
                .get("existing_overlay_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<Uuid>().ok());

            match verdict {
                "novel" | "refinement" => {
                    write_overlay_from_learning(db, session_id, candidate, slug, scope_ctx).await;
                }
                "duplicate" => {
                    if let Some(oid) = existing_overlay_id {
                        let _ = db
                            .execute_with(
                                "UPDATE overlays SET reinforcement_count = reinforcement_count + 1, \
                                 reinforced_at = NOW() WHERE id = $1",
                                pg_args!(oid),
                            )
                            .await;
                    }
                    update_learning_status(db, session_id, &candidate.learning_text, "duplicate")
                        .await;
                }
                "contradiction" => {
                    let _ = db
                        .execute_with(
                            "UPDATE chat_learnings SET status = 'conflict', \
                             conflicting_overlay_id = $3 \
                             WHERE session_id = $1 AND learning_text = $2 AND status = 'pending'",
                            pg_args!(
                                session_id,
                                candidate.learning_text.clone(),
                                existing_overlay_id
                            ),
                        )
                        .await;
                }
                _ => {}
            }
        }
    }

    Ok(())
}

async fn load_existing_overlays(db: &PgClient, slug: &str) -> Vec<(Uuid, String)> {
    let skill_id = lookup_skill_id(db, slug).await;
    let rows = if let Some(sid) = skill_id {
        db.execute_with(
            "SELECT id, content FROM overlays \
             WHERE primitive_type = 'skill' AND primitive_id = $1 \
               AND retired_at IS NULL \
             ORDER BY created_at DESC LIMIT 50",
            pg_args!(sid),
        )
        .await
        .unwrap_or_default()
    } else if slug == "general" {
        db.execute_unparameterized(
            "SELECT id, content FROM overlays \
             WHERE scope = 'base' AND retired_at IS NULL \
             ORDER BY created_at DESC LIMIT 50",
        )
        .await
        .unwrap_or_default()
    } else {
        vec![]
    };

    rows.iter()
        .filter_map(|r| {
            let id = r.get("id")?.as_str()?.parse::<Uuid>().ok()?;
            let content = r.get("content")?.as_str()?.to_string();
            Some((id, content))
        })
        .collect()
}

async fn write_overlay_from_learning(
    db: &PgClient,
    session_id: Uuid,
    candidate: &LearningCandidate,
    slug: &str,
    scope_ctx: &ScopeContext,
) {
    let skill_id = match lookup_skill_id(db, slug).await {
        Some(id) => id,
        None => {
            warn!(slug, "cannot write overlay: skill not found");
            return;
        }
    };

    let scope = &candidate.suggested_scope;
    let scope_id = match scope.as_str() {
        "project" => scope_ctx.project_id,
        "client" => scope_ctx.client_id,
        "expert" => scope_ctx.expert_id,
        _ => None,
    };

    let overlay_id = Uuid::new_v4();
    let meta = json!({
        "session_id": session_id.to_string(),
        "confidence": candidate.confidence,
        "evidence": candidate.evidence,
    });

    match db
        .execute_with(
            "INSERT INTO overlays \
             (id, primitive_type, primitive_id, scope, scope_id, content, source, metadata) \
             VALUES ($1, 'skill', $2, $3, $4, $5, 'transcript', $6)",
            pg_args!(
                overlay_id,
                skill_id,
                scope.clone(),
                scope_id,
                candidate.learning_text.clone(),
                meta
            ),
        )
        .await
    {
        Ok(_) => {
            info!(overlay = %overlay_id, slug, scope, "wrote transcript overlay");
            // Link the chat_learning to the new overlay
            let _ = db
                .execute_with(
                    "UPDATE chat_learnings SET status = 'distilled', overlay_id = $3 \
                     WHERE session_id = $1 AND learning_text = $2 AND status = 'pending'",
                    pg_args!(session_id, candidate.learning_text.clone(), overlay_id),
                )
                .await;
        }
        Err(e) => {
            warn!(slug, error = %e, "failed to write overlay");
        }
    }
}

async fn update_learning_status(db: &PgClient, session_id: Uuid, text: &str, status: &str) {
    let _ = db
        .execute_with(
            "UPDATE chat_learnings SET status = $3 \
             WHERE session_id = $1 AND learning_text = $2 AND status = 'pending'",
            pg_args!(session_id, text.to_string(), status.to_string()),
        )
        .await;
}

async fn lookup_skill_id(db: &PgClient, slug: &str) -> Option<Uuid> {
    let rows = db
        .execute_with(
            "SELECT id FROM skills WHERE slug = $1",
            pg_args!(slug.to_string()),
        )
        .await
        .ok()?;
    rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .and_then(|s| s.parse::<Uuid>().ok())
}

// ── Stage 3: Narrative Synthesis ─────────────────────────────────────────────

fn collect_affected_scopes(
    learnings: &[LearningCandidate],
    scope_ctx: &ScopeContext,
) -> Vec<(String, Option<Uuid>)> {
    let mut scopes: HashSet<(String, Option<Uuid>)> = HashSet::new();
    for l in learnings {
        let scope_id = match l.suggested_scope.as_str() {
            "project" => scope_ctx.project_id,
            "client" => scope_ctx.client_id,
            "expert" => scope_ctx.expert_id,
            _ => None,
        };
        scopes.insert((l.suggested_scope.clone(), scope_id));
    }
    scopes.into_iter().collect()
}

pub async fn maybe_regenerate_narrative(
    db: &PgClient,
    api_key: &str,
    model: &str,
    scope: &str,
    scope_id: Option<Uuid>,
    regenerated: &mut HashSet<(String, Option<Uuid>)>,
) {
    let key = (scope.to_string(), scope_id);
    if regenerated.contains(&key) {
        return;
    }

    let threshold: i64 = env::var("NARRATIVE_THRESHOLD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15);

    // Count non-retired overlays for this scope
    let count_sql = if let Some(sid) = scope_id {
        format!(
            "SELECT COUNT(*) as cnt FROM overlays \
             WHERE scope = '{}' AND scope_id = '{}' AND retired_at IS NULL",
            scope, sid
        )
    } else {
        format!(
            "SELECT COUNT(*) as cnt FROM overlays \
             WHERE scope = '{}' AND scope_id IS NULL AND retired_at IS NULL",
            scope
        )
    };
    let count = db
        .execute_unparameterized(&count_sql)
        .await
        .ok()
        .and_then(|rows| rows.first().and_then(|r| r.get("cnt").and_then(Value::as_i64)))
        .unwrap_or(0);

    if count < threshold {
        return;
    }

    // Check if existing narrative is still current
    let narrative_sql = if let Some(sid) = scope_id {
        format!(
            "SELECT generated_at FROM scope_narratives \
             WHERE scope = '{}' AND scope_id = '{}'",
            scope, sid
        )
    } else {
        format!(
            "SELECT generated_at FROM scope_narratives \
             WHERE scope = '{}' AND scope_id IS NULL",
            scope
        )
    };
    let latest_overlay_sql = if let Some(sid) = scope_id {
        format!(
            "SELECT MAX(created_at) as latest FROM overlays \
             WHERE scope = '{}' AND scope_id = '{}' AND retired_at IS NULL",
            scope, sid
        )
    } else {
        format!(
            "SELECT MAX(created_at) as latest FROM overlays \
             WHERE scope = '{}' AND scope_id IS NULL AND retired_at IS NULL",
            scope
        )
    };

    let existing_gen = db
        .execute_unparameterized(&narrative_sql)
        .await
        .ok()
        .and_then(|rows| rows.first().and_then(|r| r.get("generated_at")?.as_str().map(String::from)));
    let latest_overlay = db
        .execute_unparameterized(&latest_overlay_sql)
        .await
        .ok()
        .and_then(|rows| rows.first().and_then(|r| r.get("latest")?.as_str().map(String::from)));

    if let (Some(gen), Some(latest)) = (&existing_gen, &latest_overlay) {
        if gen >= latest {
            regenerated.insert(key);
            return;
        }
    }

    // Load all overlays for synthesis
    let overlays_sql = if let Some(sid) = scope_id {
        format!(
            "SELECT content FROM overlays \
             WHERE scope = '{}' AND scope_id = '{}' AND retired_at IS NULL \
             ORDER BY created_at ASC",
            scope, sid
        )
    } else {
        format!(
            "SELECT content FROM overlays \
             WHERE scope = '{}' AND scope_id IS NULL AND retired_at IS NULL \
             ORDER BY created_at ASC",
            scope
        )
    };
    let overlay_rows = match db.execute_unparameterized(&overlays_sql).await {
        Ok(rows) => rows,
        Err(_) => {
            regenerated.insert(key);
            return;
        }
    };

    let overlay_texts: Vec<String> = overlay_rows
        .iter()
        .filter_map(|r| r.get("content").and_then(Value::as_str).map(String::from))
        .collect();

    if overlay_texts.is_empty() {
        regenerated.insert(key);
        return;
    }

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());
    let rules_text = overlay_texts
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{}. {}", i + 1, t))
        .collect::<Vec<_>>()
        .join("\n");

    let system = "You distill a collection of specific rules and lessons into a holistic \
        narrative about a user/expert/project/client. The narrative should capture \
        emergent patterns, working style, recurring preferences, and personality traits \
        that are invisible when reading individual rules in isolation.\n\n\
        This is a CROSS-CUTTING portrait — synthesize across ALL skills and domains, \
        not just one. Be dense and specific — every sentence should carry information. \
        Do not list the individual rules; synthesize them into a coherent portrait. \
        Target 3-5 sentences.\n\n\
        Output TWO variants:\n\
        1. \"agent_narrative\" — third person, for injection into agent prompts.\n\
        2. \"user_narrative\" — second person, for display when the user views their profile.\n\n\
        Output JSON:\n{\n  \"agent_narrative\": \"...\",\n  \"user_narrative\": \"...\"\n}";

    let prompt = format!(
        "Synthesize these {} rules/lessons for scope '{}' into a holistic narrative:\n\n{}",
        overlay_texts.len(),
        scope,
        rules_text
    );

    match client
        .messages(system, &[user_message(prompt)], &[], 1024, Some(model))
        .await
    {
        Ok(response) => {
            let text = response.text();
            let cleaned = text
                .trim()
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim();
            let parsed: Value = serde_json::from_str(cleaned).unwrap_or_default();
            let agent_narrative = parsed
                .get("agent_narrative")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let user_narrative = parsed
                .get("user_narrative")
                .and_then(Value::as_str)
                .map(String::from);

            if !agent_narrative.is_empty() {
                let upsert_sql = "INSERT INTO scope_narratives \
                    (scope, scope_id, narrative_text, narrative_text_user, \
                     source_overlay_count, generated_at) \
                    VALUES ($1, $2, $3, $4, $5, NOW()) \
                    ON CONFLICT (scope, COALESCE(scope_id::text, '')) \
                    DO UPDATE SET narrative_text = $3, narrative_text_user = $4, \
                                  source_overlay_count = $5, generated_at = NOW()";

                let _ = db
                    .execute_with(
                        upsert_sql,
                        pg_args!(
                            scope.to_string(),
                            scope_id,
                            agent_narrative,
                            user_narrative.unwrap_or_default(),
                            overlay_texts.len() as i32
                        ),
                    )
                    .await;
                info!(scope, overlay_count = overlay_texts.len(), "regenerated narrative");
            }
        }
        Err(e) => {
            warn!(scope, error = %e, "narrative synthesis failed");
        }
    }

    regenerated.insert(key);
}
