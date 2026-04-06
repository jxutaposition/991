# Formula Creation — No Validation

**Status**: CONFIRMED
**Investigated**: INV-023 (Session 8)

Clay performs ZERO formula validation at creation time:
- `UPPER({{f_NONEXISTENT}})` → 200 (invalid field ref accepted)
- `UPPER((({{f_xxx}})` → 200 (syntax error accepted)

Formulas are stored as opaque strings. Errors only surface when rows are evaluated at runtime.

**Agent must validate field references itself before creating formulas.**
