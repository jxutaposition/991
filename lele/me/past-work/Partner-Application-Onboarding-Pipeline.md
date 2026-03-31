# Partner Application & Onboarding Pipeline

## Client
Clay (internal) - Solutions Partner Operations

## Client Problems
Managing a high volume of partner applications (50 / month) with varying quality levels, incomplete materials, and the need to balance both automated screening and human judgment in acceptance decisions.

## Project Summary
End-to-end pipeline for Solutions Partner applications covering submission, automated/manual decision-making, communications, and onboarding into the Clay ecosystem.

## Strategic Considerations
- Keep program quality by admitting the most astounding, complex, creative, and fast-growing Clay experts.
- Keep human touch with 1:1 onboarding calls focused on understanding each expert's business-specific goals (not generic program Q&A)
- Most common expert questions during onboarding: how to maximize program value, ideas for webinars, and unlocking specific Clay use cases for their business
- Many experts applied two or three times, this is a good sign of motivation to grow through the program.
- A multi-stage application process that included client testimonials sets up the right expectation after partners were accepted, that they need to keep a high standard of service to move through the program.
- An incomplete application shows that the applicant may have applied for the wrong reason, aka easy branding.
- The more reasonably exclusive the application process, the better the reputation of the program and the higher the value of a partner badge. The anti-example is certifications that were fully automated with experts pointing out on Linkedin that it could be gamed = less valuable.

## Project Details
- Applications submitted via Typeform, pushed to a Clay Solutions Partner Application table
- Automated receipt confirmation email sent immediately via Inflection
- Client testimonial requests triggered automatically via Zapier to applicant's listed references
- Automated waitlist: Clay table checks SFDC daily for certifications; checks testimonials from 2 original + 2 optional new clients
- Automated rejection for low MRR or low CSAT scores
- Manual review in first week of each month for "In Review" applicants (materials complete, passed auto-checks)
- Manual evaluation criteria: technical maturity, creative differentiation, production readiness
- Accept top 10%~20% per month; moved away from Loom submissions because they favored self-promotion over table quality
- Rolling waitlist emails fire every 2 weeks with specific missing items
- Approval/rejection emails fire once per applicant (7-60 day window)
- Applications >60 days with missing materials auto-rejected without email
- Onboarding: custom graphic lookup in Clay, Rewardful invite, PartnerPage entry review, Clay Portal invite, Slack channel additions, 30-min onboarding call via Calendly

## Tech Stack
- Typeform, Clay (tables), Salesforce (SFDC), Zapier, Inflection, Rewardful, PartnerPage, Slack, Calendly, Loom

## Architecture Diagram
```
Typeform ──> Clay Application Table ──> SFDC Status Update
                    │
    ┌───────────────┼───────────────┐
    v               v               v
 Waitlist        Reject          Accept
 (missing       (low MRR/       (manual
  materials)     CSAT/table)     review)
    │               │               │
    v               v               v
 Biweekly       Decision        Decision
 Email          Email via       Email via
 (Inflection)   Inflection      Inflection
                                    │
                        ┌───────────┼──────────┐
                        v           v          v
                    Rewardful   PartnerPage  Slack
                    Invite      Entry        Channels
                        │           │          │
                        └───────────┼──────────┘
                                    v
                              Onboarding Call
                              (Calendly)
```
