# TODO-045: Import Job Payload Reverse-Engineering

**Priority:** P0 — Programmatic data import
**Status:** Open

## What We Know

- `GET /v3/imports?workspaceId=` returns import history with `config` objects
- `POST /v3/imports` returned 500 (not 404) — endpoint exists
- Import records have column mapping details

## Investigation Plan

1. Read existing import records, extract full `config` structure
2. Try POST with config structure as payload
3. Iterate on Zod validation errors to discover required fields
4. Try multipart form-data with CSV file attachment
