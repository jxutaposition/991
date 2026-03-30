# LELE-002: Dynamic Execution Model — Budget Caps and Quota

## Problem
Multi-agent workflows can run indefinitely. A workflow with `max_iterations=15` per agent, 9 agents, and 2 judge retries per agent could make 9 × (15 + 2×15) = 405 LLM calls. At $0.015/call average, that's $6/workflow. Customers need predictable costs and the system needs guardrails.

## Design Decisions

**Per-session token budget:** Store `token_budget` on `execution_sessions`. Default: 500k tokens. Each `execution_node` records actual `token_usage`. Work queue checks remaining budget before dispatching each node. If budget would be exceeded, mark remaining nodes as `skipped` with reason `budget_exhausted`.

**Budget update cadence:** Update remaining budget atomically after each node completes (using a DB transaction). Do not pre-allocate — the actual usage is unpredictable.

**Customer quota:** `customers` table has a `monthly_token_quota`. At session creation, check if the customer has quota remaining. If not, reject the session with a `quota_exceeded` error.

**Overage handling:** Two options — (a) hard stop at quota, (b) allow overage with a configurable threshold (e.g., 10% overage allowed before hard stop). Default: hard stop. Premium tier: 10% overage threshold.

**Cost estimation at plan time:** After planning but before approval, compute an estimated token cost range for the plan. Show to customer on the approval screen: "Estimated: 50,000-150,000 tokens (~$0.75-$2.25)." The estimate is based on: `sum(max_iterations × avg_tokens_per_call)` for all nodes. Wide range is expected — be honest about the uncertainty.

## Open Questions
- What happens when a customer runs out of quota mid-session? Should we attempt to complete already-running nodes or stop immediately?
- Should token usage be reported in the UI in real time, or only in the final report?
- How do we handle the case where a spawned child agent pushes total usage above budget?

## Acceptance Criteria
- [ ] `token_usage` recorded on every `execution_node` row after completion
- [ ] Session-level budget check before each node dispatch
- [ ] Budget exhaustion marks remaining nodes as `skipped` with reason
- [ ] Cost estimate shown on plan approval screen
- [ ] Monthly quota enforcement at session creation
