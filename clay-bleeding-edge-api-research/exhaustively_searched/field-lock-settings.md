# Field Lock Settings

**Status**: NOT USER-SETTABLE
**Investigated**: INV-024 (Session 9)

System fields have `lockSettings: {lockDelete: true, lockUpdateCells: true, lockUpdateSettings: true}`.
User-created fields have `lockSettings: undefined`.
PATCH with `lockSettings` or `isLocked: true` returns 200 but values don't persist.

Field protection is system-only, not configurable via API.
