# LELE-003: Quality Gates for GTM Agents

## Problem
GTM agents produce outputs that affect real customer relationships — cold emails, LinkedIn messages, ad copy. A poorly scored output that gets sent to a prospect damages the customer's reputation. The judge loop must be calibrated tightly for GTM contexts.

## Design

**Three-stage quality gate:**
1. **Critic** — checks rubric items from `judge_config.toml` mechanically. Binary pass/fail per item. If any items fail, feeds back to executor with the specific failed items.
2. **Judge** — scores 0-10 against the full rubric. Checks `need_to_know` questions. If score < threshold, provides specific feedback for retry.
3. **Human escalation flag** — if judge_score < 5.0 after max retries OR if a `need_to_know` question is unanswered, flag the output as `needs_human_review` rather than `failed`. The customer can review and approve manually.

**Per-agent thresholds:**
- Cold email writer: 8.0 (high bar — impacts prospect relationships)
- Subject line optimizer: 7.5
- Ad copy writer: 7.5
- Landing page copy: 8.0
- CRM updater: 6.0 (structural outputs, skip judge entirely — `skip_judge = true`)
- Analytics agents: 7.5

**skip_judge agents:** CRM updater, some analytics agents where the output is structured data (not prose). These agents write to CRM or produce structured JSON — correctness is checkable mechanically, not with a prose rubric.

**`flexible_tool_use` flag:** When `false`, the agent's tool list is enforced strictly. When `true`, the agent can call any tool in the global library (useful for agents that may need to spawn sub-investigations). Default: `false` for all current agents.

## Open Questions
- Should the customer ever see judge scores and feedback, or is it purely internal?
- Should there be a global minimum quality threshold (e.g., no output below 6.0 ever makes it to the customer)?
- How do we calibrate judge prompts for GTM-specific quality vs. general quality?

## Acceptance Criteria
- [ ] Critic stage checks each rubric item and returns specific failures
- [ ] Judge stage scores 0-10 and returns itemized feedback on failures
- [ ] `need_to_know` questions trigger hard reject if unanswered
- [ ] `human_escalation` flag set on outputs with score < 5.0 after max retries
- [ ] `skip_judge` agents bypass judge loop entirely
