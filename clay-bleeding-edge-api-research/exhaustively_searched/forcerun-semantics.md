# forceRun Semantics

**Status**: FULLY DOCUMENTED
**Investigated**: INV-024 (Session 9)

## Rules
- `forceRun: false` → Skips cells with `metadata.status: "SUCCESS"`. Only runs on un-enriched or errored cells. Run history count stays the same.
- `forceRun: true` → Re-runs ALL targeted cells regardless of status. Run history gains new entry.
- Both return identical response: `{recordCount: N, runMode: "INDIVIDUAL"}` — response doesn't indicate how many actually executed.

## Agent Pattern
- "Fill gaps only" → `forceRun: false`
- "Full refresh" → `forceRun: true`
