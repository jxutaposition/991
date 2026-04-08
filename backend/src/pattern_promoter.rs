/// Pattern Promoter — background analysis for overlay scope promotion.
///
/// Runs periodically (or on-demand). Scans project-scoped overlays for patterns
/// worth promoting to broader scopes (client, expert, base).
///
/// Uses LLM-based similarity comparison since we don't rely on vector embeddings.
use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::anthropic::{user_message, AnthropicClient};
use crate::pg::PgClient;

const PROMOTION_INTERVAL: Duration = Duration::from_secs(86400); // 24 hours
const MIN_EVIDENCE_FOR_CLIENT: usize = 3;
const MIN_EVIDENCE_FOR_EXPERT: usize = 2;
const MIN_EVIDENCE_FOR_BASE: usize = 3;

/// Background scheduler for the pattern promoter.
pub fn spawn_scheduler(
    db: PgClient,
    api_key: String,
    model: String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("pattern promoter scheduler started");
        let mut interval = tokio::time::interval(PROMOTION_INTERVAL);
        // Skip the first immediate tick
        interval.tick().await;

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    info!("pattern promoter: starting scheduled scan");
                    match run_promotion_scan(&db, &api_key, &model).await {
                        Ok(count) => info!(promoted = count, "pattern promoter scan complete"),
                        Err(e) => warn!(error = %e, "pattern promoter scan failed"),
                    }
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        info!("pattern promoter shutting down");
                        break;
                    }
                }
            }
        }
    })
}

