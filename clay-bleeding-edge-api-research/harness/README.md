# Research Harness

Infrastructure for deploying agents to probe Clay's APIs and DOM.

## Structure

```
harness/
├── prompts/           # Structured prompts for agent sessions
│   ├── cdp-discovery.md
│   ├── endpoint-probe.md
│   ├── dom-mapping.md
│   ├── schema-roundtrip.md
│   └── capability-expansion.md
├── scripts/           # Runnable Playwright/CDP scripts
│   ├── intercept-clay-api.ts
│   ├── extract-session.ts
│   ├── probe-endpoint.ts
│   └── export-table-schema.ts
├── fixtures/          # Test data
│   └── sample-schemas/
└── results/           # Probe output directory
```

## How to Use

### For Agent Deployment

1. Pick a prompt from `prompts/` that matches the investigation type
2. Feed it to an agent along with `../AGENT.md`
3. The agent reads the prompt, executes the investigation, writes findings

### For Manual Probing

1. Run a script from `scripts/` with the appropriate parameters
2. Results are written to `results/`
3. Review and promote findings to `../registry/` and `../investigations/`

## Prerequisites

- Playwright installed (available in `../../e2e/node_modules/`)
- An authenticated Clay session (or credentials for automated login)
- A scratch Clay table for write-operation testing

## Scripts

| Script | Purpose | Auth Required |
|--------|---------|---------------|
| `intercept-clay-api.ts` | Intercept all api.clay.com traffic via CDP | Session (browser) |
| `extract-session.ts` | Authenticate and extract session cookies | Login credentials |
| `probe-endpoint.ts` | Test a specific endpoint with payloads | Session cookies |
| `export-table-schema.ts` | Export a table schema via v3 API | Session cookies |
