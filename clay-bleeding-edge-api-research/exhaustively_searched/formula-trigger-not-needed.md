# Formula Re-Evaluation Trigger

**Status**: NOT NEEDED — formulas auto-evaluate
**Investigated**: INV-017 (Session 4)

## Finding
- Formulas auto-evaluate immediately on row insert (`UPPER("hello world")` → `"HELLO WORLD"` with `metadata.status: "SUCCESS"`)
- Formulas auto-re-evaluate when dependent cells are updated (changed input → formula recalculated)
- `PATCH /v3/tables/{id}/run` with formula fieldIds also works for explicit triggering if ever needed

No manual trigger mechanism needed. The question is moot.
