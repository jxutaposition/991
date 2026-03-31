# Metrics

## Target
- **Client:Lele ratio: >2:1 per week**
- **Proactive engagement reply rate:** track to optimize message patterns

---

## Baseline (week of 2026-03-16–22, from Slack API)

Counted directly from Slack API across C0ABHP870SF + D0ACERJTXJQ, including thread replies.

- Bojana (C0ABHP870SF): 11 messages
- Cristina (C0ABHP870SF): 5 messages
- **Client total: 16**
- **Lele (D0ACERJTXJQ DM): 45 messages**
- **Ratio: 0.36:1** (for every client message, Lele sent 2.8 messages to the agent)

Top drivers of Lele-inbound volume:
- Long debugging sessions in DM threads (Clay column fixes, Supabase diagnosis, Creator URL formula) — ~5–10 messages per thread (~50% of Lele volume)
- Plan approval DMs required before every client task execution (~30%)
- Lele explicitly triggering work the agent could have picked up proactively (~20%)

---

## Weekly Message Log

| Week | Client msgs | Lele msgs | Ratio | Notes |
|------|-------------|-----------|-------|-------|
| 2026-W12 | 16 | 45 | 0.36 | baseline (from Slack API, Mar 16-22) |
| 2026-W13 | ~5 (Bojana launch confirm + reactions) | ~75 (across 3 sessions: 25+12+30+) | ~0.07 | heavy build week, minimal client interaction, 10 corrections |

---

## Thread Log (per resolved thread)

| Date | Thread-ID | Source | Tier | Autonomous? | Escalation reason | Gap type |
|------|-----------|--------|------|-------------|-------------------|----------|
| 2026-03-27 | T-005 | lele | — | — | Superseded by points framework | — |
| 2026-03-27 | T-R016 | lele | 3 | partial | first-time build, irreversible | context |
| 2026-03-27 | T-001 | lele | 3 | partial | OAuth2 requires manual consent popup | instruction |
| 2026-03-27 | T-003 | lele | 2 | yes (node built) | copy confirmation needed | context |
| 2026-03-27 | T-002 | lele | 2 | partial | source verification failure on 1-pager | context |

---

## Gap Log (per Trigger A/B correction)

| Date | Thread-ID | Gap type | Description | Fix applied |
|------|-----------|----------|-------------|-------------|
| 2026-03-27 | T-001 | instruction | G17/G21: Proposed channel.ts change twice despite correction -- correction not propagated across subagent boundary | Partial (thread re-read rule added); full fix pending (correction propagation) |
| 2026-03-27 | T-003 | context | G18: Asked Bojana for copy already in thread history | Yes (hard gate in slack/SKILL.md Section 4) |
| 2026-03-27 | T-002 | context | G19: 1-pager used generic benefits instead of verified cash prizes from Bojana's Notion doc | Yes (source verification signal in planning.md) |
| 2026-03-27 | T-010 | context | G20: Referenced thread without Slack URL | Yes (slack/SKILL.md Section 8 rule) |
| 2026-03-27 | plans | instruction | G22: New plan DMs for topics with existing open threads | Pending |
| 2026-03-27 | refs | context | G23: Vague references without clickable Slack URLs | Pending |
| 2026-03-27 | T-005 | context | G24: Operated on stale tiering framework (superseded by points) | Pending |
| 2026-03-27 | browser | instruction | G25: Browser sessions left open after tasks | Yes (RULE-006 + cleanup script) |
| 2026-03-27 | T-014 | instruction | G26: No mechanism to resurface blocked threads after >1 day | Pending |

