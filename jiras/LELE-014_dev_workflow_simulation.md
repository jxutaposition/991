# LELE-014: Dev Workflow — Simulation Mode for Testing

## Problem
Testing the full execution pipeline without making real LLM calls or tool calls is essential for: fast iteration, CI/CD, cost control, and deterministic testing. We need a simulation mode that runs the full work queue and agent runner loop with mocked responses.

## Design

**Environment variable:** `SIMULATION_MODE=true` in `.env` enables simulation mode.

**Simulated agent runner:** When `SIMULATION_MODE=true`, `AgentRunner::run()` skips the actual LLM calls and returns a pre-built mock output based on the agent's `examples/` folder:
1. Pick a random example from the agent's `examples/*.json`
2. Return `example.output` as the agent's output
3. Set judge_score to a random value between 7.5 and 9.5 (always passes)
4. Add a random delay of 1-5 seconds to simulate realistic execution time

**Simulated tool calls:** In simulation mode, `execute_tool()` always returns the mock response regardless of input. No external API calls are made.

**Demo mode:** For live demos, add `DEMO_SCENARIO=scenario_a` to load a pre-built execution plan (hardcoded in `demo_scenarios.rs`). The demo plan runs with simulated agents but produces realistic-looking output.

**CI integration:** Tests can set `SIMULATION_MODE=true` to run the full pipeline in fast-deterministic mode:
```bash
SIMULATION_MODE=true cargo test
```

**Verification steps (from the plan):**
All 6 verification steps in the plan should pass in simulation mode:
1. All 20 agents load from disk ✓
2. Unit tests pass ✓
3. Scenario A: 9-node DAG planned with correct slugs ✓
4. Work queue executes in dependency order ✓
5. Canvas shows live DAG with SSE updates ✓
6. All 4 demo scenarios produce correct DAG topologies ✓

## Test Scenarios

**Unit tests (fast, no I/O):**
- `AgentCatalog::load_from_disk` — verify all 20 agents load with correct fields
- `plan_execution` — verify parser handles all output formats
- Kahn's algorithm — verify topological sort with various DAG shapes

**Integration tests (with simulation mode):**
- Full workflow: POST /api/execute → plan → approve → execute → complete
- Parallel execution: two agents run simultaneously, downstream unblocks correctly
- Failure handling: agent fails 3 times → session marked failed
- Stale node recovery: node stuck in `running` → reset after timeout

## Acceptance Criteria
- [ ] `SIMULATION_MODE=true` runs end-to-end without external calls
- [ ] Demo scenarios produce correct node counts and DAG shapes
- [ ] All 4 demo scenario topologies verified (linear, branching, parallel merge, fan-in)
- [ ] Unit tests for catalog loading, planner parsing, work queue
- [ ] CI pipeline runs in simulation mode
