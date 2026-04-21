//! Deterministic SQL migration runner for `backend/migrations/*.sql`.
//! Usage:
//!   cd backend
//!   cargo run --bin migrate

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv_override().ok();
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL not set"))?;

    let migrations_dir = PathBuf::from("migrations");
    if !migrations_dir.exists() {
        anyhow::bail!("migrations directory not found: {}", migrations_dir.display());
    }

    let mut files = list_sql_files(&migrations_dir)?;
    files.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    warn_duplicate_numeric_prefixes(&files);

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&database_url)
        .await?;

    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS schema_migrations (
            file_name TEXT PRIMARY KEY,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"#,
    )
    .execute(&pool)
    .await?;

    let mut applied = 0_u32;
    let mut skipped = 0_u32;
    for file in files {
        let content = std::fs::read_to_string(&file.path)?;
        let checksum = sha256_hex(content.as_bytes());

        let existing = sqlx::query_as::<_, (String,)>(
            "SELECT checksum FROM schema_migrations WHERE file_name = $1",
        )
        .bind(&file.file_name)
        .fetch_optional(&pool)
        .await?;

        if let Some((existing_checksum,)) = existing {
            if existing_checksum != checksum {
                anyhow::bail!(
                    "checksum mismatch for already-applied migration {}",
                    file.file_name
                );
            }
            println!("skip {}", file.file_name);
            skipped += 1;
            continue;
        }

        let mut tx = pool.begin().await?;
        sqlx::raw_sql(&content).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO schema_migrations (file_name, checksum) VALUES ($1, $2)")
            .bind(&file.file_name)
            .bind(&checksum)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        println!("apply {}", file.file_name);
        applied += 1;
    }

    println!(
        "migrations complete: applied={}, skipped={}",
        applied, skipped
    );
    Ok(())
}

#[derive(Debug)]
struct MigrationFile {
    file_name: String,
    path: PathBuf,
}

fn list_sql_files(dir: &Path) -> anyhow::Result<Vec<MigrationFile>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|f| f.to_str())
            .ok_or_else(|| anyhow::anyhow!("invalid UTF-8 migration filename: {}", path.display()))?
            .to_string();
        files.push(MigrationFile { file_name, path });
    }
    Ok(files)
}

fn warn_duplicate_numeric_prefixes(files: &[MigrationFile]) {
    use std::collections::HashMap;
    let mut seen: HashMap<u32, &str> = HashMap::new();
    for f in files {
        let Some((prefix, _)) = f.file_name.split_once('_') else {
            continue;
        };
        let Ok(num) = prefix.parse::<u32>() else {
            continue;
        };
        if let Some(prev) = seen.get(&num) {
            eprintln!(
                "warning: duplicate numeric migration prefix {:03}: {} and {}",
                num, prev, f.file_name
            );
        } else {
            seen.insert(num, &f.file_name);
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
