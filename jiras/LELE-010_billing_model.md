# LELE-010: Billing Model

## Problem
We need a billing model that:
1. Passes through infrastructure costs (LLM tokens, tool call costs) without markup
2. Charges premium for platform value (expert catalog, orchestration intelligence, no-code UX)
3. Is simple enough for customers to understand and predict
4. Scales with usage without creating misaligned incentives

## Proposed Model

### Platform Fee (SaaS subscription)
- Monthly flat fee for access to the platform and expert agent catalog
- Tier A (Starter): $500/month — access to all 20 catalog agents, 10 workflow executions/month
- Tier B (Growth): $2,000/month — unlimited executions, custom agent PRs (expert reviews your workflows)
- Tier C (Enterprise): $5,000/month — dedicated expert sessions (expert shadows your team quarterly), custom catalog extensions

### Usage Pass-Through (variable, at cost)
- LLM tokens: billed at cost from Anthropic (no markup)
- Tool calls: third-party API costs passed through (Apollo, NewsAPI, etc.)
- Storage: S3/MinIO costs at $0.023/GB/month passed through
- Estimated: $0.50-$5 per workflow execution depending on complexity

**Transparency:** Full token and cost breakdown shown in the session report. Customers know exactly what they're paying for and why.

### Why This Model
- **No compute markup:** Our value is not in reselling GPU cycles. It's in the expert knowledge encoded in the catalog. Charging a margin on tokens misaligns incentives (we'd want agents to use more tokens, not better ones).
- **Catalog as the moat:** The $500-$5,000/month subscription pays for access to expert-trained agents. This is defensible — it takes years to build and refine the catalog. A competitor can't replicate it by paying for more compute.
- **Expert revenue share:** A portion of Tier B/C subscription revenue is shared with the expert whose agents were used in each workflow. Attribution tracked per execution.

## Open Questions
- Should there be a free tier (with usage caps) for customer acquisition?
- How do we handle customers who want to train their own private agents (not shared to the marketplace)?
- Should platform fee be annual or monthly? Annual contracts reduce churn but slow sales cycles.
- How do we price the expert sessions in Tier C?

## Acceptance Criteria
- [ ] Token usage recorded at the execution_node level
- [ ] Per-session cost report generated on session completion
- [ ] Monthly usage summary available in customer portal
- [ ] Pass-through billing line items visible in invoice
