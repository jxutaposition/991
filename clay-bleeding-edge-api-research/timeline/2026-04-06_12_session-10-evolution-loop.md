# Session 10: Evolution Loop — Imports, Re-Parenting, Attributes, Route-Row, Field PATCH

**Date**: 2026-04-06
**Investigations**: INV-025, INV-026

## Major Breakthroughs

### 1. TABLE WORKBOOK RE-PARENTING WORKS (TODO-044 — RESOLVED)

`PATCH /v3/tables/{id}` with `{workbookId: "wb_other"}` → **200, table moved!**

```
Table's current workbook: wb_0td3b5wpPavFHkDJciF
PATCH {workbookId: "wb_0td3b5yb2N3MFU9RZsz"} → workbookId changed to wb_0td3b5yb2N3MFU9RZsz
```

Tables can be moved between workbooks via a simple PATCH. Also discovered: `PATCH {parentFolderId: "xxx"}` returns **409 Conflict** with "New parent folder not found" — confirming folders exist as a concept even though there's no folder CRUD API.

### 2. FIELD RENAME VIA PATCH CONFIRMED (registry gap filled)

`PATCH /v3/tables/{id}/fields/{fieldId}` with `{name: "New Name"}` → **200, renamed!**

Also confirmed: updating formula text via PATCH works:
```json
PATCH /v3/tables/{id}/fields/{formulaId}
{"typeSettings": {"formulaText": "UPPER({{f_xxx}})", "formulaType": "text", "dataTypeSettings": {"type": "text"}}}
```
Returns 200 with updated formula.

**Cannot change field type**: `PATCH` with `{type: "formula"}` on a text field returns 400 "Missing data type settings" — type changes likely need delete + recreate.

### 3. FULL ATTRIBUTES CATALOG DOCUMENTED (TODO-023 — RESOLVED)

68 total attributes: 28 person, 40 company.

**Person attributes (28)**: workEmail (15 providers!), personalEmail (13), phone (12), phoneAPAC/EMEA/Global (9 each), linkedIn/url (8), advertisingEmail (6), location/summary (6), fullName/firstName/lastName (5 each), jobTitle (4), company (4), bio/facebook/twitter/industry (3 each), education/pictureUrl/schoolName/github (2), gender/instagram/jobStartDate (1), middleName (0 providers).

**Company attributes (40)**: description (7), employeeCount (7), domain (3), address/country/foundedDate/fundingRound/industry (4-5 each), revenue/techStack/totalFunding (4 each), siteTraffic/investors/latestFunding (2-3 each), plus 20 more niche attributes.

**`attributeProviderPathMap`**: Maps each attribute to specific action package IDs + output JSON paths. Example: `person/workEmail` → 15 different provider packages, each with a path like `"email"` or `"email[0].email"` telling Clay where to extract the email from the enrichment result. This is THE mapping that connects enrichment actions to attribute outputs.

### 4. IMPORT JOB FORMAT DISCOVERED (TODO-045 — partially resolved)

Existing imports reveal the structure:
```json
{
  "config": {
    "map": {"f_fieldId": "{{CSV Column Name}}"},
    "source": {
      "key": "userId/filename.csv",
      "type": "S3_CSV",
      "records": [{"col1": "val1", "col2": "val2"}, ...]
    }
  }
}
```

The import flow is: CSV uploaded to S3 first → import job references the S3 key. `POST /v3/imports` returns 500 for all JSON payloads — likely requires multipart form upload or a separate file upload step first.

### 5. SOURCE RENAME VIA PATCH CONFIRMED

`PATCH /v3/sources/{id}` with `{name: "New Name"}` → 200. TypeSettings PATCH returned successfully but the source type didn't have schedule support (manual sources are simple).

Source types in workspace: `manual` (10), `webhook` (1), `trigger-source` (1).

### 6. ROUTE-ROW CREATION — NEEDS DIFFERENT PAYLOAD FORMAT

`POST /v3/tables/{id}/fields` with `actionKey: "route-row"` returned 400. The `inputsBinding` format we used (with `formulaMap`) doesn't match what Clay expects. Need to study existing route-row columns from real tables to get the correct shape.

### 7. ENDPOINT DISCOVERY — ALL NEW PATHS 404

Tested 12 new endpoint patterns — all 404:
- `GET /v3/tables/{id}/fields/{fieldId}` (no single field read)
- `GET /v3/tables/{id}/fields` (no field listing)
- `GET /v3/tables/{id}/schema`, `/metadata`, `/stats` (no sub-resources)
- `POST /v3/tables/{id}/fields/batch` (no batch)
- `GET /v3/tables/{id}/views/{viewId}/filter`, `/sort` (no filter sub-resources)
- `GET /v3/tables/{id}/sources`, `/records/count`, `/workbook` (none exist)

### 8. TAG ASSOCIATION — NOT VIA TABLE PATCH

Tags can be created/deleted but we couldn't find how to associate them with tables. PATCH table with `tags`, `resourceTags`, `tagIds`, `resourceTagIds` all return 200 but tags don't appear in the response. Dedicated association endpoints all 404. Tags may be associated via a different mechanism (possibly workbook-level or UI-only).

## TODOs Updated

| TODO | Status |
|------|--------|
| TODO-044 (re-parenting) | **RESOLVED** — PATCH workbookId works |
| TODO-023 (attributes) | **RESOLVED** — 68 attributes cataloged with provider mappings |
| TODO-045 (import) | **PARTIALLY RESOLVED** — format discovered (S3+map), JSON POST returns 500 |
| TODO-046 (tag association) | **RESOLVED NEGATIVE** — no association mechanism found via REST |
| TODO-047 (new endpoints) | **RESOLVED NEGATIVE** — all 12 new paths 404 |
| TODO-038 (route-row) | **Still open** — payload format needs adjustment |
