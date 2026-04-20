//! Hard-delete a workspace (`clients` row) while retaining knowledge corpus for a user.
use uuid::Uuid;

use crate::pg::PgClient;
use crate::pg_args;

/// Move all knowledge rows off this tenant onto `library_user_id`, then delete the client row
/// and dependent rows (projects, roles, etc.). Runs in one transaction.
pub async fn hard_delete_workspace_retain_knowledge(
    db: &PgClient,
    client_id: Uuid,
    knowledge_owner_user_id: Uuid,
) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;

    tx.execute_with(
        "UPDATE knowledge_documents SET tenant_id = NULL, library_user_id = $2 \
         WHERE tenant_id = $1",
        pg_args!(client_id, knowledge_owner_user_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE knowledge_chunks SET tenant_id = NULL, library_user_id = $2 \
         WHERE tenant_id = $1",
        pg_args!(client_id, knowledge_owner_user_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE execution_sessions SET engagement_id = NULL \
         WHERE engagement_id IN (SELECT id FROM engagements WHERE client_id = $1)",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE workflows SET engagement_id = NULL \
         WHERE engagement_id IN (SELECT id FROM engagements WHERE client_id = $1)",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE observation_sessions SET engagement_id = NULL \
         WHERE engagement_id IN (SELECT id FROM engagements WHERE client_id = $1)",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE projects SET engagement_id = NULL WHERE client_id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "DELETE FROM engagements WHERE client_id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE workflows SET client_id = NULL WHERE client_id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE execution_sessions SET project_id = NULL \
         WHERE project_id IN (SELECT id FROM projects WHERE client_id = $1)",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE execution_nodes SET client_id = NULL WHERE client_id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "UPDATE execution_sessions SET client_id = NULL WHERE client_id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "DELETE FROM overlays WHERE scope = 'client' AND scope_id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "DELETE FROM scope_narratives WHERE scope = 'client' AND scope_id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.execute_with(
        "DELETE FROM clients WHERE id = $1",
        pg_args!(client_id),
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

/// If a soft-deleted workspace still holds this slug for this user, hard-delete it so the slug can be reused.
pub async fn purge_soft_deleted_workspace_slug_for_user(
    db: &PgClient,
    slug: &str,
    user_id: Uuid,
) -> anyhow::Result<()> {
    let rows = db
        .execute_with(
            "SELECT c.id FROM clients c \
             JOIN user_client_roles ucr ON ucr.client_id = c.id \
             WHERE c.slug = $1 AND ucr.user_id = $2 AND c.deleted_at IS NOT NULL",
            pg_args!(slug.to_string(), user_id),
        )
        .await?;

    let Some(cid) = rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok())
    else {
        return Ok(());
    };

    hard_delete_workspace_retain_knowledge(db, cid, user_id).await
}
