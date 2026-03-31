# HeyReach — Tool Access

All logins via **woshicorp@gmail.com** Google profile unless noted. The Playwright browser is pre-authenticated to this profile — navigate directly without re-logging in.

---

## Clay

### Workspaces
- **heyreach.io (main):** https://app.clay.com/workspaces/245061/home
- **Test (sandbox):** https://app.clay.com/workspaces/315222/home

**Login:** Google Auth — woshicorp@gmail.com (Playwright browser)

### Workspace team members (as of 2026-02-20)
- Umer Ishaq — technical resource, builds Clay/HR API integrations
- Vukasin Vukosavljevic — workspace member
- Macklin Buckler — workspace member
- Owner shown as "Wo Shi" / heyreach.io credits

### Other tables in workspace (outside Lele's scope)
HeyReach maintains additional Clay tables for: outbound campaigns, churn analysis, events/webinars, HubSpot integration, influencer campaigns, user behavior tracking.

### Table schemas
JSON schemas stored in `Access/`:
- `creator_program_social_listening_table_heyreach_action_tabler.json` — action table
- `creator_program_social_listening_table_heyreach_experts_table.json` — experts table (wb_2U5ACV8e6dui), source of truth for Lovable
- `creator_program_social_listening_table_heyreach_mentions_catcher.json` — LI mentions / social listening
- `creator_program_social_listening_table_heyreach_tolt_experts.json` — Tolt experts

---

## Notion

**API token:** `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`
**Env var:** `HEYREACH_NOTION_TOKEN`

### Known pages / databases
- HeyReach Tracker: `30ac1c45-c9a0-80e5-b7fa-c9a069f7c980`
- HeyReach Tracker (test): `30cc1c45-c9a0-807d-8bcd-c35fcfdfab2d`
- Parent block (workspace root?): `2f6c1c45-c9a0-80b1-8aa0-f3daa9ae02cf` ← integration has no access
- Expert Points System Implementation (page): `30bc1c45-c9a0-80ba-a025-d2e15eb24415`
- **Content Points Tracker (database)**: `311c1c45-c9a0-8033-925e-fc98b9033870`
  - Inline child of Expert Points System Implementation
  - ⚠️ Deprecated as display layer — Lovable is now the dashboard. DB remains as data store.
- **Community Points Tracker (database)**: `311c1c45-c9a0-80a1-bb8f-e76a8ee66437`
  - Inline child of Expert Points System Implementation
  - ⚠️ Same deprecation note.
- **Weekly Syncs (page)**: `2fcc1c45-c9a0-80fc-a2c7-cf85b0a9c66f`
  - Structure: top-level `heading_1` toggles (`is_toggleable: true`), newest first
  - Each toggle: Fathom paragraph as **first child** inside the toggle, then bullet items
  - Write pattern: (1) `PATCH page/children` → new `heading_1` toggle → capture block ID from response; (2) `PATCH {new_id}/children` → paragraph with Fathom link. **Never append paragraph directly to page root.**
  - Known heading block IDs: 2026-03-16 → `326c1c45-c9a0-8136-8710-ca5ec04085c9`; 2026-03-10 → `31ec1c45-c9a0-813b-9eab-dc8766d71159`; 2026-03-03 → `318c1c45-c9a0-805e-92cc-c7cbf2fcf0af`
- **Umer's Workflows (page)**: `30bc1c45-c9a0-805b-8914-da8269b3bcdb`
- **Premium Partners (database view)**: `31209c3bcad380ccb4eeff7bc7b8f1e1` — shared by Bojana 2026-03-16 (ts:1773659411.125549); full list of 19 premium partners
- **Expert Leaderboard 1-Pager (page)**: `330c1c45-c9a0-81d0-aab3-d4482048a8e7` — created 2026-03-27, child of HeyReach Tracker parent page

### Conventions
- Create new databases as inline children of contextual pages, not at workspace root
- Always confirm integration has access via Connections menu before API calls

---

## Lovable

**URL:** https://lovable.dev
**Login:** woshicorp@gmail.com Google profile (Playwright browser)

### Projects
- **Social Listening:** https://lovable.dev/projects/c0e75eb7-7d23-49da-b18d-04beaf2001be
  - Project Owner: Umer
  - Internal Dashboard Access: Lele + anyone with @heyreach.io email
  - Lele Dashboard Login Email: woshicorp@gmail.com
  - Lele Dashboard Login Password: jinshanjinMe1lly!
  - Live dashboard: https://expert-pulse-dashboard-21.lovable.app/creators
- **Expert Points:** https://lovable.dev/projects/a3afa877-ccae-4d99-9ddd-bf18f09dd24e
  - Project Owner: Lele
  - Internal Dashboard Access: Lele + anyone with @heyreach.io email

### Creator pipeline — how data flows
Adding a new creator requires TWO separate steps, both are mandatory:
1. **Clay Creators table** (t_0tc3w7kYu5sSeH6KxbS) — add Name + LinkedIn URL. This is the social listening source.
   - **IMPORTANT:** LinkedIn URLs must NOT have trailing slashes. The Formula column appends `/` — if the URL already ends with `/`, the Formula produces `//` which breaks the Action Table lookup. Example: use `cantimagur` not `cantimagur/`.
2. **Supabase creators table** (Social Listening project, umer.ishaq181@gmail.com's project) — add the same creator directly. Clay does NOT auto-sync to Supabase; they are separate.

After both are added:
3. In the **Action Table**, use **Run column > Force run all rows** on the **"creators database"** lookup column (col 41) — this matches `Author LinkedIn Profile` against the Creators table `Formula` column. Note: "Run empty or out-of-date rows" does NOT re-run rows with "No Record Found" results — you must use "Force run all" to pick up newly added creators.
4. **"Send to Dashboard (Creators)"** (col 43) fires automatically for rows where col 41 returns a match.
5. Verify in the dashboard: find rows in the Action Table where col 41 returned a creator record, confirm the post details for that row appear under the correct creator at /creators.

---

## Supabase 
### Projects
- **Expert Points:** https://ygtdnpnizmpthgwtvbjw.supabase.co
 - ID: ygtdnpnizmpthgwtvbjw
 - UI Access: only through lovable, not through supabase directly. 
 - Clay API key: R7MEfUGzJCClQJ2nD49ejXUniMz8YQZl
 - Agent API key (if lovable ui doesn't work): _N45i.6_pxn3_P2
 - **Social Listening**: no access

## Tolt

**Login:** woshicorp@gmail.com Google profile (Playwright browser)

### Group IDs
- **HeyReach - New** (source group): `grp_VD6eSkGHJ38enp12mRjt4Xb5`
- **HeyReachCreators** (destination group): `grp_x9eBYi86fiYag6LdTkdMNR2Z`
