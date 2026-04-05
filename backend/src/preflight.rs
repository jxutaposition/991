use std::collections::HashMap;
use std::time::Instant;

use futures_util::future::join_all;
use serde_json::Value;

use crate::credentials::DecryptedCredential;

/// Classifies **why** a probe failed so the UI can show differentiated guidance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeStatus {
    /// 2xx — credential is valid and the service is reachable.
    Verified,
    /// 401 / 403 — the API key or token was rejected.
    AuthFailed,
    /// 404 — the probe endpoint itself does not exist (API changed or wrong URL).
    EndpointNotFound,
    /// 429 — key is accepted, just rate-limited. Treated as verified.
    RateLimited,
    /// 5xx — the remote service is experiencing errors.
    ServerError,
    /// Other 4xx we didn't specifically handle (e.g. 400, 422).
    ClientError,
    /// DNS failure, connection refused, timeout, TLS error, etc.
    NetworkError,
    /// Required config (base_url, project_url) is missing so we can't even attempt a probe.
    ConfigMissing,
}

impl ProbeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::AuthFailed => "auth_failed",
            Self::EndpointNotFound => "endpoint_not_found",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::ClientError => "client_error",
            Self::NetworkError => "network_error",
            Self::ConfigMissing => "config_missing",
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Verified | Self::RateLimited)
    }
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub integration_slug: String,
    pub status: ProbeStatus,
    pub http_status: Option<u16>,
    pub error: String,
    pub hint: String,
    pub latency_ms: u64,
}

impl ProbeResult {
    pub fn success(&self) -> bool {
        self.status.is_ok()
    }
}

fn config_missing_result(slug: &str, error: String, hint: String) -> ProbeResult {
    ProbeResult {
        integration_slug: slug.to_string(),
        status: ProbeStatus::ConfigMissing,
        http_status: None,
        error,
        hint,
        latency_ms: 0,
    }
}

fn classify_response(slug: &str, resp: &reqwest::Response, latency_ms: u64) -> ProbeResult {
    let status = resp.status();
    let code = status.as_u16();
    let display = integration_display(slug);
    let slug_str = slug.to_string();

    if status.is_success() {
        return ProbeResult {
            integration_slug: slug_str,
            status: ProbeStatus::Verified,
            http_status: Some(code),
            error: String::new(),
            hint: String::new(),
            latency_ms,
        };
    }

    match code {
        401 | 403 => ProbeResult {
            integration_slug: slug_str,
            status: ProbeStatus::AuthFailed,
            http_status: Some(code),
            error: format!("{display} rejected the API key (HTTP {code})"),
            hint: format!("Check that the {display} API key in Settings > Integrations is correct and has not expired."),
            latency_ms,
        },
        404 => ProbeResult {
            integration_slug: slug_str,
            status: ProbeStatus::EndpointNotFound,
            http_status: Some(code),
            error: format!("{display} probe endpoint returned 404"),
            hint: format!("The {display} API endpoint used for verification may have changed. Check API docs or contact support."),
            latency_ms,
        },
        429 => ProbeResult {
            integration_slug: slug_str,
            status: ProbeStatus::RateLimited,
            http_status: Some(code),
            error: String::new(),
            hint: format!("{display} is rate-limiting requests but the key was accepted."),
            latency_ms,
        },
        500..=599 => ProbeResult {
            integration_slug: slug_str,
            status: ProbeStatus::ServerError,
            http_status: Some(code),
            error: format!("{display} returned server error (HTTP {code})"),
            hint: format!("{display} appears to be experiencing issues. Check {display}'s status page or try again later."),
            latency_ms,
        },
        _ => ProbeResult {
            integration_slug: slug_str,
            status: ProbeStatus::ClientError,
            http_status: Some(code),
            error: format!("{display} returned HTTP {code}"),
            hint: format!("Unexpected response from {display}. The request may be malformed or permissions insufficient."),
            latency_ms,
        },
    }
}

fn classify_network_error(slug: &str, e: &reqwest::Error, latency_ms: u64) -> ProbeResult {
    let display = integration_display(slug);
    let (error, hint) = if e.is_timeout() {
        (
            format!("{display} request timed out"),
            format!("{display} did not respond within 10 seconds. The service may be slow or unreachable."),
        )
    } else if e.is_connect() {
        (
            format!("Could not connect to {display}"),
            format!("Connection refused or DNS failure. Verify the {display} URL is correct and the service is running."),
        )
    } else {
        (
            format!("Network error reaching {display}: {e}"),
            format!("Check your network connectivity and that the {display} service URL is correct."),
        )
    };
    ProbeResult {
        integration_slug: slug.to_string(),
        status: ProbeStatus::NetworkError,
        http_status: None,
        error,
        hint,
        latency_ms,
    }
}

