# /review — Codebase Review

You are performing a focused codebase review. The user has requested a review in the category: **$ARGUMENTS**

---

## If no category was provided (empty or blank argument)

Print the following menu and stop:

```
Available /review categories:

  1. smell     — Code smells, structural issues, error handling patterns
  2. security  — Vulnerabilities, auth gaps, dependency health
  3. ui        — Theme consistency, accessibility, responsiveness, scalable patterns
  4. docs      — Drift between system_design/ docs and actual code
  5. perf      — Runtime inefficiencies, queries, rendering, async patterns
  6. tests     — Coverage gaps, missing test types, untested critical paths

Usage: /review <category>
Example: /review security
```

---

## General instructions (apply to ALL categories)

1. **Use Explore agents** to scan the codebase broadly. Launch 2-3 agents in parallel to cover different areas (backend, frontend, config/infra).
2. **Find 5-10 concrete, actionable findings.** Not 3, not 20. Aim for the range.
3. **Each finding must include:**
   - **Severity**: critical / high / medium / low
   - **File and line**: exact path and line number (e.g., `backend/src/routes.rs:42`)
   - **What's wrong**: 1-2 sentences describing the issue
   - **Suggested fix**: a concrete, specific action — not "consider refactoring" but "extract lines 45-80 into a `validate_session()` function"
   - **Why it matters**: what breaks, degrades, or becomes painful if this is left unfixed
4. **Sort findings by severity** (critical first, low last).
5. **Don't flag style preferences, formatting, or linting issues** — those belong in a linter, not a review.
6. **Don't flag things that are obviously intentional** (e.g., a TODO with a tracking comment, a workaround with an explanation). Note them if relevant but rank low.
7. **Be specific to THIS codebase** — generic advice like "add more comments" is useless. Every finding should reference actual code you read.

---

## Category: `smell`

**What to look for:**
- God functions longer than ~50 lines doing too many things
- Deep nesting (>3 levels of if/match/for)
- Copy-paste duplication across files — same logic repeated with minor variations
- Unclear or misleading names (functions that do more/less than their name implies)
- Improper abstractions — either premature (wrapping something used once) or missing (same pattern repeated 3+ times without extraction)
- Dead code paths that can never be reached
- Tight coupling between modules that should be independent
- Inconsistent error handling patterns:
  - Rust: mixing `unwrap()` / `expect()` / `?` / `anyhow` inconsistently within the same module
  - React: swallowed `.catch()` blocks that silently fail, missing error boundaries
  - Routes that return proper error responses vs. routes that panic or return bare 500s

**Rules:**
- Focus on things that would **cause bugs**, **confuse a new contributor**, or **make refactoring painful**.
- If something looks intentional (e.g., a workaround with a comment explaining why), note it but don't rank it high.
- Don't flag single-use helpers as "unnecessary abstraction" if they improve readability.
- DO flag functions where you have to scroll to understand what they do.

---

## Category: `security`

**What to look for:**
- SQL injection vectors — raw string interpolation in queries instead of parameterized queries (check SQLx usage)
- XSS — user-provided content rendered with `dangerouslySetInnerHTML` or unescaped in templates
- Hardcoded secrets, API keys, or credentials in source code (not .env)
- Missing input validation at API boundaries (route handlers accepting arbitrary input without validation)
- CORS misconfiguration — overly permissive origins, missing credential restrictions
- Missing authentication/authorization checks on route handlers that should be protected
- Exposed stack traces or internal error details in API error responses sent to clients
- Insecure dependency versions — check `Cargo.toml` and `package.json` for dependencies with known CVEs
- Session/token handling issues — tokens stored in localStorage instead of httpOnly cookies, missing expiry, no refresh rotation

**Rules:**
- **Distinguish theoretical risks from exploitable vulnerabilities.** A SQL injection on a route exposed to the internet is critical; a string concat in an internal admin script is low.
- **Rank by severity** using OWASP-style impact assessment.
- Don't flag internal-only code paths as "injection risks" if they never touch user input.
- Check for secrets in git history is out of scope — focus on current source files.
- If you find a critical vulnerability, lead your findings with it and clearly mark it.

---

## Category: `ui`

**What to look for:**
- Hardcoded colors (e.g., `#3b82f6`, `rgb(...)`) instead of Tailwind theme tokens or CSS variables defined in `globals.css`
- Hardcoded sizes/spacing that bypass the Tailwind scale
- Missing dark mode support — components that only work in light mode or vice versa
- Accessibility gaps:
  - Missing `aria-label`, `aria-describedby`, or `role` attributes on interactive elements
  - Poor color contrast ratios (below WCAG AA 4.5:1 for text)
  - No keyboard navigation support (missing `tabIndex`, `onKeyDown` handlers)
  - Missing focus indicators
