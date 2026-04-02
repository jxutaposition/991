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
    // Verify Google token via tokeninfo endpoint
    let http = reqwest::Client::new();
    let res = http
        .get(&format!(
            "https://oauth2.googleapis.com/tokeninfo?id_token={id_token}"
        ))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let email = res
        .get("email")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("No email in Google token"))?;
    let name = res.get("name").and_then(|v| v.as_str()).unwrap_or(email);
    let avatar = res
        .get("picture")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let google_id = res
        .get("sub")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("No sub in Google token"))?;

    let email_esc = email.replace('\'', "''");
    let name_esc = name.replace('\'', "''");
    let avatar_esc = avatar.replace('\'', "''");
    let gid_esc = google_id.replace('\'', "''");

    // Upsert user
    let sql = format!(
        "INSERT INTO users (email, name, avatar_url, google_id) \
         VALUES ('{email_esc}', '{name_esc}', '{avatar_esc}', '{gid_esc}') \
         ON CONFLICT (google_id) DO UPDATE SET \
         name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = NOW() \
         RETURNING id"
    );
    let rows = db.execute(&sql).await?;
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
    let sql = format!(
        "INSERT INTO user_sessions (user_id, token_hash, expires_at) \
         VALUES ('{user_id}', '{token_hash}', '{expires_at}')"
    );
    db.execute(&sql).await?;

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
        None => return Ok(next.run(request).await), // No JWT secret = auth disabled
    };

    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));

    match auth_header {
        Some(token) => {
            let claims = decode::<JwtClaims>(
                token,
                &DecodingKey::from_secret(jwt_secret.as_bytes()),
                &Validation::default(),
            )
            .map_err(|_| StatusCode::UNAUTHORIZED)?;

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
        None => Err(StatusCode::UNAUTHORIZED),
    }
}

pub async fn check_client_role(
    db: &PgClient,
    user_id: Uuid,
    client_id: Uuid,
    required_role: &str,
) -> anyhow::Result<bool> {
    let sql = format!(
        "SELECT role FROM user_client_roles WHERE user_id = '{user_id}' AND client_id = '{client_id}'"
    );
    let rows = db.execute(&sql).await?;
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
