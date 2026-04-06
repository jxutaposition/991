# TODO-038: Cross-Table Route-Row + Downstream Enrichment

**Priority:** P1 — Multi-table pipeline orchestration
**Status:** Open

## The Scenario

Table A has enrichment columns → route-row sends data to Table B → Table B has its own enrichment columns. Does Table B's enrichments auto-trigger when route-row delivers rows?

## Investigation Plan

1. Create Table A with a text column + route-row to Table B
2. Create Table B with an enrichment column, set autoRun: true
3. Insert rows in Table A
4. Trigger route-row on Table A
5. Check Table B: did rows arrive? Did enrichments auto-trigger?
6. Document the full cross-table pipeline timing
