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
