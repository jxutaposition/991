# LELE-009: Multi-Expert Deduplication and Marketplace

## Problem
When multiple GTM experts train the same agent type (e.g., two "cold email writers" from different agencies), we need to:
1. Avoid polluting a single agent's prompt with contradictory heuristics
2. Create a marketplace where customers can choose which expert's version to use
3. Over time, surface which expert version produces better outcomes

## Design

**Expert namespacing:** Each expert has a UUID. Agent folders are namespaced: `backend/agents/cold_email_writer/` is the "canonical" version. Expert-specific forks live at `backend/agents/cold_email_writer__expert_{slug}/`. The catalog loads all versions.

**Attribution in agent.toml:**
```toml
slug = "cold_email_writer__sarah_chen"
name = "Cold Email Writer (Sarah Chen)"
base_slug = "cold_email_writer"
expert_id = "uuid-here"
expert_name = "Sarah Chen"
expert_bio = "10 years at Outreach, built SDR team from 0 to 50 at Rippling"
```

**Planner routing:** The planner normally selects the canonical version. Customers who have "subscribed to" an expert can configure: "use Sarah Chen's cold email writer for all my workflows." This preference is stored in `customer_preferences.agent_overrides`.

**Quality signals:** Track outcome metrics per agent version:
- `execution_nodes.judge_score` — quality at time of execution
- Future: link to actual outcome data (did the email get a reply? Did the campaign convert?)

**Deduplication during PR review:**
When a new expert submits an Enhancement PR, the system compares their proposed addition against all other expert versions of the same agent. If it's redundant, suggest a merge. If it's contradictory, surface the contradiction to the curator.

## Marketplace UX
- Expert profiles page: photo, bio, areas of expertise
- Per-agent version comparison: side-by-side prompts, judge score history, customer usage stats
- "Subscribe to Sarah's outreach playbook" — one click enables her versions for all outreach agents

## Open Questions
- How do we prevent experts from gaming quality metrics?
- Should experts be paid based on usage? If so, how do we track attribution in a multi-expert workflow?
- What happens if a customer unsubscribes from an expert mid-workflow?

## Acceptance Criteria (deferred — post-MVP)
- [ ] Expert-namespaced agent folders load correctly from catalog
- [ ] `base_slug` field enables grouping of agent versions in the catalog UI
- [ ] Customer preference to override agent version for a base_slug works end-to-end
- [ ] Quality tracking distinguishes between agent versions
