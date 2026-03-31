# Partner Tiering & Promotion System

## Client
Clay - Solutions Partners

## Overview
How to scale partner programs by introducing tiers with attractive benefits, comprehensive metrics, clear promotion criteria and timeline, performance dashboards, and proactive communication for promotions and demotions across Slack and email. 

## Strategic Motivation
Tiers incentivize partners to actively meet program requirements in order to receive more differentiated value. Tiers help the internal team know how to allocate resources across partners that service the largest enterprise customers (the most retentive segment), and how to help other partners improve their service. A 100+ people program without structure leads to top-performing partners complaining that they provide better services than other partners but clients cannot tell. Tiers without standardized, transparent metrics lead to partners who are the most vocal getting favorable treatments, and other partners complaining about fairness. Pre-tiering, Clay also lacked transparent lead distribution criteria and had no client satisfaction or capacity data to guide decisions.

## Outcomes
- Tiering drove engagement, created real career progression, and made swag/recognition feel earned
- Experts were proud to share their tier status publicly and used it as social proof to win new clients
- Enabled efficient segmentation of support and resources by tier level

## Project Summary
4-tier partner system (Artisan, Advanced Artisan, Studio, Elite Studio) with quarterly promotion cycles, annual demotion cycles, automated tiering dashboards, and coordinated multi-channel announcements. 

## Project Details
- 4-tier system implemented August 2025: Artisan, Advanced Artisan, Studio, Elite Studio
- 80-90% of expert applicants rejected or waitlisted monthly to maintain high service quality association with the program
- Separate influencer contracts created for high-exposure partners whose audiences aligned with Clay's ICP; content-driven leads from misaligned audiences had high churn
- Everyone starts as Artisan upon acceptance
- Promotion happens quarterly; demotion happens annually
- Automatic Tiering Dashboard built in Clay workbook tracks partner metrics
- Q1 2026 promotion cycle: data cutoff Dec 31, hand-off call Jan 6 (Michael, Bruno, Lele), tiers announced via email Jan 8, tooling changes by Jan 30, benefits distributed Feb 1
- Exception handling for demotions not driven by revenue (16 exceptions in Q1 2026)
- Post-promotion: update SFDC partner types, update PartnerPage, get Slack IDs via Clay HTTP call to Zapier endpoint, add to community channels
- Mass email system for tier announcements: Clay Comms table > Zapier > email from Inflection

## Metrics and Benefits
- Primary ranking metric: Referral ARR (revenue Clay makes from customers agencies bring in)
- Tiebreaker for top tiers: service revenue (revenue the agency earns)
- CSAT calculated from client form submissions that agencies send through their portal to active clients
- Co-selling and co-marketing support limited to top tier of fewer than 20 experts due to sales team bandwidth
- Additional benefit: differentiated badges that give credibility + differentiated gifting and custom graphics featuring tier
- Full metrics deck: https://docs.google.com/presentation/d/1H--G31QP04QptzA-VLBKLPmRX3WgJ7THAdRTc7YZKeg/edit?slide=id.g37028f6b983_0_696#slide=id.g37028f6b983_0_696 

## Tech Stack
- Clay (tiering dashboard, HTTP calls, Comms table), SFDC, PartnerPage, Zapier, Slack, Google Slides, Inflection

## Architecture Diagram
```
Clay Tiering Dashboard
(automated metric tracking)
         │
         v
  Quarterly Review
  (Michael, Bruno, Lele)
         │
    ┌────┼────┐
    v         v
Promote    Demote
(quarterly) (annually)
    │         │
    v         v
Update SFDC Partner Type
         │
    ┌────┼────────────┐
    v    v            v
Email  PartnerPage  Slack
(Clay  Update       Channel
Comms                Add
table                (Zapier
> Zapier)            HTTP)
         │
         v
   Swag/Benefits
   Distribution
```
