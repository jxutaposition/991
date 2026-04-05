# Tolt Platform Knowledge

## How Tolt Works

Tolt is an affiliate and referral management platform. It tracks:
- **Partners** — affiliates/referrers with unique tracking links
- **Referrals** — customers referred by partners
- **Revenue** — referral revenue, MRR, and churn per partner
- **Commissions** — earned and pending payouts
- **Groups** — partner segments controlling commission rates and visibility

## Core Concepts

### Partner Groups

Groups determine commission rates, dashboard visibility, and program tier. Common operations:
- Assign partners to groups on onboarding
- Reassign when partners change tiers
- Bulk reassignment via CSV import

### Revenue Data

- Referral revenue (one-time conversions)
- MRR (recurring revenue from referred customers)
- Churn events (cancellations)
- Revenue data feeds scoring systems for partner program tiering

### CSV Operations

Bulk partner management:
1. Export current group membership
2. Process changes (tier upgrades, group reassignment)
3. Import updated CSV
4. Verify sample records

## Integration Patterns

- **Tolt -> Clay:** Revenue/MRR data flows into Clay expert tables for scoring
- **Tolt -> n8n:** Webhook triggers on new referrals or commission events
- **Tolt -> Lovable:** Commission data feeds dashboard displays (internal view only)
- **CSV -> Slack -> n8n -> Tolt:** Automated group reassignment workflow
