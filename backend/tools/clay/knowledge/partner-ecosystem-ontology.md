# Lele Xu - Partner Ecosystem Ontology

This ontology maps the objects, links, and actions across Clay's partner ecosystem operations.

---

## Object Types

### Core Program Objects

| Object | Description |
|--------|-------------|
| **Partner** | Solutions partner (consultancy/agency), used to be referred to as "Experts" earning commission on referred customers |
| **Creator** | Content creator producing Clay user-generated content |
| **Community Host** | Local event organizer running in-person Clay Club events (2-3 person teams) |
| **Partner Application** | Submission from a prospective partner, creator, or host |
| **Client** | End customer referred by a partner |
| **Referral** | Conversion attributed to a partner's effort |
| **Commission** | Revenue share payout to partner (20% of referred customer revenue) |

### Operational Objects

| Object | Description |
|--------|-------------|
| **Payout** | Weekly monetary distribution to partners via PayPal or ACH |
| **Tier** | Partner classification: Artisan, Advanced Artisan, Studio, Elite Studio |
| **Testimonial** | Client satisfaction validation from a partner's customer |
| **Certification** | Partner qualification/credential tracked in SFDC |
| **Event** | In-person Clay Club event hosted by a community host team |
| **Event Attendee** | Person who attends a Clay Club event |
| **Budget** | Allocated funds for host events ($1,500/event) or growth fund projects |
| **Growth Fund Project** | Partner/creator co-marketing initiative with Clay funding |

### System Objects

| Object | Description |
|--------|-------------|
| **Affiliate Link** | Trackable referral URL used by partners via Rewardful |
| **Attribution Record** | System entry linking a customer to a partner (automatic or manual) |
| **Support Ticket** | Issue escalation from a partner or partner-facing team |
| **Knowledge Base Article** | Documented answer/process for partner-facing teams (Notion, Dust Bot) |
| **Email Campaign** | Mass or targeted email to partners via Clay Comms table + Zapier |
| **Badge** | Digital credential (LinkedIn) awarded to partners/hosts |
| **Slack Channel** | Communication space for specific partner/program groups |
| **Partner Portal** | Self-service platform for partners to manage commissions and materials |
| **Swag Package** | Physical merchandise distributed by tier ($50-$170) |

---

## Link Types

### Program Membership

| Link | From | To |
|------|------|----|
| **belongs_to_program** | Partner / Creator / Host | Solutions Partner Program / Creator Program / Community Host Program |
| **has_tier** | Partner | Tier |
| **submits_application** | Prospective Partner / Creator / Host | Partner Application |
| **has_certification** | Partner | Certification |
| **receives_badge** | Partner / Host | Badge |
| **receives_swag** | Partner | Swag Package (based on tier) |

### Referral & Revenue

| Link | From | To |
|------|------|----|
| **refers_customer** | Partner | Client (via affiliate link or manual attribution) |
| **attributed_to** | Client | Partner |
| **has_attribution_method** | Referral | "automatic" or "manual" |
| **generates_commission** | Referral | Commission |
| **receives_payout** | Partner | Payout |
| **has_testimonial** | Partner | Testimonial |

### Events

| Link | From | To |
|------|------|----|
| **hosts_event** | Community Host | Event |
| **attends_event** | Event Attendee | Event |
| **has_team_composition** | Community Host | Roles (Technical, Logistics, Personality) |
| **uses_payment_method** | Host | "Ramp" or "Invoice" |

### Support & Growth

| Link | From | To |
|------|------|----|
| **escalates_to** | Support Ticket | Partner Ops team or Dust Bot |
| **references_knowledge** | Support Resolution | Knowledge Base Article |
| **receives_funding** | Growth Fund Project | Budget allocation |

---

## Action Types

### Application & Onboarding

| Action | Actor | Details |
|--------|-------|---------|
| **Submit Application** | Prospective Partner/Creator/Host | Via Typeform |
| **Auto-Screen Application** | System (Clay table + SFDC) | Checks MRR threshold, CSAT scores, certification |
| **Request Testimonials** | System (Zapier) | Sent to applicant's listed customer references |
| **Evaluate Application** | Lele (human reviewer) | Technical maturity, creative differentiation, production readiness |
| **Send Decision Email** | Inflection (email automation) | Acceptance, Rejection, or Waitlist |
| **Onboard Partner** | Lele / partner ops | Rewardful invite, PartnerPage entry, Portal invite, Slack channels, 30-min call |

