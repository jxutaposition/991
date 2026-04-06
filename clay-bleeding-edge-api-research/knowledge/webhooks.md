# Clay Webhooks Reference

Last updated: 2026-04-05
Source: [Clay University - Webhooks](https://university.clay.com/docs/webhook-integration-guide)

## Inbound Webhooks (Data Into Clay)

Every Clay table can have a webhook URL that accepts HTTP POST requests with JSON data. This is the primary way to programmatically send data INTO Clay.

### Setup

Done in the Clay UI:
1. Open table settings
2. Enable webhook source
3. Copy the unique webhook URL
4. Optionally configure an auth token

**The auth token is shown only once** -- store it immediately.

### Usage

```bash
curl -X POST {webhook_url} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {optional_token}" \
  -d '{"field_name": "value", "another_field": "value"}'
```

### Limits

- **50,000 submissions** per webhook endpoint
- This limit **persists even after deleting rows** -- the counter doesn't reset
- After hitting the limit, you need a new webhook
- **Enterprise**: auto-delete/passthrough mode removes rows after processing, enabling unlimited flow-through
- No way to read the current submission count via API

### What Webhooks Cannot Do

- Read data back out of Clay (strictly inbound)
- Create tables or columns
- Trigger enrichment runs (rows are enriched based on column configuration)
- Manage webhook settings programmatically

## Outbound HTTP (Data Out of Clay)

Clay pushes data out via **HTTP API action columns**. These are configured as column types in the Clay UI.

### Configuration

| Setting | Description |
|---------|-------------|
| Method | POST, GET, PUT, DELETE |
| URL | Your endpoint (static or with column references) |
| Headers | Custom headers, auth, Content-Type |
| Body | JSON template with `{{column_name}}` references |
| Run condition | On row match, manual trigger, schedule |

### n8n Callback Pattern

The best practice for synchronous Clay orchestration:

1. n8n workflow starts, generates a unique callback URL (`$execution.resumeUrl`)
2. n8n POSTs to the Clay table webhook, including the callback URL in the payload
3. Clay processes the row (enrichments run -- may take seconds to minutes)
4. A final HTTP action column in Clay POSTs enriched data to the callback URL
5. n8n receives the callback and resumes execution

This effectively makes Clay a synchronous step in a workflow, despite its async enrichment model.

```
n8n                     Clay Table                    n8n
 │                         │                           │
 │── POST webhook ────────>│                           │
 │   (with resumeUrl)      │                           │
 │                         │── enrichments run ───>    │
 │                         │                           │
 │                         │── POST resumeUrl ────────>│
 │                         │   (with enriched data)    │
 │<─────────────────────── resume ────────────────────>│
```

### Auto-Delete Mode (Enterprise)

For high-volume or continuous enrichment jobs:
- Incoming webhook data is enriched
- Results are sent to destination (HTTP action column)
- Rows are automatically deleted after processing
- Clay acts as a flow-through enrichment engine, not a data store
- Bypasses the 50k webhook submission limit

## Webhook via v3 API

The v3 API's `POST /v3/sources` endpoint can create sources including webhook sources. This means we may be able to:
- Create webhook endpoints programmatically (bypassing the UI)
- Read webhook configuration
- Potentially manage webhook settings

This is an active area of investigation. See `investigations/INV-001_v3-endpoint-catalog.md`.

## Practical Considerations

- **Idempotency**: Clay webhooks don't have built-in deduplication. Include a unique ID in your payload and add a Clay formula column to detect duplicates.
- **Latency**: Enrichments are async. A webhook POST returns immediately (row created), but enrichments may take seconds to minutes.
- **Error handling**: If a webhook POST fails, Clay doesn't retry. Build retry logic on the sender side.
- **Rate limiting**: No documented rate limit on webhook POSTs, but aggressive posting may trigger undocumented limits.
- **Payload format**: JSON with field names as keys. Field matching is by column name (case-sensitive).
