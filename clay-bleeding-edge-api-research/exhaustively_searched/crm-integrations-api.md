# CRM Integrations API

**Status**: NO ENDPOINTS EXIST
**Investigated**: INV-018 (Session 5)
**Note**: `canManageCRMImports` and `canExportToCRM` abilities exist. CRM operations likely happen through the actions system (action columns with CRM provider actions).

## Paths Tested (All 404)
- `GET /v3/crm`, `GET /v3/crm?workspaceId=`
- `GET /v3/workspaces/{id}/crm`
- `GET /v3/integrations`, `GET /v3/integrations?workspaceId=`
- `GET /v3/workspaces/{id}/integrations`
- `GET /v3/crm-imports`, `GET /v3/workspaces/{id}/crm-imports`
