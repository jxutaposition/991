# TODO-024: Import Job Creation

**Priority:** P2 — Programmatic data import
**Status:** Open — `POST /v3/imports` returned 500 (needs correct payload)
**Discovered:** Session 5 (INV-018)

## What Works

- `GET /v3/imports?workspaceId=` → lists import history with column mappings

## What We Know

- `POST /v3/imports` exists (returned 500, not 404) — endpoint is registered but we sent wrong payload
- Import records have `config` with column mapping details
- Clay UI has CSV import flow

## Investigation Plan

1. Study existing import records from `GET /v3/imports` to understand the expected payload format
2. Try `POST /v3/imports` with `{workspaceId, tableId, type: "csv"}` and variations
3. CDP intercept the UI CSV import flow
4. May need multipart form data with the CSV file

## Success Criteria

- Can create a CSV import job programmatically
- Can map columns to table fields
