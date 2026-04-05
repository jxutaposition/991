# n8n Platform Knowledge

## How n8n Works

n8n is an open-source workflow automation platform. Workflows are DAGs of nodes connected by edges. Each node performs one operation (trigger, transform, call API, etc.).

## REST API Access

All operations are executed via the n8n REST API using `http_request`. The API key is auto-injected via the `X-N8N-API-KEY` header — never include it manually.

### Core Endpoints

| Action | Method | Endpoint |
|--------|--------|----------|
| List workflows | GET | `{base_url}/api/v1/workflows` |
| Get workflow | GET | `{base_url}/api/v1/workflows/{id}` |
| Create workflow | POST | `{base_url}/api/v1/workflows` |
| Update workflow | PUT | `{base_url}/api/v1/workflows/{id}` |
| Activate | POST | `{base_url}/api/v1/workflows/{id}/activate` |
| Deactivate | POST | `{base_url}/api/v1/workflows/{id}/deactivate` |
| Delete | DELETE | `{base_url}/api/v1/workflows/{id}` |
| List executions | GET | `{base_url}/api/v1/executions` |
| Get execution | GET | `{base_url}/api/v1/executions/{id}` |
| List credentials | GET | `{base_url}/api/v1/credentials` |
| Run workflow | POST | `{base_url}/api/v1/workflows/{id}/run` |

### Workflow JSON Structure

```json
{
  "name": "My Workflow",
  "nodes": [
    {
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [250, 300],
      "parameters": { "path": "my-hook", "httpMethod": "POST" },
      "webhookId": "unique-id"
    }
  ],
  "connections": {
    "Webhook": { "main": [[{ "node": "NextNode", "type": "main", "index": 0 }]] }
  },
  "settings": { "executionOrder": "v1" }
}
```

### Credential References in Nodes

Use `"credentials": {"credType": {"id": "...", "name": "..."}}`. Find credential IDs via `GET /api/v1/credentials`.

## Build Workflow

1. Understand the automation goal — trigger, data flow, outcome
2. Create minimal workflow via POST
3. Add nodes iteratively, validate after each
4. Test with `POST /api/v1/workflows/{id}/run`
5. Activate only after test passes