/// Extract a Bearer / OAuth access token from a credential value.
fn extract_token(cred: &DecryptedCredential) -> String {
    let value = &cred.value;
    if cred.credential_type == "oauth2" {
        serde_json::from_str::<Value>(value)
            .ok()
            .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| value.clone())
    } else {
        value.clone()
    }
}

/// Probe a single integration using its decrypted credential value.
///
/// `settings` — when provided, global fallback URLs (e.g. N8N_BASE_URL)
/// are used to enrich credentials that lack embedded URL fields.
///
/// Returns `None` only for integration slugs with no known probe logic.
pub async fn probe_one(
    slug: &str,
    cred: &DecryptedCredential,
    settings: Option<&crate::config::Settings>,
) -> Option<ProbeResult> {
    let start = Instant::now();
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Some(ProbeResult {
                integration_slug: slug.to_string(),
                status: ProbeStatus::NetworkError,
                http_status: None,
                error: format!("Failed to build HTTP client: {e}"),
                hint: "Internal error. Try again.".into(),
                latency_ms: start.elapsed().as_millis() as u64,
            });
        }
    };

    let value = &cred.value;

    // ── Per-integration probe definitions ───────────────────────────
    let result: Option<Result<reqwest::Response, reqwest::Error>> = match slug {
        // Tavily: GET /usage — returns 200 with usage JSON, 401 if bad key
        "tavily" => Some(
            http.get("https://api.tavily.com/usage")
                .header("Authorization", format!("Bearer {value}"))
                .send()
                .await,
        ),

        // Apollo: GET /v1/auth/health — official health-check endpoint
        // Supports both api_key (x-api-key header) and oauth2 (Bearer token)
        "apollo" => {
            if cred.credential_type == "oauth2" {
                let token = extract_token(cred);
                Some(
                    http.get("https://api.apollo.io/v1/auth/health")
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Cache-Control", "no-cache")
                        .send()
                        .await,
                )
            } else {
                Some(
                    http.get("https://api.apollo.io/v1/auth/health")
                        .header("x-api-key", value.as_str())
                        .header("Cache-Control", "no-cache")
                        .send()
                        .await,
                )
            }
        }

        // Clay: no probe — the clay_operator has no API access and no required
        // credential. It provides instructions for the user to build in Clay's UI.

        // n8n: GET /api/v1/workflows?limit=1 — requires base URL
        "n8n" => {
            let parsed: Value = serde_json::from_str(value).unwrap_or(serde_json::json!({}));
            let api_key = parsed
                .get("api_key")
                .and_then(Value::as_str)
                .unwrap_or(value);
            let base_url_from_cred = parsed
                .get("base_url")
                .and_then(Value::as_str)
                .unwrap_or("");
            let base_url = if base_url_from_cred.is_empty() {
                settings
                    .and_then(|s| s.n8n_base_url.as_deref())
                    .unwrap_or("")
            } else {
                base_url_from_cred
            };
            if base_url.is_empty() {
                return Some(config_missing_result(
                    slug,
                    "n8n base URL is not configured".into(),
                    "Re-save your n8n credential in Settings > Integrations as JSON: {\"api_key\": \"...\", \"base_url\": \"https://your-n8n.example.com\"}".into(),
                ));
            }
            let url = format!(
                "{}/api/v1/workflows?limit=1",
                base_url.trim_end_matches('/')
            );
            Some(
                http.get(&url)
                    .header("X-N8N-API-KEY", api_key)
                    .send()
                    .await,
            )
        }

        // Tolt: GET /v1/programs — returns program list or 401
        "tolt" => Some(
            http.get("https://api.tolt.com/v1/programs")
                .header("Authorization", format!("Bearer {value}"))
                .send()
                .await,
        ),

        // Supabase: GET /auth/v1/health — official health endpoint
        "supabase" => {
            let parsed: Value = serde_json::from_str(value).unwrap_or(serde_json::json!({}));
            let api_key = parsed
                .get("api_key")
                .and_then(Value::as_str)
                .unwrap_or(value);
            let project_url = parsed
                .get("project_url")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    cred.metadata
                        .get("project_url")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or("");
            if project_url.is_empty() {
                return Some(config_missing_result(
                    slug,
                    "Supabase project URL is not configured".into(),
                    "Re-save your Supabase credential in Settings > Integrations as JSON: {\"api_key\": \"...\", \"project_url\": \"https://xxx.supabase.co\"}".into(),
                ));
            }
            let url = format!("{}/auth/v1/health", project_url.trim_end_matches('/'));
            Some(
                http.get(&url)
                    .header("apikey", api_key)
                    .header("Authorization", format!("Bearer {api_key}"))
                    .send()
                    .await,
            )
        }

        // Notion: GET /v1/users/me — returns current user or 401
        "notion" => {
            let token = extract_token(cred);
            Some(
                http.get("https://api.notion.com/v1/users/me")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Notion-Version", "2022-06-28")
                    .send()
                    .await,
            )
        }

        // HubSpot: GET /crm/v3/objects/contacts?limit=1 — lightweight read
        "hubspot" => {
            let token = extract_token(cred);
            Some(
                http.get("https://api.hubapi.com/crm/v3/objects/contacts?limit=1")
                    .header("Authorization", format!("Bearer {token}"))
                    .send()
                    .await,
            )
        }

        // Google: GET /oauth2/v1/tokeninfo — validates access token
        "google" => {
            let token = extract_token(cred);
            Some(
                http.get(&format!(
                    "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token={token}"
                ))
                .send()
                .await,
            )
        }

        // Meta/Facebook: GET /me — returns user info or 401
        "meta" => {
            let token = extract_token(cred);
            Some(
                http.get(&format!(
                    "https://graph.facebook.com/v19.0/me?access_token={token}"
                ))
                .send()
                .await,
            )
        }

        // Slack: POST /api/auth.test — validates token
        "slack" => {
            let token = extract_token(cred);
            Some(
                http.post("https://slack.com/api/auth.test")
                    .header("Authorization", format!("Bearer {token}"))
                    .send()
                    .await,
            )
        }

        _ => None,
    };

    let result = result?;
    let latency_ms = start.elapsed().as_millis() as u64;

    Some(match result {
        Ok(r) => classify_response(slug, &r, latency_ms),
        Err(e) => classify_network_error(slug, &e, latency_ms),
    })
}

