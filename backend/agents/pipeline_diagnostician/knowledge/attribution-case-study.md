# Attribution System

## Client
Clay (internal) - Solutions Partner Operations

## Client Problems
Automatic affiliate link attribution frequently fails due to cookie issues, wrong links, or pre-existing email registrations, requiring a robust manual attribution fallback and support operations.

## Project Summary
Dual attribution system combining Rewardful's automatic cookie-based tracking with a manual attribution process using Typeform, Retool decision logic, and Slack-based status notifications.

## Project Details
- Automatic attribution via Rewardful: 20% revenue share assigned when customer uses partner's affiliate link, pays within 30 days, and uses a net-new email
- Manual attribution process: partner submits Typeform with partner email, customer email, workspace ID, referral URL, and screenshot proof
- Retool receives Typeform data and applies automated decision logic
- Slack bot posts outcomes (approved/rejected) in #auto_manual_attribution channel
- Common rejection reasons: customer already attributed to another partner, customer hasn't converted to paid, incomplete Typeform submission
- Approved manual attributions take 30-35 days to appear in Rewardful
- Common affiliate UX complaints: difficulty locating their affiliate link in the dashboard, confusion about payout mechanics and timelines
- Escalation path: partner disagrees > Slack thread in #workstream-partner-ops > tag @Bruno for exceptions
- Edge cases handled quarterly via invoices: no PayPal access, non-Stripe payments, VAT compliance, failed payouts

## Tech Stack
- Rewardful, Typeform, Retool, Slack, Stripe, PayPal, SFDC

## Architecture Diagram
```
Partner Referral
     │
     ├──> Affiliate Link Used ──> Rewardful Auto-Attribution
     │                                   │
     │                            30-day wait
     │                                   │
     │                            Generate Commission
     │                                   │
     │                            Stripe ──> PayPal
     │
     └──> Link Not Used ──> Manual Attribution Typeform
                                   │
                                   v
                              Retool Logic
                              (decision engine)
                                   │
                         ┌─────────┼─────────┐
                         v                   v
                     Approved            Rejected
                         │                   │
                         v                   v
                  #auto_manual_       Reason sent
                  attribution         to partner
                  (Slack bot)
                         │
                    30-35 days
                         │
                    Commission
                    generated
```
