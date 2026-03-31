# HeyReach Subscriptions Table — User Behavior Tracking - Subscription Data(p)

## Location
- **Clay workspace:** heyreach.io / Production
- **Table URL:** https://app.clay.com/workspaces/245061/tables/t_79dKSUJaQ7zH/views/gv_2WYKnMzTaob8
- **Table ID:** t_79dKSUJaQ7zH
- **Row count:** 38,603 (as of 2026-03-28)
- **Column count:** 74 (52 visible in Default View)

## How it connects to the Experts table
- The Experts table (wb_2U5ACV8e6dui, table t_0szso2eGT3y7WXCkyhY) has a **"lookup mrr"** column
- That column is a Clay Lookup Table enrichment that searches this subscriptions table
- **Target Column:** Email (admin/owner)
- **Filter Operator:** Contains
- **Row Value:** Email (from experts table)
- Matching looks up subscription/MRR data by matching the expert's email against the admin/owner email

## Schema (52 visible columns in Default View)

| # | Column Name | Type | Notes |
|---|-------------|------|-------|
| 1 | Webhook | Source | Webhook ingestion timestamp |
| 2 | Plan(free/paid) | Text | "Free", "active", "canceled" |
| 3 | Last Name | Text | Subscriber last name |
| 4 | Company Name | Text | Company/org name |
| 5 | First Name | Text | Subscriber first name |
| 6 | Tenant Id | Number | HeyReach tenant ID |
| 7 | Email (admin/owner) | Text | Primary email, used for lookup |
| 8 | Tenant Id (2) | Number | Duplicate tenant ID |
| 9 | Business Domain | Text/Formula | Company domain |
| 10 | Subscription Data | Enrichment | Status codes from API |
| 11 | White Label | Text | "true"/"false" |
| 12 | Stripe Customer Email | Text | Stripe billing email |
| 13 | Stripe Customer Id | Text | Stripe customer ID (cus_...) |
| 14 | Credits- Total Quantity | Number | Total credits purchased |
| 15 | Credits- Total Amount Paid | Number | Total amount paid for credits |
| 16 | First Purchase Date | Text | Date of first purchase |
| 17 | Initial Amount Paid | Number | First payment amount |
| 18 | Initial MRR | Number | Initial monthly recurring revenue |
| 19 | Subscription Id | Text | Subscription identifier |
| 20 | Product Name | Text | Product/plan name |
| 21 | Stipe Domain | Text | Domain from Stripe |
| 22 | Start Trial Date | Text | Trial start date |
| 23 | Promotion Code | Text | Promo code used |
| 24 | Created At | Text | Record creation timestamp |
| 25 | Updated At | Text | Last update timestamp |
| 26 | Subscription Start Date | Text | Subscription start |
| 27 | Subscription End Date | Text | Subscription end |
| 28 | Billing Cycle (m/q/a) | Text | Monthly/quarterly/annual |
| 29 | Next Recharge Date | Text | Next billing date |
| 30 | Cancellation Date | Text | Cancellation date |
| 31 | Monthly Payment | Number | Monthly payment amount |
| 32 | Total Sum Paid | Number | Lifetime payment total |
| 33 | Promotion Code Id | Text | Promo code ID |
| 34 | Formatted Initial MRR | Text | Display-formatted MRR |
| 35 | Formatted Initial Amount Paid | Text | Display-formatted amount |
| 36 | Final Domain | Text | Resolved company domain |
| 37 | Locality Final | Text | City/locality |
| 38 | Country Final | Text | Country code |
| 39 | Website Url Final | URL | Company website |
| 40 | Employee Count Final | Number | Employee count |
| 41 | Final Company Url + Backup UB | URL | Company URL with fallback |
| 42 | Final Email Status | Text | Email validity status |
| 43 | Final Company Type | Text | Company type classification |
| 44 | Final Tier | Text | Tiering (T1/T2/T3) |
| 45 | New Stripe to Hubspot | Enrichment | Stripe-Hubspot sync |
| 46 | Stripe to Hubspot- Company Level | Enrichment | Company-level sync |
| 47 | Self Tiering | Enrichment | Auto-tiering |
| 48 | Master View | Enrichment | Master view lookup |
| 49 | >5m- Notify Vuk | Enrichment | Alert for >5M companies |
| 50 | Send to DNC GS | Enrichment | Do-not-contact sync |
| 51 | Active DNC | Enrichment | Active DNC flag |
| 52 | Push to Intercom | Enrichment | Intercom integration |

## Key fields for expert email lookup
- **Email (admin/owner)** — the primary email used by the lookup enrichment
- **First Name** + **Last Name** — subscriber identity
- **Company Name** / **Business Domain** — company info
- **Plan(free/paid)** — subscription status
- **Initial MRR** / **Monthly Payment** — revenue data
