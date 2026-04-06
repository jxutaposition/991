/// Native Anthropic Messages API client.
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Instant;

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

        let max_retries = 3u32;
        let mut last_error = String::new();
        let started_at = Instant::now();

        for attempt in 0..=max_retries {
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

            if status.is_success() {
                let parsed: MessagesResponse = serde_json::from_str(&text).map_err(|e| {
                    anyhow::anyhow!(
                        "Anthropic parse error: {e}. Body: {}",
                        &text[..text.len().min(500)]
                    )
                })?;
                let duration_ms = started_at.elapsed().as_millis() as u64;
                tracing::debug!(
                    model = %model,
                    duration_ms = duration_ms,
                    input_tokens = ?parsed.input_tokens(),
                    output_tokens = ?parsed.output_tokens(),
                    cache_creation = ?parsed.cache_creation_input_tokens(),
                    cache_read = ?parsed.cache_read_input_tokens(),
                    thinking_tokens = ?parsed.thinking_tokens(),
                    stop_reason = ?parsed.stop_reason,
                    "LLM response received"
                );
                return Ok(parsed);
            }

            let code = status.as_u16();
            let is_retryable = code == 429 || code == 529 || code >= 500;

            if !is_retryable || attempt == max_retries {
                anyhow::bail!("Anthropic API error {status}: {}", &text[..text.len().min(500)]);
            }

            // Parse retry-after header if present, otherwise use exponential backoff
            let delay_secs = if code == 429 {
                // Rate limited — back off more aggressively
                2u64.pow(attempt + 1)
            } else {
                // Server error / overloaded — shorter backoff
                2u64.pow(attempt)
            };

            last_error = format!("{status}: {}", &text[..text.len().min(200)]);
            tracing::warn!(
                attempt = attempt + 1,
                max_retries,
                delay_secs,
                error = %last_error,
                "Anthropic API transient error, retrying"
            );

            tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        }

        anyhow::bail!("Anthropic API failed after retries: {}", last_error)
    }
}

// ── Streaming types ──────────────────────────────────────────────────────────

/// An individual SSE event from the Anthropic streaming API.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    MessageStart { usage: Value },
    ContentBlockStart { index: usize, block_type: ContentBlockType },
    ContentBlockDelta { index: usize, delta: DeltaPayload },
    ContentBlockStop { index: usize },
    MessageDelta { stop_reason: Option<String>, usage: Option<Value> },
    MessageStop,
}

#[derive(Debug, Clone)]
pub enum ContentBlockType {
    Text,
    Thinking,
    ToolUse { id: String, name: String },
}

#[derive(Debug, Clone)]
pub enum DeltaPayload {
    TextDelta(String),
    ThinkingDelta(String),
    SignatureDelta(String),
    InputJsonDelta(String),
}

fn parse_sse_event(event_type: &str, data: &Value) -> Option<StreamEvent> {
    match event_type {
        "message_start" => {
            let usage = data.get("message")?.get("usage")?.clone();
            Some(StreamEvent::MessageStart { usage })
        }
        "content_block_start" => {
            let index = data.get("index")?.as_u64()? as usize;
            let block = data.get("content_block")?;
            let btype = block.get("type")?.as_str()?;
            let block_type = match btype {
                "text" => ContentBlockType::Text,
                "thinking" => ContentBlockType::Thinking,
                "tool_use" => ContentBlockType::ToolUse {
                    id: block.get("id")?.as_str()?.to_string(),
                    name: block.get("name")?.as_str()?.to_string(),
                },
                _ => return None,
            };
            Some(StreamEvent::ContentBlockStart { index, block_type })
        }
        "content_block_delta" => {
            let index = data.get("index")?.as_u64()? as usize;
            let delta_obj = data.get("delta")?;
            let delta_type = delta_obj.get("type")?.as_str()?;
            let delta = match delta_type {
                "text_delta" => DeltaPayload::TextDelta(
                    delta_obj.get("text")?.as_str()?.to_string(),
                ),
                "thinking_delta" => DeltaPayload::ThinkingDelta(
                    delta_obj.get("thinking")?.as_str()?.to_string(),
                ),
                "signature_delta" => DeltaPayload::SignatureDelta(
                    delta_obj.get("signature")?.as_str()?.to_string(),
                ),
                "input_json_delta" => DeltaPayload::InputJsonDelta(
                    delta_obj.get("partial_json")?.as_str()?.to_string(),
                ),
                _ => return None,
            };
            Some(StreamEvent::ContentBlockDelta { index, delta })
        }
        "content_block_stop" => {
            let index = data.get("index")?.as_u64()? as usize;
            Some(StreamEvent::ContentBlockStop { index })
        }
        "message_delta" => {
            let stop_reason = data
                .get("delta")
                .and_then(|d| d.get("stop_reason"))
                .and_then(Value::as_str)
                .map(String::from);
            let usage = data.get("usage").cloned();
            Some(StreamEvent::MessageDelta { stop_reason, usage })
        }
        "message_stop" => Some(StreamEvent::MessageStop),
        _ => None,
    }
}

