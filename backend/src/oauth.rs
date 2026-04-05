use serde_json::{json, Value};
use tracing::info;
use uuid::Uuid;

use crate::config::Settings;
use crate::credentials;
use crate::pg::PgClient;

#[derive(Debug, Clone)]
pub struct OAuthProviderConfig {
    pub name: String,
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    pub client_secret: String,
    pub scopes: Vec<String>,
}

pub fn get_provider_config(settings: &Settings, provider: &str) -> Option<OAuthProviderConfig> {
    match provider {
        "notion" => Some(OAuthProviderConfig {
            name: "notion".into(),
            authorize_url: "https://api.notion.com/v1/oauth/authorize".into(),
            token_url: "https://api.notion.com/v1/oauth/token".into(),
            client_id: settings.notion_oauth_client_id.clone()?,
            client_secret: settings.notion_oauth_client_secret.clone()?,
            scopes: vec![],
        }),
        "hubspot" => Some(OAuthProviderConfig {
            name: "hubspot".into(),
            authorize_url: "https://app.hubspot.com/oauth/authorize".into(),
            token_url: "https://api.hubapi.com/oauth/v1/token".into(),
            client_id: settings.hubspot_oauth_client_id.clone()?,
            client_secret: settings.hubspot_oauth_client_secret.clone()?,
            scopes: vec![
                "crm.objects.contacts.read".into(),
                "crm.objects.contacts.write".into(),
                "crm.objects.deals.read".into(),
                "crm.schemas.deals.read".into(),
                "crm.objects.companies.read".into(),
            ],
        }),
        "google" => Some(OAuthProviderConfig {
            name: "google".into(),
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            client_id: settings.google_oauth_client_id.clone()?,
            client_secret: settings.google_oauth_client_secret.clone()?,
            scopes: vec![
                "https://www.googleapis.com/auth/adwords.readonly".into(),
                "https://www.googleapis.com/auth/spreadsheets".into(),
            ],
        }),
        "meta" => Some(OAuthProviderConfig {
            name: "meta".into(),
            authorize_url: "https://www.facebook.com/v19.0/dialog/oauth".into(),
            token_url: "https://graph.facebook.com/v19.0/oauth/access_token".into(),
            client_id: settings.meta_oauth_client_id.clone()?,
            client_secret: settings.meta_oauth_client_secret.clone()?,
            scopes: vec![
                "ads_management".into(),
                "ads_read".into(),
            ],
        }),
        "slack" => Some(OAuthProviderConfig {
            name: "slack".into(),
            authorize_url: "https://slack.com/oauth/v2/authorize".into(),
            token_url: "https://slack.com/api/oauth.v2.access".into(),
            client_id: settings.slack_oauth_client_id.clone()?,
            client_secret: settings.slack_oauth_client_secret.clone()?,
            scopes: vec![
                "chat:write".into(),
                "channels:read".into(),
                "users:read".into(),
            ],
        }),
        "apollo" => Some(OAuthProviderConfig {
            name: "apollo".into(),
            authorize_url: "https://app.apollo.io/oauth/authorize".into(),
            token_url: "https://app.apollo.io/oauth/token".into(),
            client_id: settings.apollo_oauth_client_id.clone()?,
            client_secret: settings.apollo_oauth_client_secret.clone()?,
            scopes: vec![],
        }),
        _ => None,
    }
}

pub async fn start_authorize(
    db: &PgClient,
    settings: &Settings,
    provider: &str,
    client_id: Uuid,
    frontend_redirect: &str,
) -> anyhow::Result<String> {
    let config = get_provider_config(settings, provider)
        .ok_or_else(|| anyhow::anyhow!("Unknown or unconfigured OAuth provider: {provider}"))?;

    // Validate frontend_redirect is a safe relative path (prevent open redirect)
    if !frontend_redirect.starts_with('/') || frontend_redirect.starts_with("//") {
        anyhow::bail!("frontend_redirect must be a relative path starting with /");
    }

    let state_token = Uuid::new_v4().to_string();
    let base = settings
        .oauth_redirect_base_url
        .as_deref()
        .unwrap_or("http://localhost:3001");
    let redirect_uri = format!("{base}/api/oauth/{provider}/callback");

    db.execute_with(
        "INSERT INTO oauth_state (provider, client_id, state_token, redirect_uri) \
         VALUES ($1, $2, $3, $4)",
        crate::pg_args!(provider.to_string(), client_id, state_token.clone(), frontend_redirect.to_string()),
    ).await?;

    let scopes = config.scopes.join(" ");
    let authorize_url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&state={}&scope={}",
        config.authorize_url,
        config.client_id,
        urlencoding_encode(&redirect_uri),
        state_token,
        urlencoding_encode(&scopes),
    );

    info!(provider, %client_id, "OAuth authorize URL generated");
    Ok(authorize_url)
}

