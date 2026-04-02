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
    /// Integration slug this tool requires (e.g. "notion", "hubspot").
    /// Skipped when serializing to the Anthropic API.
    #[serde(skip_serializing)]
    pub required_credential: Option<String>,
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

    /// Extract all thinking (chain-of-thought) blocks from the response.
    pub fn thinking(&self) -> Vec<String> {
        self.content
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("thinking"))
            .filter_map(|b| b.get("thinking").and_then(Value::as_str).map(String::from))
            .collect()
    }

    /// Total number of thinking tokens used (from usage.thinking_tokens if present).
    pub fn thinking_tokens(&self) -> Option<u64> {
        self.usage.as_ref()?.get("thinking_tokens")?.as_u64()
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

    pub fn cache_creation_input_tokens(&self) -> Option<u64> {
        self.usage.as_ref()?.get("cache_creation_input_tokens")?.as_u64()
    }

    pub fn cache_read_input_tokens(&self) -> Option<u64> {
        self.usage.as_ref()?.get("cache_read_input_tokens")?.as_u64()
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
        self.messages_inner(system, messages, tools, max_tokens, model_override, None)
            .await
    }

    /// Like `messages` but with extended thinking enabled.
    /// `thinking_budget` controls how many tokens the model may use for
    /// chain-of-thought reasoning. The total `max_tokens` sent to the API is
    /// `thinking_budget + output_tokens` so the model has room for both.
    pub async fn messages_with_thinking(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[ToolDef],
        output_tokens: u32,
        model_override: Option<&str>,
        thinking_budget: u32,
    ) -> anyhow::Result<MessagesResponse> {
        self.messages_inner(
            system,
            messages,
            tools,
            output_tokens,
            model_override,
            Some(thinking_budget),
        )
        .await
    }

    async fn messages_inner(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[ToolDef],
        max_tokens: u32,
        model_override: Option<&str>,
        thinking_budget: Option<u32>,
    ) -> anyhow::Result<MessagesResponse> {
        let model = model_override.unwrap_or(&self.model);

        // Use structured system block with cache_control breakpoint so the
        // (often large) system prompt is cached across multi-turn tool loops.
        let system_block = json!([{
            "type": "text",
            "text": system,
            "cache_control": {"type": "ephemeral"}
        }]);

        let actual_max_tokens = if let Some(budget) = thinking_budget {
            budget + max_tokens
        } else {
            max_tokens
        };

        let mut body = json!({
            "model": model,
            "max_tokens": actual_max_tokens,
            "system": system_block,
            "messages": messages,
        });

        // Enable extended thinking when a budget is provided.
        if let Some(budget) = thinking_budget {
            body["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": budget
            });
        }

        if !tools.is_empty() {
            // Serialize tools and mark the last one with cache_control so the
            // full tool-definition block is also cached.
            let mut tools_json: Vec<Value> = tools
                .iter()
                .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.input_schema}))
                .collect();
            if let Some(last) = tools_json.last_mut() {
                last["cache_control"] = json!({"type": "ephemeral"});
            }
            body["tools"] = Value::Array(tools_json);
        }

        let resp = self
            .http
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("anthropic-beta", "prompt-caching-2024-07-31")
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

/// Build a user message with an image (for vision models).
/// Combines a base64 JPEG screenshot with text in a single message.
pub fn user_message_with_image(text: impl Into<String>, image_b64: &str, media_type: &str) -> Value {
    json!({
        "role": "user",
        "content": [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": image_b64,
                }
            },
            {
                "type": "text",
                "text": text.into(),
            }
        ]
    })
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
