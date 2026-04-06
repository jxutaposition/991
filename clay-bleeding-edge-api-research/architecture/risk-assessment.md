# Risk Assessment: Proprietary Clay API Layer

Last updated: 2026-04-05

## Risk Matrix

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| v3 API breaking changes | High | Medium | Version-pin frontend version header; comprehensive test suite; graceful degradation |
| Terms of Service violation | High | Low-Medium | Internal use only; no data resale; Claymate Lite (MIT) sets community precedent |
| Session cookie expiration | Medium | ~~High~~ **Low** | Auto-refresh on 401; **UPDATE (INV-008): cookie auto-refreshes on every API call via set-cookie header — effectively indefinite lifetime with regular use** |
| Rate limiting / blocking | Medium | ~~Medium~~ **Low** | ~~Conservative delays (150ms+)~~; **UPDATE (INV-008, INV-009): Zero rate limiting observed at 50 req/s. 150ms was unnecessarily conservative. Use 50ms for safety or remove delays entirely.** Exponential backoff retained as defensive measure. |
| 2FA/SSO auth complexity | Medium | Medium | Support manual session seeding as fallback for complex auth |
| Clay detects automation | Medium | Low | Use realistic user-agent; match Clay's own request patterns; no aggressive scraping |
| Data integrity issues | High | Low | Read-only by default; write operations require explicit confirmation; scratch table testing |

## Detailed Risk Analysis

### 1. v3 API Breaking Changes

**Risk**: Clay changes their internal API without notice, breaking our integration.

**Likelihood**: Medium. Internal APIs change frequently. However, Claymate Lite has been shipping against v3 for months, suggesting reasonable stability for core endpoints.

**Mitigation**:
- **Version pinning**: Capture `window.clay_version` during session extraction and send it in the `X-Clay-Frontend-Version` header. This tells Clay's backend which API version the "client" expects.
- **Integration tests**: Build a test suite that runs against a scratch Clay table weekly. Alert when tests fail.
- **Graceful degradation**: Every v3 operation has a fallback (Playwright or `request_user_action`). If v3 breaks, the agent degrades gracefully.
- **Endpoint monitoring**: The harness can periodically probe confirmed endpoints and alert on changes.

### 2. Terms of Service

**Risk**: Using undocumented APIs may violate Clay's ToS, leading to account suspension.

**Context**:
- Clay's ToS prohibits resale of data obtained from Clay
- Clay's ToS prohibits transferring Clay Credits
- There is no explicit prohibition of programmatic access in the referenced ToS sections
- Claymate Lite (MIT-licensed, 22+ stars, endorsed by GTM-Base community) uses the same v3 API
- Clay has not taken action against Claymate Lite

**Mitigation**:
- **Internal use only**: This API layer is for automating our own Clay workflows, not reselling access
- **No data exfiltration**: We read schemas and metadata, not bulk customer data
- **Match community norms**: Our usage pattern mirrors Claymate Lite (schema operations, column management)
- **Maintain Clay accounts in good standing**: Continue paying for credits and enterprise features normally
- **Document the ToS review**: If Clay releases updated ToS with explicit prohibitions, reassess immediately

### 3. Session Cookie Management

**Risk**: Cookies expire unpredictably, causing v3 operations to fail mid-execution.

**UPDATE (INV-008)**: Risk significantly reduced. The session cookie auto-refreshes on every API call via `set-cookie` response header. As long as the session is used at least once within the 7-day window, it effectively never expires. Proactive refresh logic is unnecessary.

**Mitigation**:
- **Health check before use**: Probe a lightweight endpoint before starting a multi-step operation
- **Auto-refresh on 401**: Detect auth failure and re-authenticate automatically
- ~~**Proactive refresh**: Once we learn cookie lifetime (INV-004), refresh before expiry~~ **RESOLVED (INV-008)**: Cookie lifetime auto-extends on every call. No proactive refresh needed — just use cookies normally.
- **Graceful degradation**: If session refresh fails, fall back to `request_user_action` with a clear message

### 4. Rate Limiting

**Risk**: Clay rate-limits or blocks automated requests.

**UPDATE (INV-008, INV-009)**: Risk significantly reduced. Tested at 50 req/s with zero rate limiting, no 429 responses, and no blocking. Clay does not appear to enforce request-level rate limits on v3 API calls authenticated via session cookies.

**Mitigation**:
- ~~**Conservative pacing**: 150ms minimum between v3 calls (matching Claymate Lite)~~ **UPDATED**: 150ms was unnecessarily conservative. Use 50ms for safety or remove delays entirely.
- **Exponential backoff**: On 429 or connection errors, back off exponentially (retained as defensive measure)
- **Per-client isolation**: Each client has its own session, spreading load
- ~~**Batch awareness**: For multi-column creation, estimate total time (150ms * N columns) and warn the agent~~ **UPDATED**: With near-zero delay needed, batch time estimates are negligible.
- **No parallel writes**: Serialize write operations to a single table

### 5. Authentication Complexity

**Risk**: Users have diverse auth setups (2FA, SSO, hardware keys) that resist automation.

**Mitigation**:
- **Start with email/password**: Cover the simplest case first
- **Manual session seeding**: For complex auth, let the user export and paste cookies
- **Headed browser mode**: For SSO/2FA, launch a visible browser window for the user to authenticate, then extract cookies
- **Session reuse**: Once authenticated, reuse the session as long as possible to minimize re-auth

### 6. Automation Detection

**Risk**: Clay detects and blocks headless browsers or automated request patterns.

**Mitigation**:
- **Realistic browser fingerprint**: Use Playwright's default Chromium with standard user-agent
- **Match Clay's own patterns**: Send the same headers Clay's frontend sends (Content-Type, Accept, X-Clay-Frontend-Version)
- **No aggressive patterns**: Avoid rapid-fire requests, parallel connections, or unusual access patterns
- **Cookie-based requests**: For v3, we're replaying real browser cookies, not generating synthetic auth

### 7. Data Integrity

**Risk**: Automated schema operations create malformed columns or corrupt table structure.

**Mitigation**:
- **Read-only by default**: New tools start in read-only mode; write operations require explicit opt-in
- **Scratch table testing**: Test all write operations on disposable tables before touching production
- **Validation before write**: Check that column references exist, types are valid, dependencies are satisfied
- **Rollback awareness**: Document that column creation is not transactional -- partial failures are possible
- **Audit trail**: Log every v3 write operation with full request/response for debugging

## Contingency Plan

If Clay actively blocks programmatic access:

1. **Immediate**: Fall back to `request_user_action` for all structural operations (current behavior)
2. **Short-term**: Investigate if Clay offers a partner/developer API program
3. **Medium-term**: Engage Clay directly about enterprise API access for agency tooling
4. **Long-term**: If Clay launches a public API (rumored but not confirmed), migrate to it

The architecture is designed so that the fallback chain works automatically -- removing Layer 2 (v3) or Layer 3 (Playwright) just means more operations go to `request_user_action`.