pub async fn handle_callback(
    db: &PgClient,
    settings: &Settings,
    provider: &str,
    code: &str,
    state_token: &str,
) -> anyhow::Result<String> {
    // Atomically consume the state token with DELETE...RETURNING to prevent replay attacks
    let rows = db.execute_with(
        "DELETE FROM oauth_state \
         WHERE state_token = $1 AND provider = $2 AND expires_at > NOW() \
         RETURNING client_id, redirect_uri",
        crate::pg_args!(state_token.to_string(), provider.to_string()),
    ).await?;
    let row = rows
        .first()
        .ok_or_else(|| anyhow::anyhow!("Invalid or expired OAuth state"))?;

    let client_id: Uuid = row
        .get("client_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow::anyhow!("Invalid client_id in state"))?;
    let raw_redirect = row
        .get("redirect_uri")
        .and_then(Value::as_str)
        .unwrap_or("/");
    // Validate redirect is a relative path to prevent open redirect attacks
    let frontend_redirect = if raw_redirect.starts_with('/') && !raw_redirect.starts_with("//") {
        raw_redirect.to_string()
    } else {
        tracing::warn!(redirect = %raw_redirect, "blocked potentially malicious OAuth redirect");
        "/settings/integrations".to_string()
    };

    let config = get_provider_config(settings, provider)
        .ok_or_else(|| anyhow::anyhow!("Provider not configured: {provider}"))?;

    let base = settings
        .oauth_redirect_base_url
        .as_deref()
        .unwrap_or("http://localhost:3001");
    let redirect_uri = format!("{base}/api/oauth/{provider}/callback");

    // Exchange code for tokens
    let http = reqwest::Client::new();
    let token_res = http
        .post(&config.token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("redirect_uri", &redirect_uri),
        ])
        .send()
        .await?
        .json::<Value>()
        .await?;

    let access_token = token_res
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("No access_token in response: {token_res}"))?;
    let refresh_token = token_res
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("");

    let cred_value = json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
    });

    let master_key = settings
        .credential_master_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("CREDENTIAL_MASTER_KEY not set"))?;

    let encrypted = credentials::encrypt(master_key, &cred_value.to_string())?;

    let expires_in = token_res
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    let meta = json!({
        "scopes": config.scopes,
        "expires_in": expires_in,
        "provider": provider,
        "refreshed_at": chrono::Utc::now().to_rfc3339(),
    });

    credentials::upsert_credential(db, client_id, provider, "oauth2", &encrypted, Some(&meta))
        .await?;

    info!(provider, %client_id, "OAuth credentials stored");
    Ok(format!(
        "{frontend_redirect}?integration={provider}&status=connected"
    ))
}

/// Refresh an OAuth2 token if it has expired.
/// Returns `Ok(Some(updated_credential))` if refreshed, `Ok(None)` if still valid.
pub async fn refresh_if_needed(
    db: &PgClient,
    settings: &Settings,
    client_id: Uuid,
    integration_slug: &str,
    credential: &credentials::DecryptedCredential,
) -> anyhow::Result<Option<credentials::DecryptedCredential>> {
    if credential.credential_type != "oauth2" {
        return Ok(None);
    }

    // Check if token is expired based on metadata
    let expires_in = credential.metadata.get("expires_in").and_then(Value::as_i64).unwrap_or(0);
    let refreshed_at = credential.metadata.get("refreshed_at")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    if expires_in == 0 {
        // No expiry info — assume still valid
        return Ok(None);
    }

    let is_expired = if let Some(refreshed) = refreshed_at {
        let expires_at = refreshed + chrono::Duration::seconds(expires_in);
        // Refresh 5 minutes before actual expiry for safety margin
        chrono::Utc::now() > (expires_at - chrono::Duration::seconds(300))
    } else {
        // No refreshed_at recorded — try refreshing to be safe
        true
    };

    if !is_expired {
        return Ok(None);
    }

    // Parse refresh_token from credential value
    let cred_value: Value = serde_json::from_str(&credential.value).unwrap_or(json!({}));
    let refresh_token = cred_value.get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("");
    if refresh_token.is_empty() {
        // No refresh token available — can't refresh
        tracing::warn!(integration_slug, "OAuth token expired but no refresh_token available");
        return Ok(None);
    }

    let config = get_provider_config(settings, integration_slug)
        .ok_or_else(|| anyhow::anyhow!("Cannot refresh: no OAuth config for {integration_slug}"))?;

    info!(integration_slug, %client_id, "Refreshing expired OAuth token");

    let http = reqwest::Client::new();
    let token_res = http
        .post(&config.token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
        ])
        .send()
        .await?
        .json::<Value>()
        .await?;

    let new_access_token = token_res
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Token refresh failed for {integration_slug}: {token_res}"))?;
    // Some providers return a new refresh token, others keep the same one
    let new_refresh_token = token_res
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or(refresh_token);

    let new_cred_value = json!({
        "access_token": new_access_token,
        "refresh_token": new_refresh_token,
    });

    let master_key = settings
        .credential_master_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("CREDENTIAL_MASTER_KEY not set"))?;
    let encrypted = credentials::encrypt(master_key, &new_cred_value.to_string())?;

    let new_expires_in = token_res
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(expires_in);
    let new_meta = json!({
        "scopes": credential.metadata.get("scopes").cloned().unwrap_or(json!([])),
        "expires_in": new_expires_in,
        "provider": integration_slug,
        "refreshed_at": chrono::Utc::now().to_rfc3339(),
    });

    credentials::upsert_credential(db, client_id, integration_slug, "oauth2", &encrypted, Some(&new_meta))
        .await?;

    info!(integration_slug, %client_id, "OAuth token refreshed successfully");

    Ok(Some(credentials::DecryptedCredential {
        credential_type: "oauth2".to_string(),
        value: new_cred_value.to_string(),
        metadata: new_meta,
    }))
}

fn urlencoding_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
