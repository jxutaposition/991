# Workflows / Claygent API

**Status**: SUPERSEDED — the legacy `/v3/workflows` paths still 404, but the **tc-workflows** product has a full v3 API surface (~30 endpoints) confirmed in INV-023 through INV-026.
**Investigated**: INV-018 (Session 5), INV-023, INV-024, INV-025, INV-026 (2026-04-07)
**Original note (Session 5)**: feature flags `enableWorkflows: false` and `enableClaygent: false` were observed, and the paths below all returned 404. This was correct at the time but has since been overtaken by the tc-workflows ("terracotta") product which exposes its own routes under `/v3/workspaces/{wsId}/tc-workflows/...`.

## Legacy Paths Still 404 (the names tested in INV-018)
- `GET /v3/workflows`, `GET /v3/workspaces/{id}/workflows`
- `GET /v3/claygent`
- `GET /v3/message-drafts`, `GET /v3/workspaces/{id}/message-drafts`

These exact paths are still dead. The live API uses the `tc-workflows` prefix instead.

## Live tc-workflows Surface (see registry/endpoints.jsonl)
- Workflow CRUD: `GET/POST/PATCH/DELETE /v3/workspaces/{wsId}/tc-workflows[/{wfId}]`
- Graph + validation: `GET .../{wfId}/graph`
- Node CRUD (single + batch): `POST/PATCH/DELETE .../{wfId}/nodes[/{nodeId}]`
- Edge CRUD: `POST/DELETE .../{wfId}/edges[/{edgeId}]`
- Snapshots (read-only, server-managed): `GET .../{wfId}/snapshots[/{snapshotId}]`
- CSV ingest: `POST .../{wfId}/batches/csv-upload-url` → S3 POST → `POST .../{wfId}/batches`
- Batch CRUD + cancel: `GET/PATCH/DELETE .../{wfId}/batches[/{batchId}]`
- Direct runs: `POST/GET .../{wfId}/runs[/{runId}]` + pause/unpause + `steps/{stepId}/continue` + `steps/waiting`
- Documents (RAG): `POST /v3/documents/{wsId}/upload-url` → S3 POST → `.../confirm-upload`

See `knowledge/internal-v3-api.md` (tc-workflows sections) and timeline entries `2026-04-07_4` through `2026-04-07_7` for full details.
