# LELE-013: Privacy, Agency Onboarding, and Legal Review

## Problem
The browser extension captures GTM expert behavior including URLs, click targets, and form field names. Some of this data is commercially sensitive (prospect names in URLs, deal info in CRM pages). We need a clear privacy framework, explicit consent flow, and legal review before any external expert sessions.

## Data Classification

| Data type | Captured | Stored | Retention |
|-----------|----------|--------|-----------|
| URLs visited | Yes | Yes | 2 years |
| Click element type + text (capped 100 chars) | Yes | Yes | 2 years |
| Form field names (not values) | Yes | Yes | 2 years |
| Input field values | Never | Never | N/A |
| Password fields | Never | Never | N/A |
| Screenshots (page state) | Yes (30s intervals) | Yes | 1 year |
| Prospect names (in URLs) | Incidentally (via URLs) | Yes | 2 years |
| Email content | No | No | N/A |

## Expert Consent Flow

1. **Installation consent:** Extension install page shows a plain-English data collection summary. "lele captures what pages you visit and what you click on our approved domains. It never captures passwords, form values, or personal messages."

2. **Session-level consent:** Each recording session requires explicit "Start Recording" action. The expert sees a 3-sentence reminder before recording begins.

3. **Correction rights:** Expert can submit corrections to any narration at any time during or after the session. Corrections replace the narrated interpretation as ground truth.

4. **Deletion rights:** Expert can request deletion of any observation session via the dashboard. Deletion cascades: action_events, distillations, abstracted_tasks, screenshots (MinIO deletion).

## Agency Onboarding Checklist

Before an external agency expert can use the platform:
- [ ] Signed data processing agreement (DPA)
- [ ] Confirmation that the expert has authority to capture their own workflow data
- [ ] Review of domain allowlist (they approve which domains will be captured)
- [ ] Notification that their employer's data may be incidentally captured (prospect names in CRM URLs)
- [ ] 30-minute onboarding call with the lele team

## Legal Review Items (blocking for external experts)
- GDPR compliance for EU experts (lawful basis for processing observation data)
- CCPA compliance for CA-based experts
- Whether capturing CRM URLs containing prospect names constitutes PII processing under GDPR
- Employment agreement review — does the expert's employer own their workflow IP?
- Terms of service for captured domains (LinkedIn ToS prohibits scraping — legal opinion needed)

## v0 Scope
For v0 (self-shadow / dogfood): Only the founding team captures sessions. No external experts. Legal review deferred to v1.

## Acceptance Criteria (v1, external experts)
- [ ] Explicit consent flow at install and session start
- [ ] Deletion pipeline: session + all derived data deleted within 24 hours of request
- [ ] DPA template drafted and reviewed by counsel
- [ ] Domain allowlist configurable per-expert
- [ ] Privacy policy covering observation data written and published
