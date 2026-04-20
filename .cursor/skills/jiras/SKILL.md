---
name: jiras
description: >-
  Drafts repo-local JIRA-style work items as markdown under jiras/. Use when
  the user says /jiras, asks for a JIRA ticket, LELE ticket, backlog item, or
  wants work tracked next to existing jiras/*.md files.
---

# Jiras — repo-local JIRA tickets

## Purpose

`jiras/` holds **design and backlog markdown** that mirrors JIRA-style tickets (e.g. `LELE-016_...md`). The agent should **create or extend** these files using the project’s conventions—not paste into external JIRA unless the user asks.

## When to apply

- User invokes **`/jiras`** or asks for a **ticket**, **LELE-XXX**, **backlog item**, or **jira** in this repo.
- User describes technical follow-up (refactors, migrations, restore OpenAI embeddings, model renames, etc.) that should be **tracked in git**.

## File naming

1. List `jiras/*.md` and pick the next id:
   - Prefer **`LELE-###`** for product/engineering work (increment highest `LELE-###` found).
   - Use another prefix only if an existing pattern applies (e.g. `CORPUS-001_...`).
2. Slug: short **`snake_case`** description, ASCII, no spaces.
3. Full name: `jiras/LELE-###_short_description.md`

Example: `jiras/LELE-023_restore_openai_embeddings_ingestion.md`

## Document template

Match the tone and structure of existing tickets (see `jiras/LELE-016_known_tech_debt_hardening.md`).

```markdown
# LELE-###: <Short title>

## Problem
<What is wrong, missing, or deferred? One tight paragraph.>

## Context (optional)
<Bullet list: relevant files, env vars, prior decisions, user-visible impact.>

## Proposed approach
<How to fix or what to explore. Keep concrete; avoid vague “improve”.>

## Acceptance Criteria
- [ ] <Verifiable outcome 1>
- [ ] <Verifiable outcome 2>
- [ ] <Docs/env/example updates if needed>
```

Use **`### Issues`** subsections with **bold file paths** when the ticket bundles multiple separable items (like LELE-016).

## Content rules

- **No secrets**: Never paste API keys, tokens, or real connection strings; reference env var **names** only.
- **Actionable criteria**: Each checkbox should be testable (command, behavior, or review).
- **Scope**: One primary theme per file; split if the user asks for unrelated work.
- **Link code sparingly**: Use backticked paths like `ingestion/embedder.py`, not long dumps.

## After writing

- If the user uses Cursor rules for this repo, remind them to open a real JIRA issue **only if** they want tracker sync; the markdown file is the repo source of truth for the spec.
