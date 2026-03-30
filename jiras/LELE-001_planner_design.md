# LELE-001: Planner Design — NL Request → Execution DAG

## Problem
Customers describe GTM goals in natural language. The system must decompose those requests into a directed acyclic graph of agent assignments without human intervention, using only the agent catalog as the available vocabulary.

## Design Decisions

**Model selection:** Use the most capable available Claude model (Opus 4.x) for planning. The planner runs once per session and is not in the hot path — latency tolerance is high (10-30s acceptable). Quality of the plan directly determines quality of all downstream work.

**Catalog injection:** The full `catalog_summary()` string is injected into the planner system prompt. At 20 agents, this is ~2000 tokens. At 50+ agents, consider semantic search pre-filtering (embed the request, find top-10 most similar agents, inject only those).

**Output format:** JSON array of `PlannedNode` objects. Strict schema enforced — if the LLM produces malformed JSON, retry up to 3 times with the parse error included as feedback.

**Dependency encoding:** `depends_on` uses array indices (0-indexed). On conversion to execution nodes, stable UUIDs are assigned and `requires` fields are set. This two-step design keeps the planner prompt simple and avoids UUID hallucination.

**Cycle detection:** Perform DFS cycle check on the planned DAG before saving. If a cycle is detected, retry the planner with an explicit warning: "Your previous plan contained a cycle involving these nodes: [...]."

## Open Questions
- How do we handle requests that span capabilities not covered by any agent? Options: (a) reject and ask the user to clarify, (b) use `spawn_agent` at runtime to handle novel sub-tasks, (c) flag for review and let the system partially execute.
- Should the planner be given the full agent prompts or just the descriptions/intents? Full prompts would let it make better assignments but add significant token cost.
- Can the planner suggest new agents that don't exist yet? This could be a signal for the agent PR system.

## Acceptance Criteria
- [ ] Planner returns valid JSON parseable as `Vec<PlannedNode>` for all 4 demo scenarios
- [ ] Planner correctly identifies parallel vs. sequential nodes (no unnecessary serialization)
- [ ] Planner uses correct agent slugs (never invents slugs not in the catalog)
- [ ] Retry logic handles JSON parse errors gracefully
- [ ] Cycle detection prevents invalid DAGs from being persisted
