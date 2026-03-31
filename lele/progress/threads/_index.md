# Thread Index

<!--
FORMAT
## [THREAD-ID] [title]
Status: OPEN | IN-PROGRESS | AWAITING_CLIENT | AWAITING_LELE | RESOLVED
Priority: high | medium | low
Source: client | lele | agent
Channel: slack channel ID | notion URL | —
Thread-ts: [slack URL or —]  <- always use full Slack URL: https://woshi.slack.com/archives/{channel}/p{ts_without_dot}
Last-proactive: [YYYY-MM-DD or —]
Context: [timestamped, sourced entries — see rules below]
Next step: [specific executable action or what we're waiting on]
<!-- resolved YYYY-MM-DD: [outcome summary] -->

CONTEXT FIELD RULES:
Every addition to Context MUST be prefixed with date and source:
  [YYYY-MM-DD source] fact or decision.

Source values:
  lele(url)    — Lele said it. url = Slack message URL or ts.
  client(url)  — Bojana/Cristina said it. url = Slack message URL or ts.
  bot(url)     — Bot sent/did it. url = Slack message URL or ts.
  agent        — Agent discovered it (no Slack message, e.g. from research or tool output).

Examples:
  [2026-03-27 lele(https://woshi.slack.com/archives/D0ACERJTXJQ/p1774532209998449)] Do NOT change channel.ts.
  [2026-03-27 client(https://woshi.slack.com/archives/C0ABHP870SF/p1774537130328269)] Bojana: "lets launch after Tuesday call."
  [2026-03-27 bot(https://woshi.slack.com/archives/D0ACERJTXJQ/p1774581022586299)] Test DM sent to Lele.
  [2026-03-27 agent] Test CSV created with 5 real partners.

THREAD-TS RULE:
Always use full Slack URL, never raw ts. Format: https://woshi.slack.com/archives/{channel}/p{ts_without_dot}
If channel is unknown for a Thread-ts, use the raw ts temporarily and fix when channel is identified.

CREDENTIAL RULE:
Never include credentials (API keys, tokens, passwords) inline. Reference client/access/secrets.md instead.
-->

---

## Active Threads

| ID | Title | Status | Priority | Blocked-on |
|----|-------|--------|----------|------------|
| [T-001](T-001.md) | Tolt CSV → group reassignment workflow | AWAITING_LELE | high | lele |
| [T-002](T-002.md) | Expert Points Lovable — empty Supabase DB | AWAITING_LELE | high | lele |
| [T-003](T-003.md) | Calendly link in Slack welcome message + email | AWAITING_CLIENT | high | client |
| [T-004](T-004.md) | Weekly dashboard tab (Mon–Wed) not updated | AWAITING_LELE | high | lele |
| [T-006](T-006.md) | 30-day activation program | AWAITING_CLIENT | medium | client |
| [T-007](T-007.md) | Reintroduce 30-min 1:1 onboarding calls | AWAITING_CLIENT | medium | client |
| [T-008](T-008.md) | Tag 70+ onboarded experts in Tolt | AWAITING_CLIENT | medium | client |
| [T-009](T-009.md) | Cross-check Clay vs Notion; collect missing email/LinkedIn/Tolt for 14 experts | AWAITING_LELE | medium | lele |
| [T-011](T-011.md) | Align with Success on social listening data needs | AWAITING_CLIENT | low | client |
| [T-012](T-012.md) | Context field compression + thread file splitting evaluation | AWAITING_LELE | medium | lele |
| [T-013](T-013.md) | Voice principles — me/principles/voice.md | AWAITING_LELE | medium | lele |
| [T-014](T-014.md) | System self-improvement — autonomous context/skill optimization + blocked-item resurfacing | AWAITING_LELE | high | lele |
| [T-015](T-015.md) | Voice mode — ElevenLabs TTS/STT for Slack DMs | AWAITING_LELE | medium | lele |
| [T-016](T-016.md) | Bojana: "received it from Umer — was that you?" | AWAITING_CLIENT | medium | client |
| [T-017](T-017.md) | Replace LinkedIn company page data source with mention-in-content tracking | AWAITING_CLIENT | high | client |

## Archived Threads

| ID | Title | Status | Priority | Blocked-on |
|----|-------|--------|----------|------------|
| [T-005](_archive/T-005.md) | Expert program tiering — tier thresholds | RESOLVED | — | — |
| [T-010](_archive/T-010.md) | Open questions Notion doc | ABANDONED | — | — |
| [T-R001](_archive/T-R001.md) | NDA | RESOLVED | — | — |
| [T-R002](_archive/T-R002.md) | Tolt + Typeform access | RESOLVED | — | — |
| [T-R003](_archive/T-R003.md) | HR API / subscription data per expert | RESOLVED | — | — |
| [T-R004](_archive/T-R004.md) | Revenue scoring model | RESOLVED | — | — |
| [T-R005](_archive/T-R005.md) | MRR visibility on dashboard | RESOLVED | — | — |
| [T-R006](_archive/T-R006.md) | Experts-only dashboard filter | RESOLVED | — | — |
| [T-R007](_archive/T-R007.md) | Waitlist decision | RESOLVED | — | — |
| [T-R008](_archive/T-R008.md) | Premium partner badge in Lovable | RESOLVED | — | — |
| [T-R009](_archive/T-R009.md) | Data sync question | RESOLVED | — | — |
| [T-R010](_archive/T-R010.md) | Social listening homepage — no data | RESOLVED | — | — |
| [T-R011](_archive/T-R011.md) | Creator data missing in Lovable /creators tab | RESOLVED | — | — |
| [T-R012](_archive/T-R012.md) | Experts missing email — status cross-check | RESOLVED | — | — |
| [T-R013](_archive/T-R013.md) | Creators table + social listening webhook conditional | RESOLVED | — | — |
| [T-R014](_archive/T-R014.md) | Email Andreas re: HubSpot deferral | RESOLVED | — | — |
| [T-R015](_archive/T-R015.md) | Content calendar / campaign send strategy | RESOLVED | — | — |
| [T-R016](_archive/T-R016.md) | Add 19 missing creators to Clay + Supabase + dashboard | RESOLVED | — | — |
