# INV-004: Session Cookie Durability

**Status**: resolved
**Priority**: P0
**Gap**: GAP-003 (Session Cookie Durability)
**Date started**: --
**Date completed**: --

## Hypothesis

Clay session cookies have a finite lifetime. Understanding their durability is critical for designing the session management system. Key questions:

1. How long do cookies last (hours, days, weeks)?
2. Are cookies IP-bound (will they work from a different machine)?
3. Does Clay rotate/refresh cookies during a session?
4. What's the authentication renewal mechanism?
5. Can multiple concurrent sessions exist for the same account?
6. Does idle time affect session validity differently from active time?

## Method

### Phase 1: Cookie Extraction and Analysis

1. Use `harness/scripts/extract-session.ts` to authenticate and extract cookies
2. Document each cookie:
   - Name
   - Domain
   - Path
   - Expiry time (if set)
   - HttpOnly flag
   - Secure flag
   - SameSite attribute

### Phase 2: Durability Testing

1. Extract cookies at T=0
2. Test validity periodically by making a v3 API call:
   ```
   GET /v3/tables/{known_table_id}
   ```
3. Test at intervals: 1h, 2h, 4h, 8h, 12h, 24h, 48h, 7d
4. Record when the first 401 occurs

### Phase 3: IP Binding Test

1. Extract cookies on Machine A
2. Try using them from Machine B (different IP)
3. If they work, session is not IP-bound
4. If they fail, test if the same cookies still work on Machine A

### Phase 4: Concurrent Session Test

1. Extract Session A
2. Log in again (new browser context) to get Session B
3. Test if Session A still works
4. Test if both can make concurrent v3 calls

### Phase 5: Refresh Behavior

1. Monitor response headers during v3 calls for `Set-Cookie`
2. Check if Clay rotates cookies during active use
3. Compare cookies at T=0 and T=1h after active use

## Findings

Resolved by INV-008 (Session 2, 2026-04-06). Cookie lifetime is 7 days. Timer resets on every API call (confirmed via set-cookie header). Not IP-bound. Session never expires if used weekly.

### Cookie Inventory

| Name | Domain | Path | Expiry | HttpOnly | Secure | Notes |
|------|--------|------|--------|----------|--------|-------|
| *to be filled* | | | | | | |

### Durability Results

| Time Since Extract | Valid? | Response Status | Notes |
|--------------------|--------|-----------------|-------|
| 0h (baseline) | -- | -- | -- |
| 1h | -- | -- | -- |
| 4h | -- | -- | -- |
| 12h | -- | -- | -- |
| 24h | -- | -- | -- |
| 48h | -- | -- | -- |
| 7d | -- | -- | -- |

## Implications

- If cookies last > 24h: simple daily refresh is sufficient
- If cookies last < 4h: need proactive refresh before every multi-step operation
- If IP-bound: must extract cookies on the same machine that will use them
- If concurrent sessions work: multiple agent runs can share cookies
- Findings directly inform `architecture/session-management.md` design

## Next Steps

*Based on findings.*
