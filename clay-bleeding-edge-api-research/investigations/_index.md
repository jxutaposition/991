# Investigation Index

| ID | Title | Status | Priority | Gap |
|----|-------|--------|----------|-----|
| INV-001 | v3 Endpoint Catalog | mostly-resolved | P0 | GAP-001 |
| INV-002 | Table Lifecycle via v3 | resolved | P0 | GAP-002 |
| INV-003 | Enrichment Provider Configuration | partially-resolved-negative | P1 | GAP-004 |
| INV-004 | Session Cookie Durability | resolved | P0 | GAP-003 |
| INV-005 | v3 Rate Limits | resolved | P1 | GAP-005 |
| INV-006 | v3 Unauthenticated Enumeration | completed | P0 | GAP-001, GAP-002, GAP-006, GAP-007, GAP-008 |
| INV-007 | Authenticated v3 API Validation | completed | P0 | GAP-001, GAP-002, GAP-003, GAP-006, GAP-007, GAP-017 |
| INV-008 | Boundary Exploration (Session 2) | completed | P0 | GAP-003, GAP-005, GAP-011, GAP-017, GAP-004 |
| INV-009 | Reach Goals (Session 3) | completed | P1 | GAP-010, GAP-018, GAP-021, GAP-023, GAP-024 |
| INV-010 | authAccountId Deep Dive | completed | P0 | GAP-004, GAP-022 |
| INV-011 | v1 Deprecated + v3 Records | completed | P0 | GAP-011 (corrected), GAP-009 |
| INV-012 | v3 Row Reading Endpoint Discovery | completed | P0 | GAP-025 |
| INV-013 | Enrichment Cell Metadata States | completed | P1 | GAP-013, TODO-004, TODO-005, TODO-011, TODO-017 |
| INV-014 | Pagination Investigation | completed | P1 | GAP-026, TODO-009, TODO-012 |
| INV-015 | View CRUD | completed | P1 | TODO-010 (partial: create + rename work, filter/sort payload TBD) |
| INV-016 | Table/Workbook Duplication + CRUD | completed | P1 | TODO-013, TODO-015, TODO-016 |
| INV-017 | Quick Wins (formula, sorting, export) | completed | P2 | GAP-012, GAP-020, TODO-002, TODO-006, TODO-018, TODO-019 |
| INV-018 | Deep Scan 1: Hidden Entity APIs | completed | P1 | Signals, resource-tags, users, permissions, attributes, export polling |
| INV-019 | Deep Scan 2: View Filters + Table Settings | completed | P1 | TODO-010 (resolved negative), table settings (autoRun, dedupeFieldId), view deletion |

## How to Add an Investigation

1. Create `INV-{next_number}_{slug}.md`
2. Follow the template in `../AGENT.md`
3. Add an entry to this index
4. Link it to a gap from `../registry/gaps.md`
5. Update the changelog when you make findings

## Naming Convention

- `INV-XXX_slug.md` where XXX is zero-padded
- Slug is lowercase with hyphens
- One investigation per file