### Attribution & Commission

| Action | Actor | Details |
|--------|-------|---------|
| **Track Affiliate Link Click** | Rewardful (automatic) | Customer clicks partner's affiliate link |
| **Process Automatic Attribution** | Rewardful | Customer uses link + pays within 30 days + new email → 20% commission |
| **Submit Manual Attribution** | Partner | Via Typeform with email, workspace ID, screenshot proof |
| **Evaluate Manual Attribution** | Retool decision engine | Checks duplicates, conversion status, completeness |
| **Notify Attribution Outcome** | Slack bot | Posts to #auto_manual_attribution |
| **Escalate Attribution Dispute** | Partner | Slack thread in #workstream-partner-ops, tag @Bruno |
| **Generate Commission** | Human (manual click) or System | Wait 30+ days after referral/approval |

### Payout Processing

| Action | Actor | Details |
|--------|-------|---------|
| **Process Weekly Payouts** | Lele | Every Monday AM, select partners, click "Pay with PayPal" until cleared |
| **Replenish PayPal Funds** | Lele | $50K weekly ($25K from 2 Bank of America accounts) |
| **Process Manual ACH** | Steve Sidhu | For partners without PayPal, via #proj-affiliate-operations |
| **Process Quarterly Exceptions** | Manual | VAT invoicing, non-Stripe payments, failed payouts |

### Tiering & Promotion

| Action | Actor | Details |
|--------|-------|---------|
| **Calculate Tiering Metrics** | Clay tiering dashboard | Automated: partner revenue, growth, quality |
| **Promote Partner** | Michael, Bruno, Lele | Quarterly manual review |
| **Demote Partner** | Manual review | Annual cadence |
| **Update Tier in SFDC** | System or manual | After promotion/demotion decision |
| **Update PartnerPage Listing** | Zapier or manual | Reflects new tier status |
| **Send Tier Announcement** | Zapier + Bruno's email | Via Clay Comms table |
| **Distribute Tier Swag** | Jessica Jin | Artisan $50, Studio $130, Elite Studio $170 |

### Community Host Program

| Action | Actor | Details |
|--------|-------|---------|
| **Recruit Host** | Prospective host | Word-of-mouth, ~3 apps/week |
| **Select Team Composition** | Applicant | 2-3 person team (Technical, Logistics, Personality) |
| **Choose Payment Method** | Host at onboarding | Ramp virtual card or Invoice (locked choice) |
| **Approve Ramp Transaction** | Human (Slack approval) | Vendor name + category visible |
| **Reimburse Invoice** | Finance team | Host pays upfront → submits invoice → reimbursed |
| **Send Event Invitations** | Clay system | IP-based city detection + Luma API |
| **Host In-Person Event** | Community Host team | $1,500 budget, 20-50 hrs planning/month |

### Growth Fund

| Action | Actor | Details |
|--------|-------|---------|
| **Submit Growth Fund Application** | Partner/Creator | Google Sheets form → Clay Application Table |
| **Evaluate Growth Fund Project** | Human reviewer | Co-marketing potential, partner capability, alignment |
| **Conduct Pre-Project Check-In** | Lele | Clarify expectations, timeline, deliverables |
| **Track Project Execution** | System (Clay) | Individual tracking pages per recipient |
| **Conduct Post-Project Check-In** | Lele | Measure outcomes, gather feedback |

### Support & Knowledge

| Action | Actor | Details |
|--------|-------|---------|
| **Receive Support Ticket** | Support team (Intercom/Fin) | Partner inquiry |
| **Auto-Respond** | Fin logic | Automated first-line responses |
| **Query Dust Bot** | Partner-facing team member | Searches Notion docs, Partner Ops PDFs, FAQs |
| **Escalate to Partnership Team** | Support team | Standardized Slack template → #workstream-partner-ops |
| **Track Support SLAs** | Unwrap dashboard | Ticket volume, resolution time, escalation % |

### Creator Program (Paused)

| Action | Actor | Details |
|--------|-------|---------|
| **Screen Creator Application** | System | 1-month usage check, response quality check |
| **Evaluate Against Rubric** | Human reviewer | Platform Reach, Activation Intent, Audience Clarity, Unique Voice |
| **Pause Creator Program** | Lele/Bruno/Jake Block | Update landing page, Typeform notice, hide FAQs, preserve access |
