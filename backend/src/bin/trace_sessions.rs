//! One-off DB inspection: recent sessions, nodes (orchestrator count), message counts.
//! Usage: `cd backend && cargo run --bin trace_sessions`
//! Loads `DATABASE_URL` from `.env` via dotenvy (same as main server).

use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv_override().ok();
    let url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL not set (add to backend/.env)"))?;

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&url)
        .await?;

    let sessions = sqlx::query_as::<_, SessionRow>(
        r#"SELECT id::text, status,
                  client_id::text AS client_id,
                  project_id::text AS project_id,
                  LEFT(COALESCE(request_text, ''), 120) as request_preview,
                  created_at::text,
                  completed_at::text AS completed_at
           FROM execution_sessions
           ORDER BY created_at DESC
           LIMIT 10"#,
    )
    .fetch_all(&pool)
    .await?;

    println!("=== execution_sessions (last 10) ===");
    if sessions.is_empty() {
        println!("(no rows)");
        return Ok(());
    }
    for s in &sessions {
        println!(
            "id={} status={} client_id={:?} project_id={:?}",
            s.id, s.status, s.client_id, s.project_id
        );
        println!("  request_preview={:?}", s.request_preview);
        println!(
            "  created_at={} completed_at={:?}",
            s.created_at, s.completed_at
        );
    }

    for s in sessions.iter().take(3) {
        let nodes = sqlx::query_as::<_, NodeRow>(
            r#"SELECT id::text, agent_slug, status,
                      parent_uid::text AS parent_uid,
                      (parent_uid IS NULL) AS is_orchestrator_root,
                      LEFT(COALESCE(task_description, ''), 80) as task_preview,
                      created_at::text
               FROM execution_nodes
               WHERE session_id = $1::uuid
               ORDER BY created_at ASC"#,
        )
        .bind(&s.id)
        .fetch_all(&pool)
        .await?;

        let roots: Vec<_> = nodes.iter().filter(|n| n.is_orchestrator_root).collect();
        println!("\n=== execution_nodes session={} (count={}) ===", s.id, nodes.len());
        println!(
            "    orchestrator rows (parent_uid IS NULL): {}",
            roots.len()
        );
        for n in &nodes {
            println!(
                "  id={} slug={} status={} root={} parent_uid={:?}",
                n.id,
                n.agent_slug,
                n.status,
                n.is_orchestrator_root,
                n.parent_uid
            );
            println!("    task_preview={:?}", n.task_preview);
        }

        let msg_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*)::bigint FROM node_messages WHERE session_id = $1::uuid",
        )
        .bind(&s.id)
        .fetch_one(&pool)
        .await?;
        println!("    node_messages total: {}", msg_count.0);
    }

    Ok(())
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: String,
    status: String,
    client_id: Option<String>,
    project_id: Option<String>,
    request_preview: String,
    created_at: String,
    completed_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct NodeRow {
    id: String,
    agent_slug: String,
    status: String,
    parent_uid: Option<String>,
    is_orchestrator_root: bool,
    task_preview: String,
    created_at: String,
}
