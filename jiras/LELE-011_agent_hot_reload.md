# LELE-011: Agent Hot Reload

## Problem
When an Agent PR is approved, the agent's files change on disk. The backend's in-memory `AgentCatalog` is stale until the next restart. We need to hot-reload changed agents without restarting the server, disrupting active workflow executions, or losing state.

## Design

**Reload scope:** Hot reload operates at the single-agent level, not the full catalog. Only the agent whose files were changed is reloaded.

**AgentCatalog::reload_agent(slug):**
```rust
pub async fn reload_agent(&self, slug: &str, agents_dir: &Path) -> anyhow::Result<()> {
    let new_def = load_agent_from_disk(agents_dir, slug).await?;
    let mut agents = self.agents.write().await; // RwLock
    agents.insert(slug.to_string(), new_def);
    Ok(())
}
```

The catalog switches from `BTreeMap` (no interior mutability) to `Arc<RwLock<BTreeMap<String, AgentDefinition>>>`. Writers (reload_agent) acquire a write lock; readers (plan execution, work queue dispatch) acquire a read lock.

**Active execution safety:** In-flight `ExecutionNode` rows record `agent_git_sha` at dispatch time. Even if the catalog is updated, a running node uses its already-loaded agent definition (captured in the `AgentRunner` struct at dispatch time, not re-fetched from catalog during execution). No interruption to active executions.

**Future nodes:** Nodes that haven't started yet (status=`pending` or `waiting`) will pick up the new agent definition when they become `ready` and are dispatched by the work queue. This is the desired behavior — new nodes get the updated agent.

**Notification:** After `reload_agent`, emit a `catalog_updated` SSE event so the frontend catalog page refreshes.

**Re-embedding:** After reload, re-embed the agent and upsert `agent_catalog_index` so the planner's semantic search uses the updated agent.

## Thread Safety
The `AgentCatalog` is wrapped in `Arc<RwLock<...>>`. Multiple concurrent read operations (plan, dispatch, catalog API endpoints) proceed without blocking each other. The write operation (reload) blocks briefly while the lock is held — typically < 1ms per agent reload.

## Open Questions
- Should reload be synchronous (caller waits for the new definition to be written) or async (fire and forget)?
- Should reload trigger re-planning for sessions in `awaiting_approval` status (their plans may reference the old agent definition)?

## Acceptance Criteria
- [ ] `reload_agent` updates in-memory definition without server restart
- [ ] Active executions continue using their pre-dispatch agent definition
- [ ] New executions after reload use the updated definition
- [ ] `agent_catalog_index` re-embedding triggered after reload
- [ ] `catalog_updated` SSE event emitted after reload
- [ ] Concurrent reads not blocked during reload (verify with load test)
