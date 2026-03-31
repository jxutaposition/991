# HeyReach — n8n Access

**URL:** https://heyreach.app.n8n.cloud
**Login:** woshicorp@gmail.com / jinshanjinMe1lly!
*(Password reset and confirmed working 2026-03-18)*

**API Key (woshicorp account, label: "Lele 2.0 Agent", no expiration, created 2026-03-23):**
`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3YjdkMzlhYi05NGYwLTRhNTEtODg3Yi0zYjJlZjZiMjA3M2EiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiNTNlNjc3ZTgtZjZhNS00ZDBhLWEyZmQtMmM2MGZkODEzOGYyIiwiaWF0IjoxNzc0Mjk3Mjc3fQ.TB2jryXYdfHhfUB4Bh1Z-js_PswMeZpARoACAfTOfZs`

---

## Workspace stats (as of 2026-03-18)
- Total workflows: 121 (3 pages, 50/page)
- Prod. executions: 883 (+27.27%)
- Failed prod. executions: 17
- Failure rate: 1.9%
- Avg. run time: 3.23s

## Projects (sidebar)
- **Home / Overview** — shared workspace
- **Spremo** — separate project (Leon Spremo's scope)
- **Personal** — personal project (woshicorp account)

---

## Umer's workflows (umer@heyreach.io)

These are the workflows directly relevant to Lele's scope:

| Workflow | Status | Last Updated | Notes |
|---|---|---|---|
| **Creator Program** | Published | 8h ago (2026-03-18) | Active — likely handles creator onboarding/points |
| **Expert Program** | — | 2 weeks ago | Expert program automation (onboarding, points, welcome) |
| **Do Not Open/Edit/Pause - Umer** | Published | 1 month ago | Critical live workflow — do not touch |
| **Feedback form** | Published | 3 weeks ago | Typeform/feedback intake |
| **Meeting- Send to Clay** | Published | 1 month ago | Sends meeting data to Clay table |
| **Name Tags Generator** | Published | 1 month ago | Generates name tags (likely for events) |
| **Add Leads To campaign** | — | 1 hour ago | HeyReach campaign automation |
| **Update Hubspot- HeyReach** | — | 1 hour ago | HubSpot sync |
| **Outbound Reply Manager** | — | 2 months ago | Manages LinkedIn outbound replies |
| **Outbound Reply Agent** | — | 2 months ago | AI agent for reply handling |
| **Instantly X HeyReach stop Lead** | — | 1 month ago | Stops leads across Instantly + HeyReach |
| **Instantly stop lead** | — | 1 week ago | Stops leads in Instantly |
| **Experts Send** | — | 1 month ago | Expert communications send workflow |
| **James- Workflow** | — | 2 months ago | Workflow for "James" (unknown context) |
| **My workflow 41** | — | 1 month ago | Unnamed/draft |
| **My workflow 42** | — | 1 month ago | Unnamed/draft |
| **My workflow 44** | — | 1 month ago | Unnamed/draft |
| **My workflow 50** | — | 2 weeks ago | Unnamed/draft |
| **Umer Test x milo** | — | 2 months ago | Testing workflow with Milomir |
| **Document Upload RAG Chatbot with Pinecone Embeddings and Daily Analytics** | — | 2 months ago | AI/RAG chatbot |
| **N8n stats** | — | 3 months ago | Internal n8n stats tracking |

---

## Other notable workflows (not Umer)

| Workflow | Owner | Status | Notes |
|---|---|---|---|
| MasterInbox Meeting Booked - Remove Same Domain Pending Leads | Leon Spremo | Published | LinkedIn inbox automation |
| LinkedIn Workflow Intel - MVP v3 | Leon Spremo | — | LinkedIn intelligence |
| HeyReach Reply Sentiment Analysis | Hassan Siddiqui | — | Sentiment on replies |
| Password Reset Request Workflow | Hassan Siddiqui | Published | — |
| HeyReach Reporting System | Hassan Siddiqui | Published | — |
| Account Disconnection Alert | Hassan Siddiqui | — | Alerts on account disconnection |
| Payoneer Automation | Leon Spremo | — | Payment automation |
| Add Leads To Follow-Up Campaign | Hassan Siddiqui | — | Follow-up campaign leads |
| HeyReach Lead Transfer with Sender Assignment | Hassan Siddiqui | — | Lead transfer |

---

## Key context for Lele's workflows

**Expert Program workflow** (ID: TBzlVQvH31cJjMJ9) — Umer's workflow, created Nov 2025, updated 2 weeks ago. Structure:
- Trigger: Typeform "Expert trigger" (form ID: zacepLEy)
- Merge2 → Slack: Search for messages + Add a reaction / Slack: Send message and wait for response
- Merge3 → Switch (Rules) → Approved Experts (addToCampaign) / Rejected Experts (addToCampaign)
This is an expert application approval/rejection workflow. There is NO existing Tolt webhook → Slack DM welcome message — that needs to be built from scratch.

**Creator Program workflow** (ID: UzgP5iLVxAd9zKru) — Published, updated today. Mirror structure to Expert Program:
- Trigger: Typeform "Creators" (form ID: 7cbniyQ)
- Code in JavaScript node → Merge → Slack approve/reject flow → Approved Creators / Rejected Creators (addToCampaign)
- Error path: Error Trigger → Slack message
Creator application approval workflow. Active and running.

**Do Not Open/Edit/Pause - Umer** — Live published workflow. Don't edit without Umer's sign-off.

---

## Test workflow

**Creator Program - TEST (Lele bot)** — ID: `iYaLRShxaCRe2W3b`
- Duplicate of Creator Program (`UzgP5iLVxAd9zKru`)
- "Send message and wait for response" node: credential = **Creators AND Experts**, channel = **#heyreach-lele**
- Use this to test whether the approval flow works end-to-end with a bot Lele controls

---

## Workflows Lele needs to build (from open-threads)

1. **Tolt webhook → Slack DM on expert join** (with Bojana's Calendly link) — new workflow to build; awaiting message copy from Bojana
2. **CSV group update** — BUILT (ID: HERTjOX24Hzv2g3c, "Tolt CSV Group Reassign", Personal project, created 2026-03-23, NOT yet published). Full flow: Slack file trigger → CSV check → download → parse → loop emails → Tolt API lookup → if in HeyReach-New group, move to HeyReachCreators → post summary back to Slack. Needs: (1) trigger channel set to #heyreach-lele, (2) publish.

---

## Browser access for n8n

Use the **Chrome extension tools** (`mcp__claude-in-chrome__*`) for n8n browser work — not Playwright. The Playwright MCP server runs as a subprocess and can crash mid-session with no auto-restart. The Chrome extension lives inside an existing browser window and is stable across long multi-step sessions.

The Chrome extension tab is NOT pre-authenticated to n8n — navigate to `https://heyreach.app.n8n.cloud` and log in with woshicorp@gmail.com / jinshanjinMe1lly! if the tab isn't already on n8n.

---

## Team members with access
- Umer Ishaq (umer@heyreach.io) — primary builder
- Hassan Siddiqui — builder
- Leon Spremo — builder (Spremo project)
- Bojan Dachevski — contributor
- Milomir Lovrić — contributor
- woshicorp@gmail.com (Lele) — access confirmed 2026-03-18
