# TODO-032: Webhook Data Ingestion + autoRun Enrichment Chain

**Priority:** P0 — Core autonomous pipeline: webhook → row → auto-enrichment
**Status:** BLOCKED — webhook source creation returns 402 (Payment Required)

## The Big Question

If we POST data to a webhook source URL AND the table has `autoRun: true`, do enrichment columns automatically execute on the new row? This is the holy grail for autonomous pipelines.

## Investigation Plan

1. Create table, add text column + enrichment action column
2. Create webhook source on the table
3. Set `tableSettings.autoRun: true`
4. POST JSON data to the webhook URL
5. Read rows — verify the webhook data arrived as a new row
6. Poll for enrichment cell metadata — did enrichment auto-trigger?
7. Test with multiple webhook POSTs in rapid succession
8. Test webhook with different content types (JSON, form-data)
9. Test what happens when webhook payload doesn't match table schema
