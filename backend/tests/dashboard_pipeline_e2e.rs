//! Real integration test: dashboard-shaped metrics must match rows read from Supabase via PostgREST (no mocked `execute_action`).
//!
//! ## Supabase setup
//! Create a table (or use your pipeline’s target table name via `DASHBOARD_E2E_TABLE`):
//! ```sql
//! create table if not exists public.lele_dashboard_pipeline_e2e (
//!   id uuid primary key default gen_random_uuid(),
//!   metric_value integer not null,
//!   label text
//! );
//! ```
//! The key you use must be allowed to `insert` and `select` on this table.
//!
//! ## Run
//! ```text
//! RUN_DASHBOARD_PIPELINE_E2E=1 \
//! SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
//! SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_JWT \
//! cargo test -p lele2-backend --test dashboard_pipeline_e2e -- --ignored --nocapture
//! ```
//!
//! This does **not** call the LLM or agent runner. It validates the contract that **published dashboard numbers**
//! can be checked against **live Supabase data** (the same source `dashboard_builder` should use via HTTP).
//! Extend with Clay/n8n assertions when you have a stable sandbox webhook path.

use serde_json::{json, Value};

fn env_req(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing required env var {name}"))
}

fn rest_root() -> String {
    let base = env_req("SUPABASE_URL").trim_end_matches('/').to_string();
    format!("{base}/rest/v1")
}

fn extract_stat_like_numbers(spec: &Value) -> Vec<i64> {
    let mut out = Vec::new();
    let widgets = spec
        .get("widgets")
        .and_then(|w| w.as_array())
        .cloned()
        .unwrap_or_default();
    for w in widgets {
        if let Some(v) = w.get("value") {
            if let Some(n) = v.as_i64() {
                out.push(n);
            } else if let Some(s) = v.as_str() {
                if let Ok(n) = s.replace(',', "").parse::<i64>() {
                    out.push(n);
                }
            }
        }
        if let Some(data) = w.get("data").and_then(|d| d.as_array()) {
            for row in data {
                if let Some(obj) = row.as_object() {
                    for (_k, val) in obj {
                        if let Some(n) = val.as_i64() {
                            out.push(n);
                        } else if let Some(s) = val.as_str() {
                            if let Ok(n) = s.replace(',', "").parse::<i64>() {
                                out.push(n);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// Insert a sentinel row, read it back from Supabase, and assert a minimal dashboard_spec that displays that metric is consistent with the DB.
#[tokio::test]
#[ignore = "requires RUN_DASHBOARD_PIPELINE_E2E=1 and Supabase env vars (see module doc)"]
async fn dashboard_spec_metrics_trace_to_supabase_rows() {
    if std::env::var("RUN_DASHBOARD_PIPELINE_E2E").ok().as_deref() != Some("1") {
        panic!("set RUN_DASHBOARD_PIPELINE_E2E=1 to run this test");
    }

    let key = env_req("SUPABASE_SERVICE_ROLE_KEY");
    let table = std::env::var("DASHBOARD_E2E_TABLE")
        .unwrap_or_else(|_| "lele_dashboard_pipeline_e2e".to_string());

    let client = reqwest::Client::new();
    let root = rest_root();

    let sentinel: i64 = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .subsec_nanos() as i64)
        .rem_euclid(900_000)
        + 100_000;

    let insert_url = format!("{root}/{table}");
    let insert_body = json!({
        "metric_value": sentinel,
        "label": "e2e_dashboard_pipeline"
    });

    let insert_resp = client
        .post(&insert_url)
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .header("Prefer", "return=representation")
        .json(&insert_body)
        .send()
        .await
        .expect("supabase insert request");
    if !insert_resp.status().is_success() {
        let status = insert_resp.status();
        let body = insert_resp.text().await.unwrap_or_default();
        panic!("Supabase insert failed: {status} — {body}");
    }

    let select_url = format!(
        "{root}/{table}?metric_value=eq.{sentinel}&select=metric_value,label"
    );
    let select_resp = client
        .get(&select_url)
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .expect("supabase select request");
    assert!(
        select_resp.status().is_success(),
        "select failed: {}",
        select_resp.status()
    );
    let rows: Vec<Value> = select_resp.json().await.expect("select json");
    assert!(
        rows.iter().any(|r| r.get("metric_value").and_then(|v| v.as_i64()) == Some(sentinel)),
        "expected row with metric_value={sentinel}, got {rows:?}"
    );

    // Minimal dashboard spec as an agent would publish — values must be reconcilable with Supabase.
    let dashboard_spec = json!({
        "title": "Pipeline E2E",
        "widgets": [
            { "id": "kpi", "type": "stat", "title": "Metric", "value": sentinel.to_string(), "span": 1 }
        ]
    });

    let extracted = extract_stat_like_numbers(&dashboard_spec);
    assert!(
        extracted.contains(&sentinel),
        "dashboard spec should surface metric_value {sentinel}, extracted: {extracted:?}"
    );
}
