# Action Key Immutable After Creation

**Status**: CONFIRMED — Cannot change
**Investigated**: INV-031 (Session 14)

PATCH with new `actionKey` on existing enrichment column returns:
```json
{"type": "BadRequest", "message": "Cannot change actionKey"}
```

To change the action, delete the column and create a new one.
You CAN update `inputsBinding`, `conditionalRunFormulaText`, and other typeSettings — just not the `actionKey` itself.