/// Incrementally builds a MessagesResponse from streaming events.
struct ResponseAccumulator {
    content_blocks: Vec<Value>,
    block_types: Vec<String>,
    text_accumulators: Vec<String>,
    json_accumulators: Vec<String>,
    signature_accumulators: Vec<String>,
    stop_reason: Option<String>,
    usage: Option<Value>,
}

impl ResponseAccumulator {
    fn new() -> Self {
        Self {
            content_blocks: Vec::new(),
            block_types: Vec::new(),
            text_accumulators: Vec::new(),
            json_accumulators: Vec::new(),
            signature_accumulators: Vec::new(),
            stop_reason: None,
            usage: None,
        }
    }

    fn ensure_index(&mut self, index: usize) {
        while self.content_blocks.len() <= index {
            self.content_blocks.push(Value::Null);
            self.block_types.push(String::new());
            self.text_accumulators.push(String::new());
            self.json_accumulators.push(String::new());
            self.signature_accumulators.push(String::new());
        }
    }

    fn on_event(&mut self, event: &StreamEvent) {
        match event {
            StreamEvent::MessageStart { usage } => {
                self.usage = Some(usage.clone());
            }
            StreamEvent::ContentBlockStart { index, block_type } => {
                self.ensure_index(*index);
                match block_type {
                    ContentBlockType::Text => {
                        self.block_types[*index] = "text".to_string();
                        self.content_blocks[*index] = json!({"type": "text", "text": ""});
                    }
                    ContentBlockType::Thinking => {
                        self.block_types[*index] = "thinking".to_string();
                        self.content_blocks[*index] = json!({"type": "thinking", "thinking": ""});
                    }
                    ContentBlockType::ToolUse { id, name } => {
                        self.block_types[*index] = "tool_use".to_string();
                        self.content_blocks[*index] = json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": {}
                        });
                    }
                }
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                self.ensure_index(*index);
                match delta {
                    DeltaPayload::TextDelta(t) | DeltaPayload::ThinkingDelta(t) => {
                        self.text_accumulators[*index].push_str(t);
                    }
                    DeltaPayload::SignatureDelta(s) => {
                        self.signature_accumulators[*index].push_str(s);
                    }
                    DeltaPayload::InputJsonDelta(j) => {
                        self.json_accumulators[*index].push_str(j);
                    }
                }
            }
            StreamEvent::ContentBlockStop { index } => {
                if *index < self.content_blocks.len() {
                    let btype = &self.block_types[*index];
                    match btype.as_str() {
                        "text" => {
                            self.content_blocks[*index]["text"] =
                                Value::String(self.text_accumulators[*index].clone());
                        }
                        "thinking" => {
                            self.content_blocks[*index]["thinking"] =
                                Value::String(self.text_accumulators[*index].clone());
                            let sig = &self.signature_accumulators[*index];
                            if !sig.is_empty() {
                                self.content_blocks[*index]["signature"] =
                                    Value::String(sig.clone());
                            }
                        }
                        "tool_use" => {
                            let json_str = &self.json_accumulators[*index];
                            let parsed = serde_json::from_str::<Value>(json_str).unwrap_or_else(|e| {
                                tracing::warn!("Failed to parse tool_use input JSON: {e}");
                                Value::Null
                            });
                            self.content_blocks[*index]["input"] = parsed;
                        }
                        _ => {}
                    }
                }
            }
            StreamEvent::MessageDelta { stop_reason, usage } => {
                if stop_reason.is_some() {
                    self.stop_reason = stop_reason.clone();
                }
                if let Some(u) = usage {
                    if let Some(existing) = &mut self.usage {
                        if let (Some(obj), Some(new_obj)) = (existing.as_object_mut(), u.as_object()) {
                            for (k, v) in new_obj {
                                obj.insert(k.clone(), v.clone());
                            }
                        }
                    } else {
                        self.usage = Some(u.clone());
                    }
                }
            }
            StreamEvent::MessageStop => {}
        }
    }

    fn finalize(self) -> MessagesResponse {
        MessagesResponse {
            content: self.content_blocks,
            stop_reason: self.stop_reason,
            usage: self.usage,
        }
    }
}

