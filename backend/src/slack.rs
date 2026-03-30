/// Slack client wrapper around slack-morphism.
///
/// Provides methods for posting messages, streaming updates, and verifying
/// inbound request signatures. The entire Slack integration is opt-in —
/// if SLACK_BOT_TOKEN is not set, this module is never initialized.
use serde_json::{json, Value};
use tracing::{info, warn};

/// Lightweight client wrapping reqwest for Slack Web API calls.
/// We use direct HTTP instead of slack-morphism's higher-level client
/// for simpler integration with our Axum setup.
#[derive(Clone)]
pub struct SlackClient {
    http: reqwest::Client,
    bot_token: String,
    signing_secret: Option<String>,
}

pub struct PostMessageResponse {
    pub ts: String,
    pub channel: String,
}

impl SlackClient {
    pub fn new(
        bot_token: &str,
        _app_token: Option<&str>,
        signing_secret: Option<&str>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            bot_token: bot_token.to_string(),
            signing_secret: signing_secret.map(|s| s.to_string()),
        }
    }

    /// Post a message to a Slack channel, optionally in a thread.
    pub async fn post_message(
        &self,
        channel: &str,
        blocks: &[Value],
        text: &str,
        thread_ts: Option<&str>,
    ) -> anyhow::Result<PostMessageResponse> {
        let mut body = json!({
            "channel": channel,
            "blocks": blocks,
            "text": text,
        });

        if let Some(ts) = thread_ts {
            body["thread_ts"] = json!(ts);
        }

        let resp = self
            .http
            .post("https://slack.com/api/chat.postMessage")
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await?
            .json::<Value>()
            .await?;

        if resp.get("ok").and_then(Value::as_bool) != Some(true) {
            let err = resp.get("error").and_then(Value::as_str).unwrap_or("unknown");
            anyhow::bail!("chat.postMessage failed: {err}");
        }

        Ok(PostMessageResponse {
            ts: resp.get("ts").and_then(Value::as_str).unwrap_or("").to_string(),
            channel: resp.get("channel").and_then(Value::as_str).unwrap_or(channel).to_string(),
        })
    }

    /// Update an existing message (rate limit: once per 3 seconds).
    pub async fn update_message(
        &self,
        channel: &str,
        ts: &str,
        blocks: &[Value],
        text: &str,
    ) -> anyhow::Result<()> {
        let body = json!({
            "channel": channel,
            "ts": ts,
            "blocks": blocks,
            "text": text,
        });

        let resp = self
            .http
            .post("https://slack.com/api/chat.update")
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await?
            .json::<Value>()
            .await?;

        if resp.get("ok").and_then(Value::as_bool) != Some(true) {
            let err = resp.get("error").and_then(Value::as_str).unwrap_or("unknown");
            warn!(error = err, "chat.update failed");
        }

        Ok(())
    }

    /// Set the assistant thread status (loading indicator).
    pub async fn set_status(
        &self,
        channel: &str,
        thread_ts: &str,
        status: &str,
    ) -> anyhow::Result<()> {
        let body = json!({
            "channel_id": channel,
            "thread_ts": thread_ts,
            "status": status,
        });

        let _ = self
            .http
            .post("https://slack.com/api/assistant.threads.setStatus")
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await?;

        Ok(())
    }

    /// Set suggested prompts for the assistant thread.
    pub async fn set_suggested_prompts(
        &self,
        channel: &str,
        thread_ts: &str,
        prompts: &[(&str, &str)], // (title, message)
    ) -> anyhow::Result<()> {
        let prompt_objects: Vec<Value> = prompts
            .iter()
            .map(|(title, message)| json!({"title": title, "message": message}))
            .collect();

        let body = json!({
            "channel_id": channel,
            "thread_ts": thread_ts,
            "prompts": prompt_objects,
        });

        let _ = self
            .http
            .post("https://slack.com/api/assistant.threads.setSuggestedPrompts")
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await?;

        Ok(())
    }

    /// Verify a Slack request signature using HMAC-SHA256.
    pub fn verify_signature(&self, timestamp: &str, body: &[u8], signature: &str) -> bool {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        let secret = match &self.signing_secret {
            Some(s) => s,
            None => return false,
        };

        let base = format!(
            "v0:{}:{}",
            timestamp,
            std::str::from_utf8(body).unwrap_or("")
        );

        let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
            Ok(m) => m,
            Err(_) => return false,
        };
        mac.update(base.as_bytes());
        let expected = format!("v0={}", hex::encode(mac.finalize().into_bytes()));
        expected == signature
    }

    /// Post an ephemeral message visible only to one user.
    pub async fn post_ephemeral(
        &self,
        channel: &str,
        user: &str,
        text: &str,
    ) -> anyhow::Result<()> {
        let body = json!({
            "channel": channel,
            "user": user,
            "text": text,
        });

        let _ = self
            .http
            .post("https://slack.com/api/chat.postEphemeral")
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await?;

        Ok(())
    }

    pub fn enabled(&self) -> bool {
        !self.bot_token.is_empty()
    }
}

/// Log Slack initialization status.
pub fn log_status(settings: &crate::config::Settings) {
    if settings.slack_bot_token.is_some() {
        info!("Slack integration enabled (mode: {})", settings.slack_mode);
    } else {
        info!("Slack integration disabled (SLACK_BOT_TOKEN not set)");
    }
}
