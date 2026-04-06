# Session 8: Behavioral Deep Dive

**Date**: 2026-04-06
**Investigation**: INV-023

## Critical Behavioral Findings

### 1. Duplication Preserves Field IDs (MAJOR)

**Field IDs are IDENTICAL between original and duplicate.** This is the most important duplication finding:

```
Original Name field: f_0td29095tk5knRoZRQA
Duplicate Name field: f_0td29095tk5knRoZRQA  ← SAME ID
Formula in duplicate: UPPER({{f_0td29095tk5knRoZRQA}})  ← STILL VALID
```

This means:
- Formulas in the duplicate reference the same field IDs → **they work correctly**
- Enrichment `inputsBinding` references are preserved → **enrichment pipelines work in duplicates**
- Duplication is a **perfect clone** for template-based workflows — no field ID remapping needed

### 2. autoRun TRIGGERS ENRICHMENTS ON API INSERTS (P0 — RESOLVED)

Follow-up test with correct view ID proved autoRun is fully functional:

- Set `tableSettings.autoRun: true`
- Insert row via `POST /v3/tables/{id}/records`
- **500ms later**: enrichment cell already shows `metadata.status: "SUCCESS"`
- Enrichment executed **automatically** — no manual `PATCH /run` needed
- Run history shows the autoRun entry with a unique `runId`

**This is THE key finding for autonomous agents**: Set autoRun → insert data → enrichments fire automatically.

### 2b. Conditional Run Formula — CONFIRMED WORKING

`conditionalRunFormulaText: "{{f_score}} > 50"` produces:
- Score=90: `metadata.status: "SUCCESS"` — enrichment ran, returned "✅ Anthropic"
- Score=10: `metadata.status: "ERROR_RUN_CONDITION_NOT_MET"` — **skipped by condition**
- Score=75: `metadata.status: "SUCCESS"` — enrichment ran

**New metadata status value**: `ERROR_RUN_CONDITION_NOT_MET` = row was intentionally skipped because the conditional formula evaluated to falsy. This is distinct from actual errors.

### 3. Formula Error Handling — NO VALIDATION (CRITICAL)

Clay performs **zero formula validation** at creation time:

| Formula | Status | Accepted? |
|---------|--------|-----------|
| `UPPER({{f_NONEXISTENT}})` (invalid field ref) | 200 | YES |
| `UPPER((({{f_xxx}})` (mismatched parens) | 200 | YES |
| Valid formula | 200 | YES |

**Implications for agents:**
- Formulas are stored as opaque strings — no compile-time validation
- Errors only surface at runtime (when rows are evaluated)
- Agent MUST validate field references itself before creating formulas
- Invalid formulas won't error on creation but will produce broken cells

### 4. Optional Enrichment Parameters WORK

Creating an enrichment column with optional `titleCase` boolean parameter:
```json
{
  "inputsBinding": [
    {"name": "companyName", "formulaText": "{{f_xxx}}"},
    {"name": "titleCase", "formulaText": "true"}
  ]
}
```
**Status: 200** — optional params are accepted in `inputsBinding`. Boolean values use `formulaText: "true"` (string formula evaluating to boolean).

### 5. tableSettings Uses MERGE Semantics (CRITICAL)

```
PATCH {keyA: "v1", keyB: "v2"} → {keyA: "v1", keyB: "v2", autoRun: true, HAS_SCHEDULED_RUNS: false}
PATCH {keyC: "v3"}            → {keyA: "v1", keyB: "v2", keyC: "v3", autoRun: true, HAS_SCHEDULED_RUNS: false}
PATCH {keyA: null}            → {keyA: null, keyB: "v2", keyC: "v3", autoRun: true, HAS_SCHEDULED_RUNS: false}
```

**Rules:**
- New keys are **merged** (added to existing settings, never replacing)
- Setting a key to `null` does NOT delete it — stores `null` as the value
- System keys `autoRun` and `HAS_SCHEDULED_RUNS` always present
- The settings object is schemaless — any key accepted
- To "undo" a setting, set it to its off/default value, not null

### 6. forceRun Response Shape

Both `forceRun: true` and `forceRun: false` return identical response shape:
```json
{"recordCount": 1, "runMode": "INDIVIDUAL"}
```
The `recordCount` reflects rows submitted, NOT rows that will actually execute. The conditional logic (forceRun skip, conditionalRunFormulaText evaluation) happens server-side during async processing, invisible to the API caller.

## Summary of Behavioral Rules for Agent Implementation

| Behavior | Rule |
|----------|------|
| Duplication | Field IDs preserved → all references valid in clone |
| Formula creation | Zero validation — accept anything, errors at runtime |
| Optional enrichment params | Use `formulaText: "true"/"false"/string` in inputsBinding |
| tableSettings | Merge semantics — keys accumulate, null doesn't delete |
| forceRun response | Always shows total submitted, not filtered count |
| View reads | Must use view ID obtained AFTER all columns are created |