// ── Streaming client method ──────────────────────────────────────────────────

impl AnthropicClient {
    /// Stream a messages call. Returns a channel of delta events for real-time
    /// forwarding and a JoinHandle that resolves to the complete response.
    pub fn messages_stream(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[ToolDef],
        max_tokens: u32,
        model_override: Option<&str>,
        thinking_budget: Option<u32>,
    ) -> (
        tokio::sync::mpsc::Receiver<StreamEvent>,
        tokio::task::JoinHandle<anyhow::Result<MessagesResponse>>,
    ) {
        use futures_util::StreamExt;
        use tokio::sync::mpsc;

        let (tx, rx) = mpsc::channel::<StreamEvent>(256);

        let http = self.http.clone();
        let api_key = self.api_key.clone();
        let model = model_override.unwrap_or(&self.model).to_string();
        let system = system.to_string();
        let messages = messages.to_vec();
        let tools = tools.to_vec();

        let handle = tokio::spawn(async move {
            let system_block = json!([{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"}
            }]);

            let actual_max_tokens = thinking_budget
                .map(|b| b + max_tokens)
                .unwrap_or(max_tokens);

            let mut body = json!({
                "model": model,
                "max_tokens": actual_max_tokens,
                "system": system_block,
                "messages": messages,
                "stream": true,
            });

            if let Some(budget) = thinking_budget {
                body["thinking"] = json!({
                    "type": "enabled",
                    "budget_tokens": budget
                });
            }

            if !tools.is_empty() {
                let mut tools_json: Vec<Value> = tools
                    .iter()
                    .map(|t| json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema
                    }))
                    .collect();
                if let Some(last) = tools_json.last_mut() {
                    last["cache_control"] = json!({"type": "ephemeral"});
                }
                body["tools"] = Value::Array(tools_json);
            }

            let resp = http
                .post(ANTHROPIC_API_URL)
                .header("x-api-key", &api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("anthropic-beta", "prompt-caching-2024-07-31")
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await?;

            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().await?;
                anyhow::bail!("Anthropic API error {status}: {}", &text[..text.len().min(500)]);
            }

            let mut byte_stream = resp.bytes_stream();
            let mut accumulator = ResponseAccumulator::new();
            let mut line_buffer = String::new();
            let mut current_event_type = String::new();

            while let Some(chunk_result) = byte_stream.next().await {
                let chunk = chunk_result?;
                let text = String::from_utf8_lossy(&chunk);
                line_buffer.push_str(&text);

                while let Some(newline_pos) = line_buffer.find('\n') {
                    let line = line_buffer[..newline_pos].trim_end().to_string();
                    line_buffer = line_buffer[newline_pos + 1..].to_string();

                    if line.is_empty() {
                        current_event_type.clear();
                        continue;
                    }

                    if let Some(event_type) = line.strip_prefix("event: ") {
                        current_event_type = event_type.to_string();
                    } else if let Some(data_str) = line.strip_prefix("data: ") {
                        if let Ok(data) = serde_json::from_str::<Value>(data_str) {
                            if let Some(event) = parse_sse_event(&current_event_type, &data) {
                                accumulator.on_event(&event);
                                let _ = tx.send(event).await;
                            }
                        }
                    }
                }
            }

            Ok(accumulator.finalize())
        });

        (rx, handle)
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
