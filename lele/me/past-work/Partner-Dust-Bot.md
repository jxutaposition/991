# Partner Dust Bot

## Client
Clay (internal) - Solutions Partner Operations

## Client Problems
As the Solutions Partner and Creator programs grow in operational complexity, partner-facing team members need a reliable way to access up-to-date information about program processes, policies, and partner-specific questions.

## Project Summary
AI knowledge bot built on Dust that ingests all internal and external partner documentation to provide recommended responses for partner-facing teams.

## Project Details
- Last updated by Lele Xu, Dec 19, 2025
- Knowledge sources: all Notion documentation, Partner Ops Documentation PDFs, clay.com/faq
- Used by partner-facing team members to quickly find accurate answers to partner, affiliate, and Rewardful program-related questions
- Configured with specific instructions and tested internally
- Part of the broader V2 Support Escalation System alongside Fin logic and Unwrap dashboards

## Tech Stack
- Dust, Notion, clay.com/faq

## Architecture Diagram
```
Knowledge Sources
     │
     ├── Notion (all partner docs)
     ├── Partner Ops PDFs
     └── clay.com/faq
            │
            v
      Dust Bot Engine
      (instructions +
       configuration)
            │
            v
   Partner-Facing Team
   (recommended responses)
```
