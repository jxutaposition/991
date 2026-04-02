# Rewardful Weekly Payout Processing

## Client
Clay (internal) - Solutions Partner Operations

## Client Problems
Partner commission payouts require weekly manual processing across multiple platforms (Rewardful, PayPal, Stripe), with exceptions for partners who need ACH, VAT invoicing, or have failed payouts.

## Project Summary
Weekly Monday AM workflow to process affiliate commissions via Rewardful, replenish PayPal funds, and generate commissions for manually attributed referrals.

## Project Details
- Every Monday: go to Rewardful payouts, select all partners EXCEPT those in the Payout Exceptions list
- Click "Pay with Paypal" until all standard affiliates are cleared
- For manual ACH payments, coordinate with Steve Sidhu in #proj-affiliate-operations
- Replenish PayPal: add $25K each from 2 Bank of America accounts ($50K total weekly)
- Generate commission for manually attributed referrals after 30-day waiting period
- Quarterly exceptions handled separately: no PayPal access, non-Stripe payments, VAT + invoice requirements, failed payouts
- 30-day hold period applies regardless of annual vs monthly plan
- Commission flow: Due > Generate Commission (manual click) > Pending > Stripe Payout > PayPal

## Tech Stack
- Rewardful, Stripe, PayPal, Bank of America, Slack (#workstream-partner-ops)

## Architecture Diagram
```
Rewardful (Commissions Due)
        │
        v
  Select All Partners
  (exclude exceptions)
        │
        v
  Pay with PayPal ──────> PayPal Account
        │                      ^
        │                      │
        │              Replenish $50K/week
        │              (2x $25K from BoA)
        │
  Manual Attribution ──> Generate Commission
        │                      │
        v                      v
  Stripe Processes ────> Partner PayPal

  [Quarterly Exceptions]
        │
        v
  Manual ACH / Invoice
  (via Steve Sidhu)
```
