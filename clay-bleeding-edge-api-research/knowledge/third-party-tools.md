# Third-Party Clay Tools and Integrations

Last updated: 2026-04-05

## Claymate Lite

- **Source**: [github.com/GTM-Base/claymate-lite](https://github.com/GTM-Base/claymate-lite)
- **License**: MIT
- **Type**: Chrome extension (Manifest V3)
- **Author**: GTM-Base community
- **Status**: Active, 22+ stars

Copy/paste Clay table schemas between tables. Export column structure as JSON, import into another table. The lite version of a larger (presumably paid) Claymate product.

**Why it matters**: The source code reveals Clay's internal v3 API endpoints and authentication mechanism. See [claymate-analysis.md](claymate-analysis.md) for full analysis.

## Claymate (Full Version)

The full Claymate product (beyond the lite open-source version) reportedly includes:
- Full table backup/export (column configs AND values)
- Feeding table snapshots to Claude Code for workflow generation
- Cloud storage of table schemas

Details are sparse. The full version may be a paid product from GTM-Base or a related entity.

## clay-mcp-bridge (bleed-ai)

- **Status**: Reported to exist (April 2026), but no public repo or npm package found in our research
- **Author**: Reportedly bleed-ai / Robert Jett
- **Type**: MCP server for Clay GTM

An MCP server attempting to bridge agent access to the Clay GTM platform. Very new, sparse documentation. Worth monitoring but not yet usable.

**Note**: Our web searches did not find a published npm package or GitHub repo under this exact name. BleedAI appears to be an AI outbound/GTM services company. This may be a private/internal tool or may have been announced but not yet released.

## @clayhq/clay-mcp (Official Clay Personal CRM MCP)

- **Source**: [github.com/clay-inc/clay-mcp](https://github.com/clay-inc/clay-mcp)
- **npm**: `@clayhq/clay-mcp`
- **Hosted**: `https://mcp.clay.earth/mcp`
- **Type**: MCP server

**THIS IS FOR THE PERSONAL CRM (clay.earth), NOT THE GTM PLATFORM (clay.com).**

Capabilities:
- Contact search (by title, company, location, keywords)
- Interaction search
- Contact statistics
- Contact detail by ID
- Add contacts
- Notes (add, retrieve)
- Groups (list, create, update)
- Events (meetings/events in date range)

**Not relevant to our use case** but important to disambiguate. If someone suggests "use the Clay MCP," they probably mean this, and it won't work for GTM table operations.

## n8n Clay Integration

### Community Node

- **Source**: [bcharleson/n8n-nodes-clay](https://github.com/bcharleson/n8n-nodes-clay)
- **Status**: Experimental, minimal documentation

A community n8n node for Clay operations. Low activity. Use with caution.

### Callback Pattern (Recommended)

The n8n callback pattern is the established way to orchestrate Clay in automated workflows:

1. n8n triggers Clay via table webhook POST (include `$execution.resumeUrl`)
2. Clay enriches the data (async, may take minutes)
3. Clay's HTTP action column POSTs results to the resume URL
4. n8n resumes execution with enriched data

This is the pattern the Lele `n8n_operator` agent uses. No custom node needed -- just standard webhook + HTTP request nodes.

### Lele's Docker Compose

The project includes a Docker Compose file for n8n:
```yaml
# docker-compose.yml
services:
  n8n:
    image: n8nio/n8n
    ports:
      - "5678:5678"
```

## Make / Zapier Wrappers

Clay's official documentation suggests using Make or Zapier as "API wrappers" around Clay:
- Receive an API request in Make/Zapier
- Trigger Clay webhook
- Wait for Clay to process (use a webhook callback or polling)
- Return results

This is essentially the n8n callback pattern but using no-code tools. Less flexible than the direct approach.

## Unofficial Documentation

- **claydocs.claygenius.io**: Unofficial Clay documentation site. Disclaims affiliation with Clay. Treat as community content, not authoritative.

## Community Resources

- **Clay Slack Community**: [community.clay.com](https://community.clay.com/) -- active community, good for discovering new tools/patterns
- **Clay University**: [university.clay.com](https://university.clay.com/) -- official docs and guides
- **Clay Experts Network**: [clay.com/experts](https://www.clay.com/experts) -- Clay-certified experts and agencies
