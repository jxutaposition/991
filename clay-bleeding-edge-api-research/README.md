# Clay Bleeding-Edge API Research

A structured research project to reverse-engineer, document, and build a proprietary server-side API layer for Clay (the GTM enrichment platform at clay.com). Clay has no official public API for structural operations. This project systematically maps what exists, discovers what's possible, and designs the integration layer.

## Goal

Build a proprietary "API" that gives the Lele agent full programmatic read/write/configure access to Clay tables -- creating columns, configuring enrichments, managing webhooks, reading schemas, and debugging formulas -- all server-side, without requiring a human in the Clay UI.

## Current Status (updated 2026-04-05, post INV-006 + INV-007)

| Layer | Coverage | Notes |
|-------|----------|-------|
| Official v1 API (API key) | Partial | Row CRUD, enrichment triggers, table metadata. Already used via `http_request` tool. |
| Internal v3 API (session cookie) | **37 endpoints confirmed** | Full table CRUD, field CRUD, source CRUD, table listing, actions catalog, imports/exports. Session cookie = `claysession` on `.api.clay.com` (7-day Express session). |
| Playwright DOM automation | Not started | Formula bar reading, error detection. Reduced need now that v3 covers most operations. |
| CDP network interception | Partially replaced | INV-006 used unauthenticated enumeration instead of CDP to map the v3 surface. CDP still useful for discovering response shapes during UI interactions. |

**Important**: When updating any file in this project, ensure ALL related files (knowledge/, registry/, architecture/) are also updated. Stale claims (e.g., listing a confirmed endpoint as "unknown") create confusion for deployed agents. The single source of truth for endpoint status is `registry/endpoints.jsonl`. All other files should reference or align with it.

## Quick Reference

| What | Where |
|------|-------|
| Iterative progress log | [timeline/](timeline/) |
| Everything we know about Clay's APIs | [knowledge/](knowledge/) |
| System design for the proprietary API layer | [architecture/](architecture/) |
| Endpoint registry and capability matrix | [registry/](registry/) |
| Agent-deployable probing infrastructure | [harness/](harness/) |
| Individual research threads | [investigations/](investigations/) |

## How to Deploy an Agent

1. Point the agent at this folder
2. Have it read [AGENT.md](AGENT.md) first
3. It will check [registry/gaps.md](registry/gaps.md) for open research questions
4. It picks a gap, probes it using the harness scripts/prompts, writes findings to `investigations/`
5. It updates `registry/endpoints.jsonl` and `registry/capabilities.md` with new discoveries

## Folder Map

```
clay-bleeding-edge-api-research/
├── README.md                       # This file
├── AGENT.md                        # Instructions for deployed agents
├── timeline/                       # Iterative progress: what we know, can do, can't do
│   └── YYYY-MM-DD_slug.md         # One entry per research session
├── knowledge/                      # Persistent documentation of everything known
│   ├── landscape.md                # Full landscape: official vs unofficial vs bleeding-edge
│   ├── official-api.md             # v1 API reference
│   ├── internal-v3-api.md          # Reverse-engineered v3 API
│   ├── webhooks.md                 # Webhook capabilities, limits, patterns
│   ├── authentication.md           # Auth mechanics per layer
│   ├── claymate-analysis.md        # Full Claymate Lite source analysis
│   ├── third-party-tools.md        # Community tools and integrations
│   └── clay-dom-structure.md       # DOM selectors, React SPA structure
├── architecture/                   # Design docs for the proprietary API layer
│   ├── system-design.md            # Four-layer stack architecture
│   ├── session-management.md       # Cookie extraction, storage, refresh
│   ├── tool-specifications.md      # New agent tool definitions
│   ├── risk-assessment.md          # ToS, stability, fallback strategies
│   └── integration-plan.md         # Integration with existing clay_operator
├── registry/                       # Structured endpoint/capability tracking
│   ├── endpoints.jsonl             # Machine-readable endpoint registry
│   ├── capabilities.md             # What can we do vs. what we can't
│   ├── gaps.md                     # Open research questions (prioritized)
│   └── changelog.md                # Timestamped discovery log
├── harness/                        # Agent-deployable probing infrastructure
│   ├── README.md                   # How to run probes
│   ├── prompts/                    # Structured prompts for agent sessions
│   ├── scripts/                    # Runnable Playwright/CDP scripts
│   ├── fixtures/sample-schemas/    # Test data for probing
│   └── results/                    # Output directory for probe results
└── investigations/                 # Individual research threads
    ├── _index.md                   # Index of all investigations
    └── INV-XXX_*.md                # One file per investigation
```

## Relationship to Main Codebase

This folder is a **research project** -- it does not modify the main `backend/` or `frontend/` code. When findings are ready for promotion to production:

- New Clay API client code goes to `backend/src/clay_api.rs`
- New tool definitions go to `backend/tools/clay/actions.toml`
- Updated agent prompts go to `backend/agents/clay_operator/prompt.md`
- Updated knowledge goes to `backend/agents/clay_operator/knowledge/clay-reference.md`

The promotion path is documented in [architecture/integration-plan.md](architecture/integration-plan.md).
