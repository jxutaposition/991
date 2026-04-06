# TODO-023: Attributes Catalog Deep Dive

**Priority:** P2 — Understanding Clay's enrichment field taxonomy
**Status:** Open — READ confirmed, full schema undocumented
**Discovered:** Session 5 (INV-018)

## What Works

`GET /v3/attributes` → `{attributeDescriptionsMap: {waterfallAttributes: {...}}}` returns Clay's full enrichment attribute catalog:
- Person attributes: `person/workEmail`, `person/fullName`, `person/linkedinUrl`, etc.
- Company attributes: `company/domain`, `company/name`, etc.
- Each attribute has: `enum`, `entityType`, `displayName`, `icon`, `dataTypeSettings`, `isPopular`, `actionIds`

## What Needs Investigation

1. Document the full attribute list (person + company)
2. Understand how `actionIds` map to the actions catalog
3. Try `POST /v3/attributes` to create custom attributes
4. Try `GET /v3/attributes?entityType=person` for filtered queries
5. Understand how attributes relate to Find People / Find Companies sources

## Success Criteria

- Full attribute taxonomy documented
- Understand how to leverage attributes for enrichment column configuration