- Non-responsive layouts — components that break or overflow on mobile viewports
- Inconsistent component patterns — e.g., some buttons using Radix UI primitives while others are raw `<button>` with different styling
- Tailwind anti-patterns:
  - Excessive arbitrary values `w-[347px]` instead of design system values
  - Long class strings that should be extracted into component variants
  - Missing `sr-only` text for icon-only buttons

**Rules:**
- **Read `frontend/tailwind.config.ts` and `frontend/src/app/globals.css` first** to understand the project's design tokens and custom theme. Don't flag something as "wrong" if the project intentionally defines it.
- Evaluate Radix UI component usage for accessibility completeness — Radix provides primitives but they still need proper labeling.
- Prioritize issues that affect **usability** over aesthetics.
- Flag components that would break on mobile or with screen readers as high severity.

---

## Category: `docs`

**What to look for:**
- Discrepancies between `system_design/` documents (SD-001 through SD-006, GAP_WORKSTREAMS.md, ADR-001) and the actual codebase:
  - Data models described in docs that don't match database schemas or Rust structs
  - API endpoints described in docs that don't exist in route handlers, or vice versa
  - Workflow/architecture diagrams that describe a flow the code doesn't implement
  - Features listed as "implemented" in GAP_WORKSTREAMS.md that aren't actually in the code
- Stale code comments that describe behavior that has since changed
- README claims that don't match how to actually build/run the project

**CRITICAL RULE: If code and docs disagree, do NOT assume which is correct.**
- Flag the discrepancy clearly
- State exactly what the doc says (with file and section reference)
- State exactly what the code does (with file and line reference)
- Ask the user: "Which reflects the intended behavior — the doc or the code?"
- Do NOT silently "fix" either side or recommend a fix direction without asking

**Rules:**
- Prioritize docs that describe **APIs, data models, or workflows** — these cause the most confusion when stale.
- Low-priority: minor wording differences, formatting issues, or stylistic choices in docs.
- Check if `GAP_WORKSTREAMS.md` milestones match what's actually been implemented.
- For code comments, only flag ones that are **actively misleading** — not just outdated but harmless.

---

## Category: `perf`

**What to look for:**
- N+1 query patterns in Rust/SQLx — looping over results and issuing a query per item instead of batching
- Unnecessary React re-renders — large components without memo where parent re-renders frequently, missing `useMemo`/`useCallback` for expensive computations or callbacks passed as props
- Redundant API calls — fetching the same data multiple times across components instead of lifting state or caching
- Missing database indexes for columns used in WHERE/JOIN/ORDER BY clauses (check SQL migrations)
- Large bundle imports that could be tree-shaken or lazy-loaded (e.g., importing all of a library when only one function is needed)
- Blocking async operations that could be parallelized — sequential `await`s that are independent and could use `Promise.all` / `tokio::join!`
- Unnecessary `.clone()` in Rust where a borrow would suffice
- String allocations in hot paths — building strings in loops instead of using iterators

**Rules:**
- **Don't flag micro-optimizations.** Nobody cares about saving 2 microseconds in a startup routine.
- Focus on things that would **noticeably impact user experience** (page load, interaction latency) or **server costs at scale** (CPU, memory, database load).
- If a "slow" path is only hit during startup, admin operations, or one-off migrations, rank it low.
- Measure claims against actual usage patterns visible in route handlers — a query that runs once per deploy doesn't need an index.

---

## Category: `tests`

**What to look for:**
- Untested critical paths:
  - Authentication/authorization flows
  - Data mutations (create, update, delete operations)
  - Payment/billing logic (if any)
  - Data validation and sanitization
- Missing unit tests in frontend (currently the project has zero frontend unit tests)
- Missing error case coverage in e2e specs — do the existing `e2e/journeys/` tests cover failure modes or only happy paths?
- Test files that test implementation details (mocking internals) instead of behavior (testing inputs/outputs)
- No integration tests for API endpoints — are the Rust route handlers tested with actual HTTP requests?
- Missing edge case coverage — boundary values, empty inputs, concurrent operations

**Rules:**
- **Prioritize by blast radius** — untested code that handles auth, data deletion, or financial operations is critical. Untested UI animations are low.
- Note where adding a test would be **straightforward** (pure function, clear inputs/outputs) vs. requiring **significant refactoring** (tightly coupled, no dependency injection).
- Check if existing e2e tests in `e2e/journeys/` cover the happy paths of core user flows.
- Don't just say "add tests" — specify **what kind** of test (unit, integration, e2e), **what to assert**, and **where to put it**.
- If the project has no test infrastructure for a layer (e.g., no Jest/Vitest config for frontend), flag that as a high-severity infrastructure gap, not individual missing tests.
