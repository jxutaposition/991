use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tracing::{debug, error, info, warn};
use url::Url;
use uuid::Uuid;

use crate::pg::PgClient;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: String, // user UUID
    pub email: String,
    pub name: String,
    pub exp: usize,
    pub iat: usize,
}

#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    pub user_id: Uuid,
    pub email: String,
    pub name: String,
}

pub async fn google_sign_in(
    db: &PgClient,
    jwt_secret: &str,
    id_token: &str,
) -> anyhow::Result<(String, AuthenticatedUser)> {
    // Verify Google token via tokeninfo endpoint (id_token must be query-encoded; raw concat breaks some tokens).
    let http = reqwest::Client::new();
    let tokeninfo_url = Url::parse_with_params(
        "https://oauth2.googleapis.com/tokeninfo",
        &[("id_token", id_token)],
    )
    .map_err(|e| anyhow::anyhow!("tokeninfo url: {e}"))?;
    let http_resp = http.get(tokeninfo_url).send().await?;
    let tokeninfo_status = http_resp.status();
    let res = http_resp.json::<serde_json::Value>().await?;
    if !tokeninfo_status.is_success() || res.get("error").is_some() {
        let err_type = res
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("tokeninfo_error");
        let err_desc = res
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        warn!(
            status = %tokeninfo_status,
            error = %err_type,
            "google_sign_in: tokeninfo rejected id_token"
        );
        anyhow::bail!(
            "Google tokeninfo rejected the id_token (HTTP {}): {}{}",
            tokeninfo_status.as_u16(),
            err_type,
            if err_desc.is_empty() {
                String::new()
            } else {
                format!(" — {err_desc}")
            }
        );
    }

    let email = res
        .get("email")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("No email in Google token (tokeninfo response had no email)"))?;
    let name = res.get("name").and_then(|v| v.as_str()).unwrap_or(email);
    let avatar = res
        .get("picture")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let google_id = res
        .get("sub")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("No sub in Google token"))?;

    // Upsert user
    let rows = db.execute_with(
        "INSERT INTO users (email, name, avatar_url, google_id) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (google_id) DO UPDATE SET \
         name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = NOW() \
         RETURNING id",
        crate::pg_args!(email.to_string(), name.to_string(), avatar.to_string(), google_id.to_string()),
    ).await?;
    let user_id: Uuid = rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow::anyhow!("Failed to get user id"))?;

    let now = chrono::Utc::now().timestamp() as usize;
    let claims = JwtClaims {
        sub: user_id.to_string(),
        email: email.to_string(),
        name: name.to_string(),
        iat: now,
        exp: now + 7 * 24 * 3600, // 7 days
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )?;

    // Store session
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let expires_at = chrono::Utc::now() + chrono::Duration::days(7);
    db.execute_with(
        "INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        crate::pg_args!(user_id, token_hash, expires_at),
    ).await?;

    info!(email = %email, user_id = %user_id, "Google sign-in successful");

    Ok((
        token,
        AuthenticatedUser {
            user_id,
            email: email.to_string(),
            name: name.to_string(),
        },
    ))
}

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let jwt_secret = match state.settings.jwt_secret.as_deref() {
        Some(s) => s,
        None => {
            tracing::error!("JWT_SECRET not configured — rejecting request");
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
    };

    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_owned());

    // Fall back to ?token= query param for SSE / EventSource (which can't set headers).
    let token_value = auth_header.or_else(|| {
        request
            .uri()
            .query()
            .and_then(|q| {
                q.split('&')
                    .find_map(|pair| pair.strip_prefix("token="))
            })
            .map(|s| s.to_owned())
    });

    match token_value.as_deref() {
        Some(token) => {
            let claims = decode::<JwtClaims>(
                token,
                &DecodingKey::from_secret(jwt_secret.as_bytes()),
                &Validation::default(),
            )
            .map_err(|_| {
                warn!("auth rejected — invalid JWT");
                StatusCode::UNAUTHORIZED
            })?;

            // Verify session exists and hasn't been revoked
            let token_hash = hex::encode(sha2::Sha256::digest(token.as_bytes()));
            let session_rows = state.db.execute_with(
                "SELECT 1 FROM user_sessions WHERE token_hash = $1 AND expires_at > NOW()",
                crate::pg_args!(token_hash),
            )
            .await
            .map_err(|e| {
                error!(error = %e, "user_sessions lookup failed");
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
            if session_rows.is_empty() {
                warn!("auth rejected — session expired or revoked");
                return Err(StatusCode::UNAUTHORIZED);
            }

            let user = AuthenticatedUser {
                user_id: claims
                    .claims
                    .sub
                    .parse()
                    .map_err(|_| StatusCode::UNAUTHORIZED)?,
                email: claims.claims.email,
                name: claims.claims.name,
            };

            request.extensions_mut().insert(user);
            Ok(next.run(request).await)
        }
        None => {
            debug!(
                path = %request.uri(),
                method = %request.method(),
                "auth rejected — no Bearer token in request"
            );
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

pub async fn check_client_role(
    db: &PgClient,
    user_id: Uuid,
    client_id: Uuid,
    required_role: &str,
) -> anyhow::Result<bool> {
    let rows = db.execute_with(
        "SELECT role FROM user_client_roles WHERE user_id = $1 AND client_id = $2",
        crate::pg_args!(user_id, client_id),
    ).await?;
    let user_role = rows
        .first()
        .and_then(|r| r.get("role"))
        .and_then(|v| v.as_str())
        .unwrap_or("none");

    let level = |r: &str| match r {
        "admin" => 3,
        "member" => 2,
        "viewer" => 1,
        _ => 0,
    };
    Ok(level(user_role) >= level(required_role))
}

/// Resolve a workspace (`clients` row) the user may access.
/// With `client_slug`, returns that workspace when the user has any role on it.
/// Without a slug, returns the user's oldest membership (by client `created_at`).
pub async fn resolve_client_id_for_user(
    db: &PgClient,
    user_id: Uuid,
    client_slug: Option<&str>,
) -> Result<Uuid, StatusCode> {
    if let Some(slug) = client_slug.map(str::trim).filter(|s| !s.is_empty()) {
        let rows = db
            .execute_with(
                "SELECT c.id FROM clients c \
                 INNER JOIN user_client_roles ucr ON ucr.client_id = c.id \
                 WHERE ucr.user_id = $1 AND c.slug = $2 AND c.deleted_at IS NULL",
                crate::pg_args!(user_id, slug.to_string()),
            )
            .await
            .map_err(|e| {
                error!(error = %e, "resolve_client_id_for_user slug lookup failed");
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
        return rows
            .first()
            .and_then(|r| r.get("id"))
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .ok_or(StatusCode::NOT_FOUND);
    }

    let rows = db
        .execute_with(
            "SELECT c.id FROM clients c \
             INNER JOIN user_client_roles ucr ON ucr.client_id = c.id \
             WHERE ucr.user_id = $1 AND c.deleted_at IS NULL \
             ORDER BY c.created_at ASC LIMIT 1",
            crate::pg_args!(user_id),
        )
        .await
        .map_err(|e| {
            error!(error = %e, "resolve_client_id_for_user default workspace failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    rows.first()
        .and_then(|r| r.get("id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or(StatusCode::BAD_REQUEST)
}

/// Ensures the user may access this execution session (viewer+ on the session's client).
/// Returns `NOT_FOUND` when the session is missing, has no `client_id`, or the user lacks access.
pub async fn assert_session_client_access(
    db: &PgClient,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<(), StatusCode> {
    let rows = db
        .execute_with(
            "SELECT client_id FROM execution_sessions WHERE id = $1",
            crate::pg_args!(session_id),
        )
        .await
        .map_err(|e| {
            error!(error = %e, "assert_session_client_access session lookup failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let client_id: Option<Uuid> = rows
        .first()
        .and_then(|r| r.get("client_id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let client_id = client_id.ok_or(StatusCode::NOT_FOUND)?;

    let ok = check_client_role(db, user_id, client_id, "viewer")
        .await
        .map_err(|e| {
            error!(error = %e, "assert_session_client_access role check failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    if ok {
        Ok(())
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

/// Ensures the user may access the execution session that owns this node.
pub async fn assert_node_client_access(
    db: &PgClient,
    user_id: Uuid,
    node_id: Uuid,
) -> Result<(), StatusCode> {
    let rows = db
        .execute_with(
            "SELECT es.client_id FROM execution_nodes en \
             INNER JOIN execution_sessions es ON es.id = en.session_id \
             WHERE en.id = $1",
            crate::pg_args!(node_id),
        )
        .await
        .map_err(|e| {
            error!(error = %e, "assert_node_client_access lookup failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let client_id: Option<Uuid> = rows
        .first()
        .and_then(|r| r.get("client_id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let client_id = client_id.ok_or(StatusCode::NOT_FOUND)?;

    let ok = check_client_role(db, user_id, client_id, "viewer")
        .await
        .map_err(|e| {
            error!(error = %e, "assert_node_client_access role check failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    if ok {
        Ok(())
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

/// Like [`assert_session_client_access`], but only allows the session if it belongs to the
/// given workspace slug (user must be a member of that workspace). Used when the UI passes
/// `?client_slug=` so users who belong to multiple workspaces cannot open another workspace's
/// session while a different workspace is selected.
pub async fn assert_session_in_workspace(
    db: &PgClient,
    user_id: Uuid,
    session_id: Uuid,
    workspace_slug: &str,
) -> Result<(), StatusCode> {
    let expected_cid = resolve_client_id_for_user(db, user_id, Some(workspace_slug.trim()))
        .await?;
    let rows = db
        .execute_with(
            "SELECT client_id FROM execution_sessions WHERE id = $1",
            crate::pg_args!(session_id),
        )
        .await
        .map_err(|e| {
            error!(error = %e, "assert_session_in_workspace lookup failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let session_cid: Option<Uuid> = rows
        .first()
        .and_then(|r| r.get("client_id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());
    match session_cid {
        Some(cid) if cid == expected_cid => Ok(()),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

/// Workspace-scoped access for a node (via its session's `client_id`).
pub async fn assert_node_in_workspace(
    db: &PgClient,
    user_id: Uuid,
    node_id: Uuid,
    workspace_slug: &str,
) -> Result<(), StatusCode> {
    let expected_cid = resolve_client_id_for_user(db, user_id, Some(workspace_slug.trim()))
        .await?;
    let rows = db
        .execute_with(
            "SELECT es.client_id FROM execution_nodes en \
             INNER JOIN execution_sessions es ON es.id = en.session_id \
             WHERE en.id = $1",
            crate::pg_args!(node_id),
        )
        .await
        .map_err(|e| {
            error!(error = %e, "assert_node_in_workspace lookup failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let session_cid: Option<Uuid> = rows
        .first()
        .and_then(|r| r.get("client_id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());
    match session_cid {
        Some(cid) if cid == expected_cid => Ok(()),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

/// Ensures the user has at least `member` on the given project (via its client).
pub async fn assert_project_client_access(
    db: &PgClient,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<Uuid, StatusCode> {
    let rows = db
        .execute_with(
            "SELECT client_id FROM projects WHERE id = $1",
            crate::pg_args!(project_id),
        )
        .await
        .map_err(|e| {
            error!(error = %e, "assert_project_client_access lookup failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let client_id: Option<Uuid> = rows
        .first()
        .and_then(|r| r.get("client_id"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let client_id = client_id.ok_or(StatusCode::NOT_FOUND)?;

    let ok = check_client_role(db, user_id, client_id, "member")
        .await
        .map_err(|e| {
            error!(error = %e, "assert_project_client_access role check failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    if ok {
        Ok(client_id)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
