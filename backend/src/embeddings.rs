/// Query-time embedding client for the knowledge RAG pipeline.
///
/// Uses OpenAI's text-embedding-3-small (1536 dimensions) to embed search
/// queries at retrieval time. Batch embedding during ingestion is handled
/// by the Python worker.
use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;
use tracing::warn;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

/// Embed a single text string using the OpenAI embedding API.
/// Returns a 1536-dimensional vector.
pub async fn embed_text(api_key: &str, text: &str) -> anyhow::Result<Vec<f32>> {
    let resp = http_client()
        .post("https://api.openai.com/v1/embeddings")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&json!({
            "model": "text-embedding-3-small",
            "input": text,
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        warn!(%status, %body, "OpenAI embedding API error");
        anyhow::bail!("OpenAI embedding API returned {status}: {body}");
    }

    let parsed: EmbeddingResponse = resp.json().await?;
    parsed
        .data
        .into_iter()
        .next()
        .map(|d| d.embedding)
        .ok_or_else(|| anyhow::anyhow!("empty embedding response"))
}
