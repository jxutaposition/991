# Methodology — Program Design

## Start with: what does one row represent?

Before designing any scoring, tiering, or tracking system: define the unit of analysis. Is this per expert? Per referral? Per post? If the unit is wrong, everything built on top of it is wrong.

## Tiering design process

1. **Gather the revenue distribution data first.** Don't set tier thresholds until you've seen the actual distribution of referral revenue and MRR across the existing member base. Intuitive thresholds are usually wrong.

2. **Define the scoring vectors** — which signals matter? (Revenue, content output, community participation, CSAT). Weight them. Write down the weighting rationale.

3. **Decide what resets and what doesn't.** Points that reset create anxiety and churn. Points that accumulate reward loyalty. Churn logic (points decay when MRR drops) is more nuanced than full resets — use it.

4. **Design visible progression.** Members should be able to see where they are, what the next level requires, and how close they are. Hidden scoring systems don't drive behavior.

5. **Separate internal and external views.** Some data (MRR, specific revenue figures) creates support friction if visible to all members. Design the dashboard with audience-appropriate visibility from day one.

## Program design anti-patterns

- Setting tier thresholds before seeing the data
- Building scoring systems that nobody can explain to a member
- Designing for the average member when the program is actually driven by the top 10%
- Adding a tier because it feels like there should be more tiers

## From design to build

Post the design in Slack before building anything. State: "Here's what I'm going to build, here's why, here's what I need from you." Proceed immediately unless a step is irreversible — irreversible steps require explicit sign-off.
