# Partner Growth Fund

## Client
Clay (internal) - Solutions Partner Operations

## Client Problems
Need a scalable way to co-market Clay with the partner community beyond standard affiliate commissions, enabling partners and creators to pursue business ideas with funding and distribution support.

## Project Summary
One-off funding program for Clay Solutions Partners and Creators to co-market Clay, with application tracking, evaluation criteria, pre/post-project check-ins, and recipient tracking.

## Project Details
- Launched September 2025 as a scaled co-marketing initiative
- Open to Solutions Partners and Creators for one-off funding, distribution, and support
- Application flow: Notion Landing Page > Application Form (Google Sheets) > Clay Application Table evaluation > Approval/Rejection with documented copy
- Internal resources: FAQs, SOP, evaluation criteria, approval/rejection email copy
- Pre-project and post-project check-in forms for funded recipients
- Partner Fund Recipient Tracking table for accepted applicants with individual tracking pages per recipient
- Recipients tracked include partners from multiple agencies (Growth DNA, Noord50, ViewIn, Fuel GTM, Nathan's Bootcamp, Platinum Agency, Saleslift Studio, Closed In)
- Program paused Q1 2026 due to missing owner; as of Jan 28, Siya Verma is the new owner

## Tech Stack
- Notion, Google Sheets, Clay (Application Table), Slack

## Architecture Diagram
```
Notion Landing Page
        │
        v
  Application Form
  (Google Sheets)
        │
        v
  Clay Application Table
  (evaluation criteria)
        │
   ┌────┼────┐
   v         v
Accept    Reject
   │         │
   v         v
Approval  Rejection
Copy      Copy
   │
   v
Pre-Project Check-In
   │
   v
Funded Project Execution
   │
   v
Post-Project Check-In
   │
   v
Recipient Tracking Table
```
