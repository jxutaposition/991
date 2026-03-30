/// Event bus for live execution progress.
///
/// Per-session broadcast channels for SSE streaming.
/// Events are also persisted to execution_events in Postgres.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;
use tracing::warn;

const BROADCAST_CAPACITY: usize = 1024;

#[derive(Clone)]
pub struct EventBus {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<Value>>>>,
    tasks: Arc<RwLock<HashMap<String, Arc<AbortOnDropHandle>>>>,
}

pub struct AbortOnDropHandle {
    handle: JoinHandle<()>,
}

impl AbortOnDropHandle {
    pub fn new(handle: JoinHandle<()>) -> Self {
        Self { handle }
    }

    pub fn abort(&self) {
        self.handle.abort();
    }
}

impl Drop for AbortOnDropHandle {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            channels: Arc::new(RwLock::new(HashMap::new())),
            tasks: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_channel(&self, session_id: &str) -> broadcast::Sender<Value> {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        self.channels.write().await.insert(session_id.to_string(), tx.clone());
        tx
    }

    pub async fn subscribe(&self, session_id: &str) -> Option<broadcast::Receiver<Value>> {
        self.channels.read().await.get(session_id).map(|tx| tx.subscribe())
    }

    pub async fn is_running(&self, session_id: &str) -> bool {
        self.tasks.read().await.contains_key(session_id)
    }

    pub async fn register_task(&self, session_id: &str, handle: JoinHandle<()>) {
        let wrapped = Arc::new(AbortOnDropHandle::new(handle));
        self.tasks.write().await.insert(session_id.to_string(), wrapped);
    }

    pub async fn cancel_task(&self, session_id: &str) {
        if let Some(handle) = self.tasks.write().await.remove(session_id) {
            handle.abort();
        }
        self.channels.write().await.remove(session_id);
    }

    /// Send an event to all subscribers of a session channel.
    /// Returns false if the channel doesn't exist or has no receivers.
    pub async fn send(&self, session_id: &str, event: serde_json::Value) -> bool {
        if let Some(tx) = self.channels.read().await.get(session_id) {
            tx.send(event).is_ok()
        } else {
            false
        }
    }

    pub async fn cleanup(&self, session_id: &str) {
        self.tasks.write().await.remove(session_id);
        self.channels.write().await.remove(session_id);
    }

    pub async fn shutdown(&self) {
        let mut tasks = self.tasks.write().await;
        for (session_id, handle) in tasks.drain() {
            warn!(session_id = %session_id, "shutting down running execution task");
            handle.abort();
        }
        self.channels.write().await.clear();
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