Gap types: `context` (fact was in Slack but not captured) | `inference` (agent guessed from incomplete signals) | `instruction` (use-case spec didn't cover this case)

---

## Engagement Pattern Log (proactive messages)

| Date | Thread-ID | Message type | Got reply? | Notes |
|------|-----------|-------------|-----------|-------|

Message types: `concrete-deliverable` | `status-update` | `blocker-flag` | `short-question`

---

## Pattern Analysis

*Updated each audit run.*

Escalation reasons this period: idle loop (T-015), channel.ts restart (T-015), OAuth2 manual consent (T-001), copy approval (T-003)
Open gap types (gap_closed=no): inference x2 (G27 idle loop, G32 multi-step continuation), instruction x7 (G21 correction propagation, G22 thread dedup, G26 blocked resurfacing, G29 message queue check, G30 channel.ts restart docs, G31 feedback file rule, G33 warm re-entry), context x2 (G23 URL refs, G24 stale knowledge sweep)
Proactive reply rate: 0% (0 proactive messages to clients across all sessions to date)

---

## Session: 2026-03-24/25 (creators + T-001 + T-002 + CLAUDE.md)

| Date | Tasks completed | User msgs | Gap msgs | Ratio | Subagent tasks | Subagent autonomous rate | Top gap type |
|------|----------------|-----------|----------|-------|----------------|--------------------------|--------------|
| 2026-03-24/25 | 4 partial (creators plan sent, T-001 logged, T-002 1-pager drafted, CLAUDE.md updated) | ~25 | ~12 | 0.48 | 2 (sequential, corrected) | 0/2 | inference |

### 2026-03-24/25 Stats
```
reads: ~15 total, ~12 unique, ~3 re-reads (secrets.md x2, threads.md x2), ~1 dead (learn.md not read until end)
slack: ~5 loads, channels: C0ABHP870SF, D0ACERJTXJQ, late_load: yes (T-001/T-002 context loaded after execution began)
playwright_steps: ~8 (nav:3 click:2 screenshot:2 evaluate:1) | browser_mcp_steps: ~4 (nav:2 click:2)
bash: ~6 total, 1 error (n8n API), 0 stuck loops
writes: 3 | edits: 8 | direction_changes: 4
subagents: 2 launched, results_used: 1/2, autonomous_completion: 0/2
mcp_calls: ~12 (slack:6 browser_mcp:4 playwright:4)
```

### 2026-03-24/25 Gap Log

| Date | Gap | Gap type | Root cause | Description | Fix applied |
|------|-----|----------|------------|-------------|-------------|
| 2026-03-24 | G1 | inference | Wrong inference | Navigated to Expert Points Lovable project instead of Social Listening — guessed from task context | L-001 in lessons.md; entity-resolve gate in CLAUDE.md |
| 2026-03-24 | G2 | instruction | Incomplete instruction | Skipped planning.md protocol, went straight to execution | L-002 in lessons.md; mandatory entity-resolution gate added |
| 2026-03-24 | G3 | inference | Wrong inference | Assigned Tier 2 without verifying column names against Clay access JSON schema | Column-resolution gate added to Step 6 of planning.md |
| 2026-03-24 | G4 | instruction | Incomplete instruction | Plan DM used Unicode bullets/dashes instead of plain text | Plain-text-only rule added to Step 8 of planning.md |
| 2026-03-24 | G5 | context | Missing context | Plan DM showed raw table IDs — no rule existed to require clickable URLs | Clickable URL rule added to Step 8 of planning.md |
| 2026-03-24 | G6 | context | Missing context | Missing Supabase step from plan — not documented that Clay and Supabase are separate | Added to secrets.md; step added to creator pipeline docs |
| 2026-03-24 | G7 | instruction | Incomplete instruction | learn.md never triggered after corrections — no auto-fire mechanism exists | learn skill only fires on explicit invoke; no structural fix yet — propose below |
| 2026-03-24 | G8 | instruction | Incomplete instruction | Subagents launched sequentially instead of in parallel | Parallelism rule added to CLAUDE.md |
| 2026-03-24 | G9 | context | Missing context | T-001 workflow state not logged — was built but context file said "not built" | n8n.md and threads.md updated with actual workflow state |
| 2026-03-24 | G10 | context | Missing context | n8n API 404 on Personal project workflow — projectId scoping not documented | Added to skills/n8n/SKILL.md: Personal project requires ?projectId=personal |

### 2026-03-24/25 Thread Log

| Date | Thread-ID | Source | Tier | Autonomous? | Escalation reason | Gap type |
|------|-----------|--------|------|-------------|-------------------|----------|
| 2026-03-24 | creators-comparison | lele | 3 | partial | column name unresolved, Supabase step unknown | inference + context |
| 2026-03-24 | T-001 | lele | 3 | partial | workflow state unknown | context |
| 2026-03-24 | T-002 | lele | 3 | partial | Notion URL unknown | context |
| 2026-03-25 | T-001 | proactive | 3 | no | publish irreversible | — |
| 2026-03-25 | T-004 | proactive | 1 | partial | wrong dashboard (inference gap) | inference |
| 2026-03-25 | T-002 | proactive | 1 | partial | blocker resolved via secrets.md | context |

### 2026-03-25 Session Stats
reads: 15 total, 12 unique, 3 re-reads (log.md ×3, secrets.md ×2, threads.md ×2), 1 dead (linkedin-post-points.md borderline)
slack: 1 DM sent, 1 fetch attempted (interrupted), late_load: no
browser_mcp_steps: ~18 (navigate:4, screenshot:8, read_page:2, computer:4)
bash: 2 total, 0 errors
writes: 2 | edits: 7 | direction_changes: 2
subagents: 1 launched (wrong repo — result unused), autonomous_completion: 0/1
mcp_calls: 3 (slack: send_dm ×1, fetch_channel ×1 interrupted)

### 2026-03-25 Gap Log
| Date | Session | Gap type | Root cause | Description | Fix applied | Predicted impact |
|------|---------|----------|------------|-------------|-------------|-----------------|
| 2026-03-25 | proactive | G11 | inference | Wrong Lovable project (Social Listening vs Expert Points) for T-004 | Disambiguation rule added to planning.md Step 4 | Eliminates wrong-project class of errors |
| 2026-03-25 | proactive | G12 | context | T-002 asserted blocked on service role key; secrets.md had been updated | Rule added to proactive.md: re-read secrets.md before asserting credential blocker | Eliminates stale-blocker assertions |
| 2026-03-25 | proactive | G13 | instruction | Subagent sent to local repo to find Lovable code (not there) | Rule added to planning.md: Lovable source is editor-only, not local git | Prevents wasted subagent delegation for Lovable tasks |

---

## Session: 2026-03-26 (Slack skill restructure)

| Date | Tasks completed | User msgs | Gap msgs | Ratio | Subagent tasks | Subagent autonomous rate | Top gap type |
|------|----------------|-----------|----------|-------|----------------|--------------------------|--------------|
| 2026-03-26 | 1 completed (skills/slack/SKILL.md + restructure), 1 interrupted (T-003 proactive) | ~12 | ~5 | — | 2 (1 explore used, 1 general rejected) | 0/2 | instruction |

### 2026-03-26 Stats
```
reads: 12 total, 10 unique, 0 re-reads, 0 dead
slack: 0 MCP calls (server disconnected)
browser_mcp_steps: 0
bash: 0
writes: 2 new files | edits: 8 | direction_changes: 3
subagents: 2 launched, results_used: 1/2, autonomous_completion: 0/2
mcp_calls: 0
```

### 2026-03-26 Gap Log
| Date | Session | Gap type | Root cause | Description | Fix applied | Predicted impact |
|------|---------|----------|------------|-------------|-------------|-----------------|
| 2026-03-26 | restructure | G14 | inference | Proposed Slack skill with wrong tool params before reading channel.ts source | Pending approval | Prevents wrong-param documentation; 2 plan rejections avoided |
| 2026-03-26 | restructure | G15 | instruction | First plan patched planning.md only; didn't recognize CLAUDE.md routing needed redesign | Pending approval | Ensures platform skill additions always include routing layer check |
| 2026-03-26 | restructure | G16 | instruction | Ran proactive work after corrections without running learn first | Pending approval | Ensures learn fires automatically after any session with corrections |

---

## Session: 2026-03-27 (full day — T-001, T-003, T-002, 1-pager, logging audit, voice principles, LinkedIn posts, 19 creators, daily briefing redesign, message sweep, system self-improvement)

| Date | Tasks completed | User msgs | Gap msgs | Ratio | Subagent tasks | Subagent autonomous rate | Top gap type |
|------|----------------|-----------|----------|-------|----------------|--------------------------|--------------|
| 2026-03-27 | ~12 tasks (T-001 test+credential, T-003 Calendly node, T-002 1-pager+Notion, T-005 resolved, 1-pager style guide+voice principles, logging audit fixes 1-3, T-R016 19 creators executed, LinkedIn 5 posts drafted, daily briefing skill redesign, message sweep 67 msgs, browser cleanup, system self-improvement overnight) | ~30+ | ~10 | 0.33 | ~20+ | ~15/20 (75%) | context |

### 2026-03-27 Stats (full session)
```
reads: ~40 total, ~25 unique, ~8 re-reads (threads.md x4, log.md x3, CLAUDE.md x2, secrets.md x2), ~3 dead
slack: ~30 MCP calls (send_dm ~8, reply ~10, fetch_thread ~5, fetch_channel ~4, add_reaction ~3), channels: C0ABHP870SF, D0ACERJTXJQ, C0ANG5HB2N8, late_load: no
browser_mcp_steps: ~35 (navigate:~10, screenshot:~8, click:~6, fill:~4, read_page:~4, evaluate:~3)
bash: ~15 total, ~3 errors (python3 not found, UTF-8 encoding, stop hook), 2 retry_sequences, 0 stuck_loops
writes: ~8 | edits: ~25 | direction_changes: ~5
subagents: ~20 launched, results_used: ~18/20, autonomous_completion: ~15/20
mcp_calls: ~80 (slack:~30, browser_mcp:~35, notion:~5, n8n:~8, bash:~15)
```

### 2026-03-27 Gap Log
| Date | Session | Gap type | Root cause | Description | Fix applied | Predicted impact |
|------|---------|----------|------------|-------------|-------------|-----------------|
| 2026-03-27 | T-001 | G17 | instruction | Proposed channel.ts modification when prior Lele instruction (in thread context) said "don't change channel.ts" — repeated TWICE | Added thread context re-read rule to planning.md Step 1 + proactive.md | Eliminates "contradicts prior instruction" class of errors |
| 2026-03-27 | T-003 | G18 | context | Sent redundant copy request to client without reading thread history — Bojana had already provided the welcome message copy | Added hard gate to slack/SKILL.md Section 4: verify answer not already in thread before asking | Eliminates "asking for info already provided" class of errors |
| 2026-03-27 | T-002 | G19 | context | 1-pager used generic "Premium Partner" benefits instead of verified cash prize data from Bojana's Notion doc | Added source verification signal to planning.md confidence check | Prevents unverified factual claims in deliverables |
| 2026-03-27 | T-010 | G20 | context | Referenced T-010 thread without providing Slack message URL | Fixed via slack/SKILL.md Section 8 rule (already applied) | Ensures all thread references include clickable links |
| 2026-03-27 | T-001 | G21 | instruction | Proposed channel.ts change a SECOND time after being corrected — prior correction not retained across subagent boundary | Pending | Agent must check correction history before re-proposing a rejected approach |
| 2026-03-27 | plans | G22 | instruction | Sent new plan DMs for topics that already had open threads with plans — created redundant threads instead of replying in existing ones | Pending | Always search for existing thread before creating new plan DM |
| 2026-03-27 | refs | G23 | context | Said "which open question?" without linking to the specific Slack thread — vague references force Lele to look it up | Pending | Every reference to a prior conversation must include a clickable Slack URL |
| 2026-03-27 | T-005 | G24 | context | Operated on stale knowledge — tiering framework replaced by points framework, agent didn't know | Pending | Write decisions/supersessions to threads.md immediately when learned |
| 2026-03-27 | browser | G25 | instruction | Left browser sessions open after completing tasks — accumulated resource leak | RULE-006 added + cleanup-browsers.sh created | Ensures browser cleanup after every task |
| 2026-03-27 | T-014 | G26 | instruction | No mechanism to resurface threads blocked on Lele for >1 day | Pending | Add blocked-item resurfacing to proactive/SKILL.md Mode A |

### 2026-03-27 Thread Log
| Date | Thread-ID | Source | Tier | Autonomous? | Escalation reason | Gap type |
|------|-----------|--------|------|-------------|-------------------|----------|
| 2026-03-27 | T-001 | lele | 3 | partial | OAuth2 credential requires manual UI click | instruction |
| 2026-03-27 | T-003 | lele | 2 | yes (node built, test sent) | copy confirmation needed | context |
| 2026-03-27 | T-002 | lele | 2 | partial | 1-pager corrected after source verification failure | context |
| 2026-03-27 | T-005 | lele | 1 | yes | resolved — superseded by points | context |
| 2026-03-27 | T-R016 | lele | 3 | partial | first-time build, irreversible | context |
| 2026-03-27 | T-012 | lele | 1 | yes (thread created) | evaluation thread | — |
| 2026-03-27 | T-013 | lele | 2 | yes (voice.md created) | awaiting dissolution decision | — |
| 2026-03-27 | T-014 | lele | 2 | partial | overnight work completed, suggestions pending | instruction |
| 2026-03-27 | logging-audit | lele | 2 | partial | 3 of 8 fixes applied, rest pending | instruction |
| 2026-03-27 | linkedin-posts | lele | 2 | yes | 5 drafts created | — |
| 2026-03-27 | message-sweep | lele | 1 | yes | 67 messages audited | — |
| 2026-03-27 | daily-briefing | lele | 2 | yes | skill redesigned | — |

---

## Session: 2026-03-28 (voice mode checkpoints 1-3, WS reconnect fix, stop hook cooldown, daily briefing restructure, changes.md YAML, T-003 test DM, T-009 enrichment plan, broken briefing links, thread resurfacing)

| Date | Tasks completed | User msgs | Gap msgs | Ratio | Subagent tasks | Subagent autonomous rate | Top gap type |
|------|----------------|-----------|----------|-------|----------------|--------------------------|--------------|
| 2026-03-28 | ~8 tasks (T-015 checkpoints 1-3, WS reconnect fix, stop hook cooldown, changes.md YAML format, T-003 test DM to Bojana, T-009 enrichment plan, broken briefing links fix, thread resurfacing) | ~15 | ~8 | 0.53 | ~8 | ~5/8 (63%) | inference |

### 2026-03-28 Stats
```
reads: ~25 total, ~18 unique, ~5 re-reads (threads.md x2, CLAUDE.md x2, channel.ts x2), ~2 dead (brief.md, people.md mandatory reads)
slack: ~15 MCP calls (send_dm ~5, reply ~6, fetch_thread ~2, add_reaction ~2), channels: D0ACERJTXJQ, C0ABHP870SF, D0ADFSKT8TG, late_load: no
browser_mcp_steps: ~5 (minimal — voice mode was code-only)
bash: ~20 total, ~4 errors (channel.ts restart, python3 not found, WS issues), 2 retry_sequences, 1 stuck_loop (infinite idle)
writes: ~6 | edits: ~15 | direction_changes: 2
subagents: ~8 launched, results_used: ~6/8, autonomous_completion: ~5/8
mcp_calls: ~45 (slack:~15, bash:~20, browser:~5, other:~5)
```

### 2026-03-28 Gap Log
| Date | Session | Gap type | Root cause | Description | Fix applied | Predicted impact |
|------|---------|----------|------------|-------------|-------------|-----------------|
| 2026-03-28 | T-015 | G27 | inference | Infinite idle loop — agent responded "confirmed" hundreds of times instead of working T-015 which was IN-PROGRESS and unblocked | Pending | Eliminates idle-loop-when-work-exists failure class |
| 2026-03-28 | system | G28 | instruction | Stop hook had no cooldown, enabling infinite re-trigger loop | Yes (5-min cooldown added) | Mechanical safety net for idle loops |
| 2026-03-28 | system | G29 | instruction | Queued Slack messages missed during idle loop — agent didn't check for pending messages before proactive work | Pending | Ensures messages always preempt proactive work |
| 2026-03-28 | T-015 | G30 | instruction | Agent couldn't restart channel.ts to activate checkpoint 3 code — no documented mechanism for self-restart | Pending | Prevents assumption that code changes are active without restart |
| 2026-03-28 | system | G31 | instruction | Feedback memory files created instead of direct skill file edits — learn skill already prohibits this | Pending | Eliminates orphaned feedback files |
| 2026-03-28 | T-015 | G32 | inference | Agent declared idle after checkpoint 3 instead of proceeding to checkpoint 4 work — multi-step thread treated as single task | Pending | Multi-step threads progress faster |
| 2026-03-28 | system | G33 | instruction | Proactive mode re-scans all threads instead of resuming last-worked thread on stop hook re-entry | Pending | Eliminates wasted context from re-scanning |

### 2026-03-28 Thread Log
| Date | Thread-ID | Source | Tier | Autonomous? | Escalation reason | Gap type |
|------|-----------|--------|------|-------------|-------------------|----------|
| 2026-03-28 | T-015 | lele | 2 | partial | checkpoints 1-3 built, restart blocked | inference |
| 2026-03-28 | T-003 | lele | 2 | yes (test DM sent to Bojana) | awaiting client confirmation | — |
| 2026-03-28 | T-009 | lele | 1 | yes (plan drafted) | enrichment plan ready | — |
| 2026-03-28 | system | lele | 2 | partial | stop hook cooldown, WS fix, briefing links | instruction |
| 2026-03-27 | message-sweep | lele | 1 | yes | 67 messages audited | — |
| 2026-03-27 | daily-briefing | lele | 2 | yes | skill redesigned | — |