/// Run live probes for a set of integrations using decrypted credential values.
/// Probes run concurrently. Integrations with no known probe are skipped.
pub async fn probe_integrations(
    needed: &HashMap<String, DecryptedCredential>,
    settings: Option<&crate::config::Settings>,
) -> Vec<ProbeResult> {
    let futures: Vec<_> = needed
        .iter()
        .map(|(slug, cred)| async move { probe_one(slug, cred, settings).await })
        .collect();

    join_all(futures).await.into_iter().flatten().collect()
}

/// Collect the set of required integration slugs for an agent (combining
/// `agent.required_integrations` and per-tool `required_credential`).
pub fn required_slugs_for_agent(
    required_integrations: &[String],
    tools: &[String],
) -> Vec<String> {
    let mut all: Vec<String> = required_integrations.to_vec();
    for tool_name in tools {
        if let Some(cred) = crate::actions::action_credential(tool_name) {
            if !all.contains(&cred) {
                all.push(cred);
            }
        }
    }
    all
}

/// Filter a full credential map to only the required integrations, respecting
/// global fallback env vars for tavily and n8n.
pub fn filter_required_credentials<'a>(
    all_credentials: &'a HashMap<String, DecryptedCredential>,
    required_slugs: &[String],
    settings: &crate::config::Settings,
) -> HashMap<String, DecryptedCredential> {
    let mut filtered = HashMap::new();
    for slug in required_slugs {
        if let Some(cred) = all_credentials.get(slug.as_str()) {
            filtered.insert(slug.clone(), cred.clone());
        } else if slug == "tavily" {
            if let Some(ref key) = settings.tavily_api_key {
                filtered.insert(
                    slug.clone(),
                    DecryptedCredential {
                        credential_type: "api_key".into(),
                        value: key.clone(),
                        metadata: serde_json::json!({}),
                    },
                );
            }
        } else if slug == "n8n" {
            if let (Some(ref key), Some(ref url)) =
                (&settings.n8n_api_key, &settings.n8n_base_url)
            {
                filtered.insert(
                    slug.clone(),
                    DecryptedCredential {
                        credential_type: "api_key".into(),
                        value: serde_json::json!({"api_key": key, "base_url": url}).to_string(),
                        metadata: serde_json::json!({}),
                    },
                );
            }
        }
    }
    filtered
}

/// Human-readable display name for an integration slug.
fn integration_display(slug: &str) -> &str {
    match slug {
        "tavily" => "Tavily",
        "apollo" => "Apollo",
        "n8n" => "n8n",
        "tolt" => "Tolt",
        "supabase" => "Supabase",
        "notion" => "Notion",
        "hubspot" => "HubSpot",
        "google" => "Google",
        "meta" => "Meta",
        "slack" => "Slack",
        _ => slug,
    }
}
