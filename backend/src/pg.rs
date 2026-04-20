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
        let max_conn: u32 = std::env::var("POOL_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(25);
        let pool = PgPoolOptions::new()
            .max_connections(max_conn)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(database_url)
            .await
            .map_err(|e| {
                let msg = e.to_string();
                let supabase_hint = if msg.contains("Tenant or user not found") {
                    "\n\nSupabase: this error usually means the connection string does not match the selected mode. \
On IPv4-only networks, use the Session pooler URI from Project Settings → Database → Connect (not the direct `db.*` host if the dashboard warns IPv4 is unsupported). \
For pooler connections, the username is often `postgres.<project-ref>` as shown in the dashboard. \
If your database password contains `@`, `#`, `/`, or spaces, percent-encode it in the URL. \
Append `?sslmode=require` if not already present."
                } else {
                    ""
                };
                anyhow::anyhow!("Failed to connect to Postgres: {}{}", msg, supabase_hint)
            })?;
        tracing::info!(max_connections = max_conn, "PostgreSQL pool initialized");
        Ok(Self { pool })
    }

    /// Execute a raw SQL string with NO parameter binding.
    ///
    /// # ⚠️ SQL INJECTION HAZARD
    ///
    /// This method takes a raw SQL string and runs it verbatim. **Do NOT pass
    /// any value built with `format!()`, string concatenation, or any other
    /// runtime interpolation of user-controlled data — that is a SQL injection
    /// vulnerability.**
    ///
    /// Use [`PgClient::execute_with`] + [`pg_args!`] for anything that
    /// interpolates a value. This method exists only for:
    ///   - fully-static SQL literals (e.g. `"SELECT * FROM tool_categories"`)
    ///   - migration / admin scripts where the SQL is hardcoded at build time
    ///   - SQL composed from a server-controlled allowlist (and even then,
    ///     prefer parameter binding when possible)
    ///
    /// New code should not call this. The name is intentionally ugly so
    /// reviewers can spot it. See `CLAUDE.md` → "SQL safety".
    pub async fn execute_unparameterized(&self, sql: &str) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| anyhow::anyhow!("SQL error: {}", e))?;
        Ok(rows.iter().map(pg_row_to_json).collect())
    }

    /// See [`PgClient::execute_unparameterized`] — same SQL-injection caveats apply.
    pub async fn execute_unparameterized_with_id(
        &self,
        sql: &str,
    ) -> anyhow::Result<(Vec<Value>, Option<String>)> {
        let rows = self.execute_unparameterized(sql).await?;
        let query_id = uuid::Uuid::new_v4().to_string();
        Ok((rows, Some(query_id)))
    }

    /// Execute a parameterized query. Use `pg_args!` to build the arguments.
    pub async fn execute_with(
        &self,
        sql: &str,
        args: sqlx::postgres::PgArguments,
    ) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query_with(sql, args)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| anyhow::anyhow!("SQL error: {}", e))?;
        Ok(rows.iter().map(pg_row_to_json).collect())
    }

    /// Begin a database transaction.
    pub async fn begin(&self) -> anyhow::Result<PgTransaction> {
        let tx = self.pool.begin().await.map_err(|e| anyhow::anyhow!("Failed to begin transaction: {}", e))?;
        Ok(PgTransaction { tx })
    }
}

/// A database transaction that can execute parameterized queries and be committed or rolled back.
pub struct PgTransaction {
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
}

impl PgTransaction {
    /// Execute a parameterized query within the transaction.
    pub async fn execute_with(
        &mut self,
        sql: &str,
        args: sqlx::postgres::PgArguments,
    ) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query_with(sql, args)
            .fetch_all(&mut *self.tx)
            .await
            .map_err(|e| anyhow::anyhow!("SQL error: {}", e))?;
        Ok(rows.iter().map(pg_row_to_json).collect())
    }

    /// Commit the transaction.
    pub async fn commit(self) -> anyhow::Result<()> {
        self.tx.commit().await.map_err(|e| anyhow::anyhow!("Failed to commit transaction: {}", e))
    }
}

/// Build `PgArguments` for parameterized queries.
///
/// Usage: `pg_args!(session_id, &slug, 42_i32, some_json_value)`
#[macro_export]
macro_rules! pg_args {
    ($($val:expr),* $(,)?) => {{
        use ::sqlx::Arguments as _;
        #[allow(unused_mut)]
        let mut args = ::sqlx::postgres::PgArguments::default();
        $(args.add($val).expect("pg_args: encode failed");)*
        args
    }};
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

        "text" | "varchar" | "name" | "char" | "bpchar" => row
            .try_get::<Option<String>, _>(col_name)
            .ok()
            .flatten()
            .map(Value::String)
            .unwrap_or(Value::Null),

        "uuid" => row
            .try_get::<Option<uuid::Uuid>, _>(col_name)
            .ok()
            .flatten()
            .map(|u| Value::String(u.to_string()))
            .unwrap_or(Value::Null),

        "_uuid" | "uuid[]" => row
            .try_get::<Option<Vec<uuid::Uuid>>, _>(col_name)
            .ok()
            .flatten()
            .map(|arr| Value::Array(arr.into_iter().map(|u| Value::String(u.to_string())).collect()))
            .unwrap_or(Value::Array(vec![])),

        "_text" | "text[]" | "_varchar" | "varchar[]" => row
            .try_get::<Option<Vec<String>>, _>(col_name)
            .ok()
            .flatten()
            .map(|arr| Value::Array(arr.into_iter().map(Value::String).collect()))
            .unwrap_or(Value::Array(vec![])),

        "bytea" => row
            .try_get::<Option<Vec<u8>>, _>(col_name)
            .ok()
            .flatten()
            .map(|bytes| Value::String(format!("\\x{}", hex::encode(bytes))))
            .unwrap_or(Value::Null),

        _ => row
            .try_get::<Option<String>, _>(col_name)
            .ok()
            .flatten()
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}
