# Clay Clubs - Community Host Program

## Client
Clay (internal) - Growth Programs

## Client Problems
Clay needed a scalable way to build local community presence and brand trust in cities worldwide. Centrally organized events don't scale, and one-off hosts lack accountability and consistency.

## Project Summary
Persistent community host program where teams of 2-3 local organizers run recurring in-person Clay events in their cities, funded by Clay with a blanket budget, creating indirect lead generation through personal brand growth and network effects.

## Project Details

### Program Structure
- Purely brand/reputation-based — hosts receive no commission or revenue share
- Hosts get LinkedIn badges (like partners and creators), but the primary value is being the recognized Clay expert in their local community
- Indirect lead generation: attendees message hosts on LinkedIn, build trust through the grapevine, and eventually become clients through other channels
- Emphasis: "Do not try to sell at this event" — events only work if hosts give knowledge freely

### Team Composition
- Ideal team: 2-3 people per Clay Club (never solo)
- Three archetypes:
  1. **Technical product expert** — deep Clay knowledge
  2. **Event logistics person** — venue, planning, coordination
  3. **Personality hire** — good at 1:1 outreach to attendees
- Solo hosts failed: no accountability, tendency to sell at events (bad attendee feedback), and burnout from 20-50 hours/month of planning
- Multi-person teams share the load and hold each other accountable; only one person needs to initiate the next event

### Recruitment
- Word of mouth — people see Clay Club events on LinkedIn and apply to host in their own city
- ~3 applications per week
- Teams are persistent/permanent, not one-off

### Payment Operations (Evolution)
1. **Phase 1 (~30-50 hosts): Invoices** — hosts submitted invoices after events. Constant back-and-forth on approval status, payment delays, and line-item disputes.
2. **Phase 2 (scaled to 150 active, 200+ total): Ramp virtual cards** — hosts received virtual Ramp cards. Problem: some forgot to use Ramp, still requested invoices, creating double-tracking burden for finance.
3. **Final state: Choose at onboarding** — hosts must choose Ramp OR invoices and stick with it. Ramp payments are automated with Slack approval for each transaction. Invoice amounts tracked against budget limit by the team. Eliminated the cross-team friction between partner ops and finance.
- Blanket $1,500 budget per event regardless of city
- Ramp purchases require a Slack approval step (vendor name + category visible)
- Invoice route requires upfront payment by host, then reimbursement

### Event Invitations (Automated)
- Clay mailing list (users, leads, prospects) filtered by IP-based city detection
- Automated email sends to people detected in the host's city
- Technical challenge: IP-to-city API returned misspelled or variant city names that didn't match Luma event locations, breaking the automation
- Solution: Clay table with AI column to standardize city names against Luma API

### Fraud & Budget
- Minimal fraud detected; suspected minor rounding up in cheaper cities
- Some hosts negotiated year-long venue contracts, reducing per-event costs — considered acceptable resourcefulness
- Cheaper cities require more outreach effort (non-tech hubs), so blanket budget balances out

### Attribution Challenge
- QR codes at events, but most attendees already have Clay accounts
- Attribution only triggers on net-new accounts that convert to paid — so event hosts rarely get direct attribution credit
- This is by design: the program is brand, not revenue

## Tech Stack
- Ramp (virtual cards, Slack approval workflow)
- Luma (event hosting platform)
- Clay (mailing list, IP-based city detection, AI column for city standardization, invitation automation)
- Slack (Ramp approval notifications)
- LinkedIn (host badges, organic inbound from attendees)

## Architecture Diagram
```
Host Application (LinkedIn word-of-mouth)
        |
        v
  Team Formation (2-3 people)
  [Technical + Logistics + Personality]
        |
        v
  Onboarding: Choose Payment Method
        |
   ┌────┴────┐
   v         v
 Ramp      Invoices
 (virtual   (upfront pay,
  card)      reimburse)
   |         |
   v         v
 Slack     Team tracks
 Approval  amounts vs limit
        |
        v
  Event Planning (~20-50 hrs/month)
        |
        v
  Event Invitations (Automated)
  Clay Mailing List ──> IP City Detection
        |                    |
        v                    v
  AI Column             Luma API
  (standardize          (event
   city names)           lookup)
        |                    |
        └────────┬───────────┘
                 v
          Email Invites Sent
                 |
                 v
          In-Person Event (Luma)
          [$1,500 budget]
                 |
                 v
          Indirect Lead Gen
          (LinkedIn inbound,
           personal brand,
           network effects)
```