/// Run a full promotion scan across all project-scoped overlays.
/// Returns the number of overlays promoted.
pub async fn run_promotion_scan(
    db: &PgClient,
    api_key: &str,
    model: &str,
) -> anyhow::Result<usize> {
    // Load all project-scoped overlays grouped by primitive_id
    let sql = r#"
        SELECT o.id, o.primitive_id, o.scope_id, o.content, o.metadata,
               p.client_id, p.expert_id
        FROM overlays o
        LEFT JOIN projects p ON o.scope_id = p.id
        WHERE o.scope = 'project'
          AND o.source = 'feedback'
          AND o.retired_at IS NULL
        ORDER BY o.primitive_id, o.created_at
    "#;

    let rows = db.execute_unparameterized(sql).await?;
    if rows.is_empty() {
        return Ok(0);
    }

    // Group by primitive_id
    let mut groups: HashMap<String, Vec<OverlayRecord>> = HashMap::new();
    for row in &rows {
        let primitive_id = match row.get("primitive_id").and_then(Value::as_str) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let record = OverlayRecord {
            id: row
                .get("id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<Uuid>().ok())
                .unwrap_or_default(),
            content: row
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            client_id: row
                .get("client_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<Uuid>().ok()),
            expert_id: row
                .get("expert_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<Uuid>().ok()),
            project_id: row
                .get("scope_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<Uuid>().ok()),
        };
        groups
            .entry(primitive_id)
            .or_default()
            .push(record);
    }

    let mut total_promoted = 0;

    for (primitive_id, overlays) in &groups {
        if overlays.len() < 2 {
            continue;
        }

        // Find clusters of similar overlays using LLM
        let clusters = cluster_similar_overlays(api_key, model, overlays).await?;

        for cluster in &clusters {
            if cluster.len() < 2 {
                continue;
            }

            let primitive_uuid = match primitive_id.parse::<Uuid>() {
                Ok(u) => u,
                Err(_) => continue,
            };

            // Check for client-level promotion
            let client_groups = group_by_client(cluster);
            for (client_id, client_overlays) in &client_groups {
                if client_overlays.len() >= MIN_EVIDENCE_FOR_CLIENT {
                    // Check no existing client overlay with similar content
                    let already_promoted = check_existing_overlay(
                        db,
                        primitive_uuid,
                        "client",
                        *client_id,
                    )
                    .await;

                    if !already_promoted {
                        let canonical = &client_overlays[0].content;
                        let source_id = client_overlays[0].id;
                        if let Ok(_) = create_promoted_overlay(
                            db,
                            primitive_uuid,
                            "client",
                            *client_id,
                            canonical,
                            source_id,
                        )
                        .await
                        {
                            total_promoted += 1;
                            info!(
                                primitive = %primitive_id,
                                scope = "client",
                                evidence = client_overlays.len(),
                                "promoted overlay to client scope"
                            );
                        }
                    }
                }
            }

            // Check for expert-level promotion
            let expert_groups = group_by_expert(cluster);
            for (expert_id, expert_overlays) in &expert_groups {
                if expert_overlays.len() >= MIN_EVIDENCE_FOR_EXPERT {
                    let already_promoted = check_existing_overlay(
                        db,
                        primitive_uuid,
                        "expert",
                        *expert_id,
                    )
                    .await;

                    if !already_promoted {
                        let canonical = &expert_overlays[0].content;
                        let source_id = expert_overlays[0].id;
                        if let Ok(_) = create_promoted_overlay(
                            db,
                            primitive_uuid,
                            "expert",
                            *expert_id,
                            canonical,
                            source_id,
                        )
                        .await
                        {
                            total_promoted += 1;
                            info!(
                                primitive = %primitive_id,
                                scope = "expert",
                                evidence = expert_overlays.len(),
                                "promoted overlay to expert scope"
                            );
                        }
                    }
                }
            }

            // Check for base-level promotion (needs evidence across multiple experts)
            let unique_experts: Vec<Uuid> = cluster
                .iter()
                .filter_map(|o| o.expert_id)
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            if unique_experts.len() >= MIN_EVIDENCE_FOR_BASE {
                let already_promoted =
                    check_existing_base_overlay(db, primitive_uuid).await;
                if !already_promoted {
                    let canonical = &cluster[0].content;
                    let source_id = cluster[0].id;
                    if let Ok(_) = create_promoted_overlay(
                        db,
                        primitive_uuid,
                        "base",
                        Uuid::nil(),
                        canonical,
                        source_id,
                    )
                    .await
                    {
                        total_promoted += 1;
                        info!(
                            primitive = %primitive_id,
                            scope = "base",
                            evidence = cluster.len(),
                            "promoted overlay to base scope"
                        );
                    }
                }
            }
        }
    }

    Ok(total_promoted)
}

#[derive(Clone)]
#[allow(dead_code)]
struct OverlayRecord {
    id: Uuid,
    content: String,
    client_id: Option<Uuid>,
    expert_id: Option<Uuid>,
    project_id: Option<Uuid>,
}

async fn cluster_similar_overlays(
    api_key: &str,
    model: &str,
    overlays: &[OverlayRecord],
) -> anyhow::Result<Vec<Vec<OverlayRecord>>> {
    if overlays.len() <= 1 {
        return Ok(vec![overlays.to_vec()]);
    }

    // For small sets, use LLM to cluster
    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    let mut items = String::new();
    for (i, o) in overlays.iter().enumerate() {
        items.push_str(&format!("{}. {}\n", i, o.content));
    }

    let system = "You cluster similar lessons/rules. Output JSON only.";
    let prompt = format!(
        "Group these lessons by semantic similarity. Each group should contain lessons \
         that express the same underlying rule or preference.\n\n{items}\n\n\
         Output: {{\"clusters\": [[0, 2, 5], [1, 3], [4]]}} — arrays of indices."
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
                    .filter(|&i| i < overlays.len())
                    .collect()
            })
            .unwrap_or_default();

        let group: Vec<OverlayRecord> = indices
            .iter()
            .map(|&i| overlays[i].clone())
            .collect();
        if !group.is_empty() {
            clusters.push(group);
        }
    }

    Ok(clusters)
}

fn group_by_client(overlays: &[OverlayRecord]) -> HashMap<Uuid, Vec<OverlayRecord>> {
    let mut map: HashMap<Uuid, Vec<OverlayRecord>> = HashMap::new();
    for o in overlays {
        if let Some(cid) = o.client_id {
            map.entry(cid).or_default().push(o.clone());
        }
    }
    map
}

fn group_by_expert(overlays: &[OverlayRecord]) -> HashMap<Uuid, Vec<OverlayRecord>> {
    let mut map: HashMap<Uuid, Vec<OverlayRecord>> = HashMap::new();
    for o in overlays {
        if let Some(eid) = o.expert_id {
            map.entry(eid).or_default().push(o.clone());
        }
    }
    map
}

async fn check_existing_overlay(
    db: &PgClient,
    primitive_id: Uuid,
    scope: &str,
    scope_id: Uuid,
) -> bool {
    db.execute_with(
        "SELECT 1 FROM overlays \
         WHERE primitive_id = $1 AND scope = $2 \
         AND scope_id = $3 AND source = 'promoted' LIMIT 1",
        crate::pg_args!(primitive_id, scope.to_string(), scope_id),
    )
        .await
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
}

async fn check_existing_base_overlay(db: &PgClient, primitive_id: Uuid) -> bool {
    db.execute_with(
        "SELECT 1 FROM overlays \
         WHERE primitive_id = $1 AND scope = 'base' \
         AND source = 'promoted' LIMIT 1",
        crate::pg_args!(primitive_id),
    )
        .await
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
}

async fn create_promoted_overlay(
    db: &PgClient,
    primitive_id: Uuid,
    scope: &str,
    scope_id: Uuid,
    content: &str,
    promoted_from: Uuid,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    let scope_id_opt: Option<Uuid> = if scope == "base" { None } else { Some(scope_id) };

    db.execute_with(
        r#"INSERT INTO overlays
            (id, primitive_type, primitive_id, scope, scope_id, content, source, promoted_from)
           VALUES
            ($1, 'skill', $2, $3, $4, $5, 'promoted', $6)"#,
        crate::pg_args!(id, primitive_id, scope.to_string(), scope_id_opt, content.to_string(), promoted_from),
    ).await?;
    Ok(id)
}
