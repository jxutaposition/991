/// Postgres client wrapping sqlx::PgPool.
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::Value;
use sqlx::{
    postgres::{PgPoolOptions, PgRow},
    Column, Row, TypeInfo,
};

#[derive(Clone)]
pub struct PgClient {
    pool: sqlx::PgPool,
}

impl PgClient {
    pub async fn new(database_url: &str) -> anyhow::Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(std::time::Duration::from_secs(5))
            .connect(database_url)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to connect to Postgres: {}", e))?;
        Ok(Self { pool })
    }

    pub async fn execute(&self, sql: &str) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| anyhow::anyhow!("SQL error: {}", e))?;
        Ok(rows.iter().map(pg_row_to_json).collect())
    }

    pub async fn execute_with_id(
        &self,
        sql: &str,
    ) -> anyhow::Result<(Vec<Value>, Option<String>)> {
        let rows = self.execute(sql).await?;
        let query_id = uuid::Uuid::new_v4().to_string();
        Ok((rows, Some(query_id)))
    }
}

fn pg_row_to_json(row: &PgRow) -> Value {
    let mut map = serde_json::Map::new();
    for col in row.columns() {
        let col_name = col.name();
        let type_name = col.type_info().name();
        let val = decode_pg_column(row, col_name, type_name);
        map.insert(col_name.to_string(), val);
    }
    Value::Object(map)
}

fn decode_pg_column(row: &PgRow, col_name: &str, type_name: &str) -> Value {
    let tn = type_name.to_ascii_lowercase();
    match tn.as_str() {
        "bool" => row
            .try_get::<Option<bool>, _>(col_name)
            .ok()
            .flatten()
            .map(Value::Bool)
            .unwrap_or(Value::Null),

        "int2" | "int4" => row
            .try_get::<Option<i32>, _>(col_name)
            .ok()
            .flatten()
            .map(|n| serde_json::json!(n))
            .unwrap_or(Value::Null),

        "int8" | "oid" => row
            .try_get::<Option<i64>, _>(col_name)
            .ok()
            .flatten()
            .map(|n| serde_json::json!(n))
            .unwrap_or(Value::Null),

        "float4" => row
            .try_get::<Option<f32>, _>(col_name)
            .ok()
            .flatten()
            .and_then(|f| serde_json::Number::from_f64(f as f64))
            .map(Value::Number)
            .unwrap_or(Value::Null),

        "float8" | "numeric" => row
            .try_get::<Option<f64>, _>(col_name)
            .ok()
            .flatten()
            .and_then(|f| serde_json::Number::from_f64(f))
            .map(Value::Number)
            .unwrap_or(Value::Null),

        "json" | "jsonb" => row
            .try_get::<Option<Value>, _>(col_name)
            .ok()
            .flatten()
            .unwrap_or(Value::Null),

        "timestamptz" => row
            .try_get::<Option<DateTime<Utc>>, _>(col_name)
            .ok()
            .flatten()
            .map(|dt| Value::String(dt.to_rfc3339()))
            .unwrap_or(Value::Null),

        "timestamp" => row
            .try_get::<Option<NaiveDateTime>, _>(col_name)
            .ok()
            .flatten()
            .map(|dt| Value::String(dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()))
            .unwrap_or(Value::Null),

        _ => row
            .try_get::<Option<String>, _>(col_name)
            .ok()
            .flatten()
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}
