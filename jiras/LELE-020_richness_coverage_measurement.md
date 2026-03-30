# LELE-020: Richness & Coverage Measurement

## Problem
We don't know what we don't know. The extraction pipeline produces abstracted tasks and agent PRs, but there's no way to measure how much of the expert's actual intent and reasoning we captured vs. missed. Without measurement, we can't systematically improve.

## Design
Build a measurement framework that compares what the system extracted against a ground truth (initially manual review, eventually automated via video).

### Dimensions to Measure
- **Coverage**: Did we capture all distinct actions the expert took? (actions captured / total actions)
- **Intent**: For each captured action, did we explain WHY the expert did it? (not just WHAT)
- **Heuristic quality**: Did we extract the expert's decision rule accurately? (e.g., "VP Eng over CTO at Series B" — is this exactly what the expert was thinking?)
- **Context signals**: Did we capture the data signals the expert used to make decisions? (funding amount, tech stack, etc.)
- **Branching awareness**: When the expert chose path A over path B, did we capture that a choice was made and why?

### Ground Truth Sources
1. **Expert self-report** (near-term): After a session, ask the expert: "Here's what we think you did. What did we miss?" Show them the abstracted tasks and let them correct/add.
2. **Video review** (LELE-018): Manually review the session video and annotate all actions, reasoning, and decisions. Compare against automated extraction.
3. **Comparative analysis** (LELE-019): Run the same video through the continuous reasoning loop. Compare its output against the batch narrator's output.

### Tracking Over Time
Store richness scores per session. As we improve the narrator prompts, extraction prompts, and capture mechanisms, the score should trend upward. Dashboard on the observe page showing historical richness trend.

## Dependencies
- LELE-018 (video recording) for video-based ground truth
- LELE-019 (continuous reasoning) for improved extraction quality

## Acceptance Criteria
- [ ] Expert can review and annotate extracted tasks after a session
- [ ] Richness score computed per session across all dimensions
- [ ] Historical tracking shows improvement over time
- [ ] Comparison mode: side-by-side of what was extracted vs what expert reports they actually did
