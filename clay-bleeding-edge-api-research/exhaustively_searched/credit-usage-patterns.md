# Credit Usage Patterns — What Costs Money

**Status**: DOCUMENTED
**Investigated**: Credit audit of all investigation scripts (15+) plus workspace credit balance probes from INV-009 / INV-026
**Stance**: Credit-aware, not credit-paranoid. Small experimentation is encouraged.

## CHARGED operations (cost real credits — be aware, not afraid)

| Operation | Credit Type | Cost Per |
|-----------|------------|----------|
| `PATCH /v3/tables/{id}/run` (enrichment trigger) | Action | 1+ per row × field |
| `tableSettings.autoRun: true` + inserting rows into table with action columns | Action | 1+ per row × enrichment column |
| Creating an enrichment column on a table that already has rows (may auto-trigger) | Action | 1+ per existing row |
| Data enrichments (Find People, Find Companies, etc.) | Data | 1+ per row |
| tc-workflows direct runs / batch runs that hit a node with a real model + tools | Action | depends on node config |

These are still load-bearing distinctions — the FREE/CHARGED split below is the
reason we can run dozens of structural probes per session without affecting the
balance.

## FREE operations (safe to run liberally)

| Operation | Notes |
|-----------|-------|
| Table create/read/update/delete/duplicate | All free |
| Column/field create/read/update/delete | Free (except action columns on populated tables) |
| View create/rename/delete | Free |
| Row insert/read/update/delete | Free |
| Source/webhook CRUD | Free |
| Workbook create/duplicate/list | Free |
| Schema reads (`GET /v3/tables/{id}`) | Free |
| Actions catalog (`GET /v3/actions`) | Free |
| Workspace/user/permission reads | Free |
| Export job creation + polling + download | Free |
| Formula evaluation (auto on insert) | Free |
| Tags CRUD | Free |
| tc-workflows graph/snapshot/batch CRUD against inert nodes | Free in observed runs (see GAP-034) |
| CSV import full flow (`multi-part-upload` → S3 PUT → `/v3/imports`) | Free |
| Documents upload-url → S3 POST → confirm-upload | Free |

## Experimentation budget

This workspace (1080480) has plenty of headroom for testing:

- `creditBudgets.actionExecution` reads `999999999897` per INV-026 — effectively
  unlimited for our purposes.
- `creditBudgets.basic` was last observed at **1934.4** in INV-009 — plenty for
  ad-hoc enrichment runs.
- A typical enrichment probe of `normalize-company-name` costs ~1 credit per
  row × field, so a 5-row × 2-field test = ~10 credits. That is rounding noise.

**Rule of thumb for experimentation:**

- ≤10 rows × ≤3 enrichment fields per probe is fine and should NOT be artificially
  blocked. Just go ahead and verify the behavior you care about.
- Prefer the cheapest actions when probing semantics (`normalize-company-name`,
  `domain-from-company-name`, etc.).
- Read `creditBudgets` from `GET /v3/workspaces/{id}` before AND after a probe
  if you want a clean delta.
- If a probe wants more than ~50 credits, write down why first and double-check
  it's actually necessary.

## Things to actually avoid

These are the cases where you can burn meaningful credit by accident:

1. **Don't run `PATCH /run` over thousands of rows** without an explicit reason.
   Slice the input to 1–10 rows for verification work.
2. **Don't leave `autoRun: true` on a populated table** with action columns at
   the end of an investigation. Flip it back off (or delete the table) before
   you stop.
3. **Don't create enrichment columns on big existing tables.** Test on empty or
   tiny tables first; promote later.
4. **Watch out for Find People / Find Companies** — these are pricier per row
   than the cheap normalization actions.
5. **Long-running tc-workflows direct runs with non-inert nodes** — INV-026
   showed Clay auto-injects `claude-haiku-4-5` into "regular" nodes that have no
   model configured. On this dev workspace credit delta was 0, but a normal
   workspace may meter that. See GAP-034.

## Best practices for experimentation scripts

1. **Use `forceRun: false`** when re-running tests — it skips already-succeeded
   cells and costs 0.
2. **Clean up after yourself** — drop scratch tables, sources, workflows, and
   documents at the end of the script. The harness has examples in
   `cleanup-*.ts` and the INV-023 verify script.
3. **Capture the credit delta** in script output so reviewers can sanity-check.
4. **Default to small N.** 1–5 rows is enough to prove behavior in 99% of cases.
5. **Cheap actions first.** Use `normalize-company-name` (1 credit each) when
   you just need to see an action column transition through its lifecycle.

## Audit of our scripts so far

Total credits consumed by all investigation scripts: **~20 action credits**
- The vast majority of scripts consumed ZERO credits.
- Highest cost: `investigate-enrichment-lifecycle.ts` (6 credits)
- All credit-spending scripts used `normalize-company-name` (cheapest action)

The historical 14.9K/15K action usage that prompted earlier paranoia was NOT
from our investigation scripts (~0.13%) — it was from pipeline rebuilds and
existing table enrichments outside the research project.
