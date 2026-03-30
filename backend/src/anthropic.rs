/// Native Anthropic Messages API client.
///
/// Copied from dataAggregate with minor type updates.
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

// ── Tool definitions ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

// ── Response ──────────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
pub struct MessagesResponse {
    pub content: Vec<Value>,
    pub stop_reason: Option<String>,
    pub usage: Option<Value>,
}

impl MessagesResponse {
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn tool_uses(&self) -> Vec<(&str, &str, &Value)> {
        self.content
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
            .filter_map(|b| {
                let id = b.get("id").and_then(Value::as_str)?;
                let name = b.get("name").and_then(Value::as_str)?;
                let input = b.get("input")?;
                Some((id, name, input))
            })
            .collect()
    }

    pub fn input_tokens(&self) -> Option<u64> {
        self.usage.as_ref()?.get("input_tokens")?.as_u64()
    }

    pub fn output_tokens(&self) -> Option<u64> {
        self.usage.as_ref()?.get("output_tokens")?.as_u64()
    }

    pub fn is_end_turn(&self) -> bool {
        matches!(self.stop_reason.as_deref(), Some("end_turn") | None)
    }

    pub fn is_tool_use(&self) -> bool {
        self.stop_reason.as_deref() == Some("tool_use")
    }
}

// ── Client ────────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AnthropicClient {
    http: Client,
    api_key: String,
    pub model: String,
}

impl AnthropicClient {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            api_key: api_key.into(),
            model: model.into(),
        }
    }

    pub async fn messages(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[ToolDef],
        max_tokens: u32,
        model_override: Option<&str>,
    ) -> anyhow::Result<MessagesResponse> {
        let model = model_override.unwrap_or(&self.model);

        let mut body = json!({
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools);
        }

        let resp = self
            .http
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if !status.is_success() {
            anyhow::bail!("Anthropic API error {status}: {}", &text[..text.len().min(500)]);
        }

        let parsed: MessagesResponse = serde_json::from_str(&text).map_err(|e| {
            anyhow::anyhow!(
                "Anthropic parse error: {e}. Body: {}",
                &text[..text.len().min(500)]
            )
        })?;

        Ok(parsed)
    }
}

// ── Message builders ──────────────────────────────────────────────────────────

pub fn user_message(text: impl Into<String>) -> Value {
    json!({"role": "user", "content": text.into()})
}

pub fn assistant_message_from_response(content: &[Value]) -> Value {
    json!({"role": "assistant", "content": content})
}

pub fn tool_results_message(results: &[(String, String)]) -> Value {
    let blocks: Vec<Value> = results
        .iter()
        .map(|(tool_use_id, content)| {
            json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content
            })
        })
        .collect();
    json!({"role": "user", "content": blocks})
}
