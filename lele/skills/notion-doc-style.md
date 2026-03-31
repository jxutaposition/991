# Notion Document Style — Community-Facing 1-Pagers

Prompt for generating community-facing program 1-pagers in Notion (expert-facing, partner-facing, external stakeholder docs). NOT for client comms (Slack messages, emails to Bojana/Cristina). Derived from Lele's edits to the Expert Leaderboard 1-Pager (2026-03-27).

For higher-order voice principles that apply across ALL contexts (community docs, client Slack, emails), see `me/principles/voice.md`.

---

## When to use

Any time the agent creates a formatted Notion page intended for experts, partners, or external stakeholders. Especially: program announcements, leaderboard explainers, benefit summaries. This is a community-facing doc style — not a client comms style.

---

## Structure and ordering rules

1. **Open with a callout block (no icon, bold text).** One punchy line that captures the hook — what's in it for the reader. Lead with stakes/money, not gratitude. Example: "An industry ranking with real stakes ($$). And it's live now."

2. **Section order: WHY → REWARDS → HOW → CTA.** Do NOT put "how points work" before "what you win." People need the motivation before the mechanics.
   - Section 1: Why we launched this (gratitude + competition narrative)
   - Section 2: What it means to be at the top (cash prizes, perks)
   - Section 3: How to earn points (categories with details)
   - Section 4: See where you stand (link/embed)

3. **Use H2 headings with a single emoji prefix.** Examples: 📣 Why We Launched This, 🏆 What It Means to Be at the Top, 🎮 How to Earn Points, 🏁 See Where You Stand

4. **Use dividers between major sections** (between the callout and first section, between rewards and points, before CTA).

---

## Voice and tone

- Warm but not sycophantic. One sentence of gratitude, then move on.
- Split narrative into short paragraphs (2-3 sentences max per paragraph).
- Use "we" (HeyReach team voice), not "I."
- Fun/competitive energy is good — "household names," "not giving up their spots without a fight." Keep it concrete and vivid.
- Add a transitional line before the competitive narrative: "Also, we want this to be fun!"
- No filler like "seriously" or "something we're proud of every day" — cut to the substance.

---

## Points/mechanics formatting

- Use **numbered H3 subheadings** for each point category: "1. Content (LinkedIn)", "2. Community", "3. HeyReach MRR (All Workspaces You're In)", "4. Referrals (via Tolt)"
- For simple single-rule categories (e.g., Content = 1 reaction = 1 pt), use a plain paragraph — no table, no bullet.
- For multi-tier categories (MRR tiers, Referral tiers), use a **2-column Notion table** with column header row. Columns: descriptor | points.
- Community points: just a paragraph — "Awarded manually by the HeyReach team for standout contributions."
- Order categories by simplicity/familiarity: Content first, Community second, MRR third, Referrals last.

---

## Rewards section formatting

- Lead with a plain paragraph: "The leaderboard isn't just bragging rights — there's real money on the line."
- Put cash prizes in a **callout block with 💸 emoji**: "Quarterly prizes: $1,000 (1st) | $500 (2nd) | $300 (3rd)\nYearly prizes: $5,000 (1st) | $3,000 (2nd) | $1,000 (3rd)"
- Follow with "On top of that, top-ranked experts get:" then a **bulleted list** of perks.

---

## CTA / dashboard link

- If a live dashboard URL exists, use a **Notion embed block** with the URL — not a text placeholder.
- Always check if the actual URL is known before writing "[Link to dashboard]." If it exists in project files, embed it.
- Close with: "Questions? Reach out to Bojana directly."

---

## MRR labeling

- Use "All Workspaces You're In" not "your own workspace" — experts may be in multiple HeyReach workspaces and the MRR counts all of them.

---

## Anti-patterns (things the agent got wrong)

1. ❌ Putting "How points work" before "What you win" — rewards must come first
2. ❌ Using text placeholder "[Link to dashboard]" when the URL is known in project files
3. ❌ Overwriting the callout with a long intro paragraph — callout should be one bold hook line
4. ❌ Keeping all narrative in a single dense paragraph — break into 2-3 short paragraphs
5. ❌ Labeling MRR as "your own workspace" — it's all workspaces
6. ❌ Using bullets or tables for single-rule categories (Content = 1 reaction = 1 pt)
7. ❌ Omitting emojis from H2 headings in client-facing docs
8. ❌ Ordering point categories alphabetically instead of by simplicity (Content → Community → MRR → Referrals)
