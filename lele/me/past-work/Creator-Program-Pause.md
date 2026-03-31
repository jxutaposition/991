# Creator Program Pause

## Client
Clay (internal) - Solutions Partner Operations, collaborating with Bruno and Jake Block

## Client Problems
The Creator program had grown to 775 members with ~50 applications/month, but lacked clear ROI and was losing dedicated resourcing, requiring a clean operational pause while preserving program reputation.

## Project Summary
Coordinated pause of the Clay Creator program across all touchpoints - landing page, Typeform, FAQs, knowledge bases, and support tooling - while retaining existing members and signaling future reopening.

## Project Details
- Decision to pause driven by reduced resourcing and no clear ROI
- All pending applications received a decision before Dec 19, 2025 cutoff
- Creator landing page updated: removed application link, added "under construction" notice with March 18, 2026 target reopening
- Typeform updated with notice that submissions after Dec 19 will not be reviewed
- External FAQs hidden from clay.com/faq, Dust, Fin, and Support knowledge base
- Application-related FAQs hidden; general program FAQs edited to mention pause
- Preserved: community Slack channels, Rewardful access for pre-May 2025 creators, UGC/gifting campaigns, SFDC contact records
- Creator application process had been: Typeform > Clay import > automated screening (1-month usage + response quality) > evaluation rubric (Platform Reach, Activation Intent, Audience Clarity, Unique Voice) > social screening > decision logging > SFDC sync > Inflection email + Zapier Slack graphic via Yarn

## Tech Stack
- Typeform, Clay, SFDC, Zapier, Inflection, Yarn, Slack, Webflow CMS, Dust, Fin

## Architecture Diagram
```
BEFORE PAUSE:
Typeform ──> Clay Import ──> Auto Screen
                                  │
                          ┌───────┼───────┐
                          v               v
                       Reject          Evaluate
                       (<1 month       (Rubric Score)
                        or vague)          │
                          │               v
                          v          Social Screen
                    Inflection           │
                    Email                v
                                   Log Decision
                                        │
                                        v
                                   SFDC Update
                                        │
                              ┌─────────┼──────────┐
                              v                    v
                        Inflection           Zapier > Yarn
                        Email                > Slack Graphic

AFTER PAUSE:
Landing Page ──> "Under Construction" notice
Typeform ──> "Not Reviewed" notice
FAQs ──> Hidden / Edited
```
