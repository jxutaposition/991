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

#[derive(Debug, Clone)]
pub struct DecryptedCredential {
    pub credential_type: String,
    pub value: String,
    pub metadata: Value,
}

pub type CredentialMap = HashMap<String, DecryptedCredential>;

// Encryption: master_key_hex is 64 hex chars (32 bytes)
pub fn encrypt(master_key_hex: &str, plaintext: &str) -> anyhow::Result<Vec<u8>> {
    let key_bytes = hex::decode(master_key_hex)?;
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
    let key_bytes = hex::decode(master_key_hex)?;
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
    let slug_esc = integration_slug.replace('\'', "''");
    let type_esc = credential_type.replace('\'', "''");
    let hex_val = hex::encode(encrypted_value);
    let meta = metadata
        .map(|m| m.to_string())
        .unwrap_or_else(|| "{}".to_string());
    let meta_esc = meta.replace('\'', "''");

    let sql = format!(
        "INSERT INTO client_credentials (client_id, integration_slug, credential_type, encrypted_value, metadata) \
         VALUES ('{client_id}', '{slug_esc}', '{type_esc}', '\\x{hex_val}'::bytea, '{meta_esc}'::jsonb) \
         ON CONFLICT (client_id, integration_slug) DO UPDATE SET \
         credential_type = EXCLUDED.credential_type, \
         encrypted_value = EXCLUDED.encrypted_value, \
         metadata = EXCLUDED.metadata, \
         updated_at = NOW() \
         RETURNING id"
    );
    let rows = db.execute(&sql).await?;
    let id = rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok())
        .ok_or_else(|| anyhow::anyhow!("no id returned from upsert"))?;
    Ok(id)
}

pub async fn list_credentials(db: &PgClient, client_id: Uuid) -> anyhow::Result<Vec<Value>> {
    let sql = format!(
        "SELECT id, integration_slug, credential_type, metadata, created_at, updated_at \
         FROM client_credentials WHERE client_id = '{client_id}' ORDER BY integration_slug"
    );
    Ok(db.execute(&sql).await?)
}

pub async fn delete_credential(
    db: &PgClient,
    client_id: Uuid,
    integration_slug: &str,
) -> anyhow::Result<bool> {
    let slug_esc = integration_slug.replace('\'', "''");
    let sql = format!(
        "DELETE FROM client_credentials WHERE client_id = '{client_id}' AND integration_slug = '{slug_esc}'"
    );
    db.execute(&sql).await?;
    Ok(true)
}

pub async fn load_credentials_for_client(
    db: &PgClient,
    master_key_hex: &str,
    client_id: Uuid,
) -> anyhow::Result<CredentialMap> {
    let sql = format!(
        "SELECT integration_slug, credential_type, encrypted_value, metadata \
         FROM client_credentials WHERE client_id = '{client_id}'"
    );
    let rows = db.execute(&sql).await?;
    let mut map = HashMap::new();
    for row in &rows {
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

        // encrypted_value comes back as hex-encoded string from our PgClient
        let enc_hex = row
            .get("encrypted_value")
            .and_then(Value::as_str)
            .unwrap_or("");
        // Strip \x prefix if present
        let clean_hex = enc_hex.strip_prefix("\\x").unwrap_or(enc_hex);
        if let Ok(enc_bytes) = hex::decode(clean_hex) {
            if let Ok(plaintext) = decrypt(master_key_hex, &enc_bytes) {
                map.insert(
                    slug,
                    DecryptedCredential {
                        credential_type: cred_type,
                        value: plaintext,
                        metadata,
                    },
                );
            }
        }
    }
    Ok(map)
}
