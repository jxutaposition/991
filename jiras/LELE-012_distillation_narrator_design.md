# LELE-012: Distillation Narrator — Real-Time Design

## Problem
The narrator needs to produce useful distillations within 30 seconds of an event batch, stream them back to the expert in the side panel, and incorporate real-time corrections that feed back into subsequent narrations.

## Architecture

**Context window construction (per batch):**
```
System prompt (narrator_system.md)
---
## Prior narrations (last 5)
[narration 1]
[expert correction if any]
[narration 2]
...
---
## Current event batch
[events as structured JSON]
---
Narrate:
```

**Streaming:** Use Anthropic's streaming API (SSE). The backend pipes the stream directly to the extension's side panel via a per-session EventBus channel. Expert sees words appear in real time.

**Event batch size:** 10-30 events per batch (flushed every 10s). Smaller batches = more responsive narration. Larger batches = more context per narration. 10s/10-30 events is a reasonable default.

**Correction incorporation:** Expert corrections are stored in `distillations.expert_correction`. When the next batch arrives, the prior narration with its correction is included in the context window. The narrator is instructed (in the system prompt) to weight corrections as ground truth.

**Model selection:** Claude Haiku 4.5 for the narrator. Why:
- Real-time streaming requires low latency — Haiku is significantly faster than Sonnet/Opus
- The narrator produces short outputs (1-4 sentences per batch)
- Context size is manageable (last 5 narrations + current batch)
- Cost: at 100 batches/hour, ~50k input tokens/hour at Haiku pricing = ~$0.05/hour per session

**Failure modes:**
- LLM call fails: log error, do not break the recording session. The side panel shows "Narration unavailable for this batch."
- Side panel disconnects: the narration is still written to DB. When the expert reconnects, they see all missed narrations.
- High latency (>10s): the next batch may arrive before the current narration completes. Queue narration calls — do not drop events.

## Coverage Score
At session end, the backend computes a `coverage_score` (0.0-1.0) for the session:
- Count: total events, total events covered by a narration (within ±3 sequence_refs)
- Penalize: long gaps between narrations (>30s)
- Score formula: `narrated_events / total_events * 0.7 + gap_penalty * 0.3`

## Open Questions
- Should narration happen during recording only, or also available for post-hoc replay?
- How do we handle sessions where the expert records without looking at the side panel (pure background capture)?
- Should the narrator model be configurable per-expert?

## Acceptance Criteria
- [ ] Narration appears in side panel within 30s of event batch arrival
- [ ] Expert corrections stored in `distillations.expert_correction`
- [ ] Corrections appear in next narration's context window
- [ ] `coverage_score` computed at session end
- [ ] Narrator failures do not abort the recording session
- [ ] Narrations queryable by session_id in chronological order
