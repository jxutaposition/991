# INV-005: v3 Rate Limits

**Status**: resolved
**Priority**: P1
**Gap**: GAP-005 (v3 Rate Limits)
**Date started**: --
**Date completed**: --

## Hypothesis

The v3 API likely has rate limits, but they're undocumented. Claymate Lite uses a conservative 150ms delay between calls. We need to determine:

1. What's the actual rate limit (requests per second/minute)?
2. Is rate limiting per-session, per-account, or per-IP?
3. What response does Clay return when rate-limited (429? 503? Connection reset?)
4. Are different endpoints rate-limited differently (reads vs. writes)?
5. Is there a burst allowance?

## Method

### Safety First

- Use a scratch table with no important data
- Start very conservatively and increase gradually
- Stop immediately on any sign of rate limiting
- Monitor for account-level consequences (not just API responses)

### Phase 1: Read Endpoint Testing

Test `GET /v3/tables/{tableId}` at increasing frequencies:

1. 1 req/sec (10 requests) -- baseline
2. 2 req/sec (20 requests)
3. 5 req/sec (50 requests)
4. 10 req/sec (100 requests)
5. 20 req/sec (200 requests) -- only if no limits hit yet

Record response times and status codes for each batch.

### Phase 2: Write Endpoint Testing

Test `POST /v3/tables/{tableId}/fields` (creating and then deleting test columns):

1. 150ms delay (Claymate baseline) -- 10 columns
2. 100ms delay -- 10 columns
3. 50ms delay -- 10 columns
4. No delay -- 10 columns (only if no limits hit)

### Phase 3: Response Header Analysis

Check all responses for rate limit headers:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`
- `Retry-After`
- Any custom Clay headers

### Phase 4: Recovery Testing

If rate limiting is observed:
1. How long until the limit resets?
2. Does making fewer requests immediately help, or is there a cooldown?
3. Is the limit sticky (account flagged) or transient (resets after window)?

## Findings

Resolved by INV-008 and INV-009 (2026-04-06). 20 rapid requests (INV-008): 0 rate-limited. 50 rapid requests (INV-009): 0 rate-limited. Avg latency 20ms. No rate-limit headers. 150ms Claymate baseline was a courtesy, not a requirement.

### Read Endpoint Results

| Frequency | Requests | Success | Failed | Avg Latency | Notes |
|-----------|----------|---------|--------|-------------|-------|
| 1/sec | -- | -- | -- | -- | -- |
| 2/sec | -- | -- | -- | -- | -- |
| 5/sec | -- | -- | -- | -- | -- |
| 10/sec | -- | -- | -- | -- | -- |

### Write Endpoint Results

| Delay | Requests | Success | Failed | Avg Latency | Notes |
|-------|----------|---------|--------|-------------|-------|
| 150ms | -- | -- | -- | -- | -- |
| 100ms | -- | -- | -- | -- | -- |
| 50ms | -- | -- | -- | -- | -- |
| 0ms | -- | -- | -- | -- | -- |

### Rate Limit Headers Observed

*None yet.*

## Implications

- Determines the safe pacing for production use
- Informs batch operation time estimates (e.g., "importing a 20-column schema takes ~3 seconds at 150ms pacing")
- May affect architecture design if limits are very restrictive

## Next Steps

*Based on findings.*
