# Use Case: Automation / Workflow

**Tools:** all, including browser automation, API calls

Handles execution only. Planning is handled by `skills/planning/SKILL.md` before this file is reached.

---

## What this covers

Any change request in Clay, Tolt, Notion, n8n, Lovable, or Typeform. Anything that writes to an external tool.

---

## Execution

### 1. Before any API call

Check `skills/{service}/resources/api-reference.md`. If it doesn't exist: look up the docs (WebFetch or browser), write the reference file, then proceed.

Get credentials from `client/heyreach/access/secrets.md` or `client/heyreach/access/{service}.md`. Never hardcode keys. After using a new API successfully, update the access file with any IDs or discoveries.

### 2. Tool-specific navigation

**Clay:** read `client/heyreach/access/secrets.md` → browser navigate → wait for SPA load → snapshot. Use browser evaluate if snapshot isn't enough.

Before designing any Clay table structure, lookup, enrichment column, or send-to-table action:
- Read the "Important Notes" sections in the relevant Clay sub-skill files
- Design against those constraints before proposing anything
- If a Clay workaround required more than one attempt, add it to the sub-skill's "Important Notes" after

**Other tools:** follow the same navigate → wait → snapshot pattern. Read access notes in `client/access/{tool}.md` first.

### 3. Execute

Run the task. If anything errors mid-execution: stop, do not retry blindly. DM Lele per `skills/slack/SKILL.md` with what was attempted, what failed, and the current state.

### 4. Produce

Outcome summary + links for logging under the relevant thread in `progress/threads/T-{NNN}.md` and `progress/log.md`.
