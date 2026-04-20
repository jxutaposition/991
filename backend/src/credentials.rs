use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

use crate::pg::PgClient;

const NONCE_LEN: usize = 12;

/// Normalize `CREDENTIAL_MASTER_KEY` from env: trim, strip wrapping quotes, optional `0x`, validate.
fn normalize_master_key_hex(master_key_hex: &str) -> anyhow::Result<&str> {
    let mut s = master_key_hex.trim();
    if s.len() >= 2 {
        let b = s.as_bytes();
        if (b[0] == b'"' && b[s.len() - 1] == b'"')
            || (b[0] == b'\'' && b[s.len() - 1] == b'\'')
        {
            s = &s[1..s.len() - 1];
        }
    }
    s = s.trim();
    if let Some(rest) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        s = rest.trim();
    }
    if s.len() != 64 {
        anyhow::bail!(
            "CREDENTIAL_MASTER_KEY must be exactly 64 hex characters (32 bytes) for AES-256-GCM; \
             after trimming/normalization the length is {}. \
             Generate one with: openssl rand -hex 32",
            s.len()
        );
    }
    if !s.as_bytes().iter().all(|b| b.is_ascii_hexdigit()) {
        anyhow::bail!(
            "CREDENTIAL_MASTER_KEY must be hexadecimal only (0-9, a-f). Remove quotes, spaces, or other characters from the value in backend .env."
        );
    }
    Ok(s)
}

#[derive(Debug, Clone)]
pub struct DecryptedCredential {
    pub credential_type: String,
    pub value: String,
    pub metadata: Value,
}

pub type CredentialMap = HashMap<String, DecryptedCredential>;

// Encryption: master_key_hex is 64 hex chars (32 bytes)
pub fn encrypt(master_key_hex: &str, plaintext: &str) -> anyhow::Result<Vec<u8>> {
    let mk = normalize_master_key_hex(master_key_hex)?;
    let key_bytes = hex::decode(mk)?;
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("encryption failed: {e}"))?;
    let mut result = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

pub fn decrypt(master_key_hex: &str, data: &[u8]) -> anyhow::Result<String> {
    if data.len() < NONCE_LEN + 16 {
        anyhow::bail!("ciphertext too short");
    }
    let mk = normalize_master_key_hex(master_key_hex)?;
    let key_bytes = hex::decode(mk)?;
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)?;
    let nonce = Nonce::from_slice(&data[..NONCE_LEN]);
    let plaintext = cipher
        .decrypt(nonce, &data[NONCE_LEN..])
        .map_err(|e| anyhow::anyhow!("decryption failed: {e}"))?;
    Ok(String::from_utf8(plaintext)?)
}

pub async fn upsert_credential(
    db: &PgClient,
    client_id: Uuid,
    integration_slug: &str,
    credential_type: &str,
    encrypted_value: &[u8],
    metadata: Option<&Value>,
) -> anyhow::Result<Uuid> {
    let meta = metadata.cloned().unwrap_or(serde_json::json!({}));

    let rows = db.execute_with(
        "INSERT INTO client_credentials (client_id, integration_slug, credential_type, encrypted_value, metadata) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (client_id, integration_slug) DO UPDATE SET \
         credential_type = EXCLUDED.credential_type, \
         encrypted_value = EXCLUDED.encrypted_value, \
         metadata = EXCLUDED.metadata, \
         updated_at = NOW() \
         RETURNING id",
        crate::pg_args!(client_id, integration_slug.to_string(), credential_type.to_string(), encrypted_value.to_vec(), meta),
    ).await?;
    let id = rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok())
        .ok_or_else(|| anyhow::anyhow!("no id returned from upsert"))?;
    Ok(id)
}

pub async fn list_credentials(db: &PgClient, client_id: Uuid) -> anyhow::Result<Vec<Value>> {
    Ok(db.execute_with(
        "SELECT id, integration_slug, credential_type, metadata, created_at, updated_at \
         FROM client_credentials WHERE client_id = $1 ORDER BY integration_slug",
        crate::pg_args!(client_id),
    ).await?)
}

pub async fn delete_credential(
    db: &PgClient,
    client_id: Uuid,
    integration_slug: &str,
) -> anyhow::Result<bool> {
    db.execute_with(
        "DELETE FROM client_credentials WHERE client_id = $1 AND integration_slug = $2",
        crate::pg_args!(client_id, integration_slug.to_string()),
    ).await?;
    Ok(true)
}

