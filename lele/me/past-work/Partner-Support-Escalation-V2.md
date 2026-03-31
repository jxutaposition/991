# V2 Partner Support Escalation System

## Client
Clay (internal) - Solutions Partner Operations, cross-functional with Support (Katie Dougherty)

## Client Problems
Partner-related support tickets lack standardized escalation paths, causing excessive tagging of the partnership team and slow resolution times.

## Project Summary
Redesign of the partner-to-support escalation system using Unwrap dashboards, Fin logic, Dust bot, and Slack workflow templates to reduce partnership team involvement and speed up resolution.

## Project Details
- Goal: faster resolution of partner support issues with fewer direct tags on the partnership team
- Implementation approach: clarity on percentage of partner-related tickets that get escalated, plus SLA tracking
- Unwrap dashboards for visibility into total partner-related ticket volume and trends
- Fin logic updates for automated first-line responses to common partner questions
- Dust bot integration to provide partner-facing team members with accurate, up-to-date answers sourced from Notion, Partner Ops PDFs, and clay.com/faq
- Slack template for standardized escalation format
- Status: In progress (as of Dec 2025)

## Tech Stack
- Unwrap, Fin (Intercom), Dust, Slack, Notion

## Architecture Diagram
```
Partner Support Ticket
         │
         v
  Fin (Auto-Response)
  ┌──────┼──────┐
  v              v
Resolved     Escalation
              Needed
                │
                v
         Slack Template
         (standardized)
                │
                v
         #workstream-
         partner-ops
                │
         ┌──────┼──────┐
         v              v
   Dust Bot          Human
   (knowledge        Review
    lookup)
         │
         v
   Unwrap Dashboard
   (tracking & SLAs)
```
