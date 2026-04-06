# TODO-002: Export/Download Table Data as CSV

**Priority:** P1 — Important for data extraction workflows
**Status:** Open
**Related Gap:** GAP-020
**Depends on:** Partially mitigated if TODO-001 is solved (row reads replace export need)

## Problem

`GET /v3/exports/csv?tableId={tableId}` returns 404 with "job not found". The export system appears to use an async job model (POST to create job, GET to check status, GET to download), but we don't know the exact flow.

## What We Know

- Two export endpoints discovered: `GET /v3/exports/csv`, `GET /v3/exports/download`
- Both return 404 when called directly with tableId
- Import endpoint (`GET /v3/imports?workspaceId=`) works and shows column mappings
- Clay UI has an "Export to CSV" button — the flow can be intercepted

## Investigation Plan

1. CDP intercept the UI's "Export to CSV" flow
2. Look for a `POST /v3/exports` or `POST /v3/exports/csv` that creates the job
3. Capture the job ID and polling/download flow
4. Document full async lifecycle

## Success Criteria

- Can trigger CSV export programmatically
- Can poll for completion
- Can download the resulting file
