# LELE-019: Continuous Reasoning Loop for Narrator

## Problem
The narrator currently processes events in disconnected 10-second batches. Each batch gets 1-3 sentences of narration with the last 5 narrations as context. This "batch and forget" approach misses:
- Long-running patterns (expert spent 5 minutes researching, then made a quick decision — the connection is lost across batches)
- Decision branching (expert considered option A, paused, switched to option B — the hesitation and reasoning is lost)
- Accumulated context (by batch 20, the narrator has lost the thread of what happened in batch 1)

## Design
Replace batch narration with a **continuous reasoning loop** that maintains an evolving understanding of the expert's session.

### Core Idea
Instead of "narrate these 3 events", the system maintains a **running session summary** that grows and evolves:

```
Every N seconds (or on significant event):
  Input: running_summary + new_events + [optional: recent_screenshot]
  Output: {
    updated_summary: "Expert is mid-way through qualifying FinFlow...",
    new_narration: "Expert checked tech stack to confirm integration fit",
    reasoning: "This is the 3rd qualification signal checked — expert appears to use a checklist approach",
    decision_points: ["Chose VP Eng over CTO", "Filtered for Series A/B specifically"]
  }
```

The `running_summary` is the key: it's a compressed representation of the entire session so far, growing richer over time without needing to re-read all prior events.

### Potential Approaches
1. **Accumulating context window**: Keep all narrations + events in context, rely on model's long context (expensive, simple)
2. **Summary + delta**: Maintain a rolling summary, add new events as deltas (cheaper, requires good summarization)
3. **Hierarchical**: Micro-narrations (per-event) → meso-summaries (per-phase) → macro-summary (full session) — each level feeds the one above

### Integration with Video (LELE-018)
If video is available, key frames (at click/navigation moments) can be included as images in the reasoning input. A vision model could extract:
- What the expert was looking at (not just what they clicked)
- How long they paused (thinking/reading)
- Visual patterns the DOM events miss (charts, images, layouts)

## Open Questions
- What model for continuous reasoning? Claude Haiku is fast but may miss nuance. Sonnet is better but slower/costlier. Maybe Haiku for micro-narrations, Sonnet for phase summaries.
- How to handle the running summary growing too large? Periodic compression?
- Should the continuous reasoning be shown to the expert in real-time, or is it internal-only?

## Acceptance Criteria
- [ ] Narrator maintains a running session summary that evolves with each batch
- [ ] Decision points are explicitly tracked (not just actions)
- [ ] Session summary at end contains a coherent narrative of the full expert workflow
- [ ] Extraction pipeline can use the enriched summary instead of just individual narrations