pub async fn load_credentials_for_client(
    db: &PgClient,
    master_key_hex: &str,
    client_id: Uuid,
) -> anyhow::Result<CredentialMap> {
    let rows = db.execute_with(
        "SELECT integration_slug, credential_type, encrypted_value, metadata \
         FROM client_credentials WHERE client_id = $1",
        crate::pg_args!(client_id),
    ).await?;
    decrypt_rows(&rows, master_key_hex)
}

/// Load credentials for a project with fallback to client-level defaults.
/// Project credentials override client credentials for the same integration slug.
pub async fn load_credentials_for_project(
    db: &PgClient,
    master_key_hex: &str,
    project_id: Uuid,
    client_id: Uuid,
) -> anyhow::Result<CredentialMap> {
    let mut map = load_credentials_for_client(db, master_key_hex, client_id).await?;

    let proj_rows = db.execute_with(
        "SELECT integration_slug, credential_type, encrypted_value, metadata \
         FROM project_credentials WHERE project_id = $1",
        crate::pg_args!(project_id),
    ).await?;
    let project_creds = decrypt_rows(&proj_rows, master_key_hex)?;

    // Project-level overrides client-level
    for (slug, cred) in project_creds {
        map.insert(slug, cred);
    }
    Ok(map)
}

/// Upsert a project-scoped credential.
pub async fn upsert_project_credential(
    db: &PgClient,
    project_id: Uuid,
    integration_slug: &str,
    credential_type: &str,
    encrypted_value: &[u8],
    metadata: Option<&Value>,
) -> anyhow::Result<Uuid> {
    let meta = metadata.cloned().unwrap_or(serde_json::json!({}));

    let rows = db.execute_with(
        "INSERT INTO project_credentials (project_id, integration_slug, credential_type, encrypted_value, metadata) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (project_id, integration_slug) DO UPDATE SET \
         credential_type = EXCLUDED.credential_type, \
         encrypted_value = EXCLUDED.encrypted_value, \
         metadata = EXCLUDED.metadata, \
         updated_at = NOW() \
         RETURNING id",
        crate::pg_args!(project_id, integration_slug.to_string(), credential_type.to_string(), encrypted_value.to_vec(), meta),
    ).await?;
    let id = rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok())
        .ok_or_else(|| anyhow::anyhow!("no id returned from upsert"))?;
    Ok(id)
}

pub async fn list_project_credentials(db: &PgClient, project_id: Uuid) -> anyhow::Result<Vec<Value>> {
    Ok(db.execute_with(
        "SELECT id, integration_slug, credential_type, metadata, created_at, updated_at \
         FROM project_credentials WHERE project_id = $1 ORDER BY integration_slug",
        crate::pg_args!(project_id),
    ).await?)
}

pub async fn delete_project_credential(
    db: &PgClient,
    project_id: Uuid,
    integration_slug: &str,
) -> anyhow::Result<bool> {
    db.execute_with(
        "DELETE FROM project_credentials WHERE project_id = $1 AND integration_slug = $2",
        crate::pg_args!(project_id, integration_slug.to_string()),
    ).await?;
    Ok(true)
}

fn decrypt_rows(rows: &[Value], master_key_hex: &str) -> anyhow::Result<CredentialMap> {
    let mut map = HashMap::new();
    for row in rows {
        let slug = row
            .get("integration_slug")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let cred_type = row
            .get("credential_type")
            .and_then(Value::as_str)
            .unwrap_or("api_key")
            .to_string();
        let metadata = row
            .get("metadata")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));

        let enc_hex = row
            .get("encrypted_value")
            .and_then(Value::as_str)
            .unwrap_or("");
        if enc_hex.is_empty() {
            tracing::warn!(slug = %slug, "encrypted_value is empty/null");
            continue;
        }
        let clean_hex = enc_hex.strip_prefix("\\x").unwrap_or(enc_hex);
        match hex::decode(clean_hex) {
            Ok(enc_bytes) => match decrypt(master_key_hex, &enc_bytes) {
                Ok(plaintext) => {
                    map.insert(
                        slug,
                        DecryptedCredential {
                            credential_type: cred_type,
                            value: plaintext,
                            metadata,
                        },
                    );
                }
                Err(e) => {
                    tracing::warn!(slug = %slug, error = %e, "failed to decrypt credential");
                }
            },
            Err(e) => {
                tracing::warn!(slug = %slug, error = %e, "failed to hex-decode encrypted_value");
            }
        }
    }
    Ok(map)
}
