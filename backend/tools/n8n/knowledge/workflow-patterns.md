# n8n Workflow Architecture Patterns

## Five Core Patterns

### 1. Webhook Processing (most common)
Pattern: Webhook → Validate → Transform → Respond/Notify
Example: "Receive Stripe payment → Update DB → Send confirmation"
When: Receiving external events, need instant response

### 2. HTTP API Integration
Pattern: Trigger → HTTP Request → Transform → Action → Error Handler
Example: "Fetch GitHub issues → Transform → Create Jira tickets"
When: Fetching from APIs, synchronizing services, data pipelines

### 3. Database Operations
Pattern: Schedule → Query → Transform → Write → Verify
Example: "Read Postgres → Transform → Write MySQL"
When: Database sync, ETL, scheduled queries

### 4. AI Agent Workflow
Pattern: Trigger → AI Agent (Model + Tools + Memory) → Output
Example: "Chat with AI that can search docs, query DB, send emails"
When: Conversational AI, multi-step reasoning, tool access

### 5. Scheduled Tasks
Pattern: Schedule → Fetch → Process → Deliver → Log
Example: "Daily: Fetch analytics → Generate report → Email team"
When: Recurring reports, periodic data fetch, maintenance

---

## Shared Building Blocks

### Triggers
- **Webhook** — instant, external events
- **Schedule** — periodic (cron, interval, daily time)
- **Manual** — testing
- **Polling** — check at intervals (e.g., new emails)

### Data Sources
- **HTTP Request** — REST APIs
- **Database** — Postgres, MySQL, MongoDB
- **Service nodes** — Slack, Sheets, Gmail
- **Code** — custom data generation/transformation

### Transformation
- **Set** — map fields, add computed values
- **Code** — complex multi-step logic (JS/Python)
- **IF/Switch** — route by condition
- **Merge** — combine branches

### Outputs
- **HTTP Request** — send to APIs
- **Database** — write records
- **Communication** — Slack, Email, SMS
- **Storage** — files, S3, Google Drive

### Error Handling
- **Error Trigger** — catch workflow errors
- **IF** — check for error conditions
- **Stop and Error** — halt with message
- **Continue on Fail** — node-level setting to not block

---

## Flow Shapes

- **Linear**: Trigger → Transform → Action → End
- **Branching**: Trigger → IF → [True path / False path]
- **Parallel**: Trigger → [Branch A, Branch B] → Merge → End
- **Batch/Loop**: Split in Batches → Process → Loop back
- **Error Handler**: Main workflow + separate error workflow

---

## Common Gotchas

1. **Webhook data** is under `$json.body.*`, not root
2. **Multiple items** processed by default — use "Execute once" or `$input.first()` for single-item semantics
3. **Auth** must use credentials UI, not raw secrets in parameters
4. **Execution order**: connection-based (follow the wires)
5. **Missing `{{}}`** makes expressions show as literal text

---

## Workflow Creation Checklist

### Planning
- Identify which pattern fits
- List required nodes
- Understand data flow between nodes
- Plan error handling

### Implementation
1. Create trigger node
2. Add data sources, configure auth
3. Add transformations
4. Add output nodes
5. Wire error handling

### Validation
- Validate each node individually
- Validate full workflow
- Test with real data
- Handle edge cases (empty input, missing fields)

### Deployment
- Review settings
- Activate workflow
- Monitor first executions
- Document workflow purpose

---

## Build Loop
Pick pattern → choose nodes → wire → validate → test → activate → monitor
