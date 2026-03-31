# Rewardful Complaints & Vendor Evaluation

## Client
Clay (internal) - Solutions Partner Operations

## Client Problems
Rewardful's limitations generate ~20 support tickets/week across onboarding, attribution, and payment categories, creating significant operational overhead and partner dissatisfaction.

## Project Summary
Systematic documentation of Rewardful pain points across onboarding, cookie-based attribution, manual attribution, payment processing, and analytics to build the case for evaluating alternative vendors (e.g., PartnerStack).

## Project Details
- Onboarding issues: affiliate invites still sent manually (no API automation yet)
- Cookie-based attribution (~10 tickets/week): affiliates confuse Rewardful link with in-app referral link, cookie disappears on landing page, rejected cookies break tracking, false fraud flags on affiliate-created client workspaces
- Manual attribution (~5 tickets/week, high urgency): rejected when customer already attributed even if same partner is asking, no status visibility for affiliates, need to delete existing attribution for re-attribution, must manually click "generate commission" for every approved manual attribution
- Payment process (~5 tickets/week, highest urgency): no automated failure notifications, VAT compliance requires quarterly manual invoicing, payments not tracked if customer pays outside Stripe, PayPal-only payout method hurts international partners, 30-day hold regardless of plan type, up to 2-week payout processing with no visibility
- Analytics gap: no distribution curve of affiliates by revenue, no traffic source analysis for top performers
- Managed revenue gap: no way to track/reward partners for managed revenue vs. originated revenue
- Consolidation approach: multiple individual issues grouped under "Evaluate Rewardful Managed Payout or PartnerStack" as a unified solution

## Tech Stack
- Rewardful, Stripe, PayPal, PartnerStack (evaluation target), Retool, Slack

## Architecture Diagram
```
Rewardful Pain Points
     │
     ├── Onboarding: Manual invites
     │
     ├── Attribution: Cookie failures ──> ~10 tickets/week
     │       │
     │       └── Manual fallback ──> ~5 tickets/week
     │
     ├── Payment: No ACH, no VAT, ──> ~5 tickets/week
     │            no failure alerts
     │
     ├── Analytics: No distribution
     │              or traffic data
     │
     └── Managed Revenue: No tracking
                          mechanism

     Consolidated Solution Path:
     ┌─────────────────────────────┐
     │ Evaluate Rewardful Managed  │
     │ Payout OR PartnerStack      │
     └─────────────────────────────┘
```
