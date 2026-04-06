# tableSettings Merge Semantics

**Status**: FULLY DOCUMENTED  
**Investigated**: INV-023 (Session 8)

## Rules

- PATCH `tableSettings` uses **MERGE** — new keys added, existing keys preserved
- Setting key to `null` stores `null` value (does NOT delete the key)
- System keys `autoRun` and `HAS_SCHEDULED_RUNS` always injected
- Schemaless JSON blob — any arbitrary key accepted
- To "undo" a setting: set it to its off/default value, not null
