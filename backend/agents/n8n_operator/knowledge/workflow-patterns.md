# n8n Workflow Architecture Patterns

## Five Core Patterns
1. **Webhook** — inbound HTTP, instant response/notify
2. **HTTP API** — fetch/transform/act with error handling paths
3. **Database** — scheduled/query/sync/ETL operations
4. **AI agent** — model + tools + memory subgraph
5. **Scheduled** — cron → fetch → process → deliver/log

## Shared Building Blocks
- **Triggers:** Webhook, Schedule, Manual, polling
- **Sources:** HTTP Request, DB query, service nodes, Code
- **Transform:** Set, Code, IF/Switch, Merge
- **Outputs:** HTTP, DB write, messaging (Slack/email), storage
- **Errors:** Error Trigger, IF, Stop and Error, continue-on-fail

## Flow Shapes
- Linear: trigger → process → output
- Branching: IF/Switch splits → different paths
- Parallel: multiple branches → Merge node
- Batch: split items → loop → recombine
- Error: main workflow + separate error workflow

## Gotchas
- Webhook fields → `$json.body.*` in expressions
- Many items → "Execute once" or explicitly first item for single-item semantics
- Auth → credentials UI, not raw secrets in parameters
- Literal expressions → missing `{{}}`

## Build Loop
Pick pattern → choose nodes → wire → validate → test → activate → monitor
