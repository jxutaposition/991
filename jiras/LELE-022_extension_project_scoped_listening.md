# LELE-022: Chrome Extension — Project-Scoped Listening & Multi-Expert Routing

## Problem

The current extension design (LELE-005) assumes a single recording context: one expert, one session, one stream of events flowing into the system. But in practice, an expert may contribute knowledge to multiple projects — and a single project may draw on many experts. The extension needs a clear UX for the expert to **turn recording on/off** and **select which project they're currently feeding**, so the captured data is routed to the right workspace and can be used to train that project's agents.

Without project scoping, we have no way to:
1. Keep a SaaS consultant's "cold outreach" sessions separate from their "renewal playbook" sessions
2. Let multiple experts on the same team contribute to the same project corpus
3. Tell the distillation and extraction pipeline which project context (tools, domain, prior narrations) to use when interpreting raw events

## Core Concepts

**Listening mode** — a toggle in the extension popup/side panel. When on, the extension captures DOM events, screenshots, and (optionally) video per LELE-005 and LELE-018. When off, nothing is captured. The toggle must be unambiguous — the expert should never be unsure whether they're being recorded.

**Project selector** — before (or at any point during) recording, the expert picks which project their session belongs to. A project maps 1:1 to a workspace in the backend. All captured data is tagged with `project_id` so downstream pipelines (narrator, extraction, distillation) operate within that project's scope.

**Multi-expert → one project** — many experts can select the same project. Their sessions are attributed individually (`expert_id`) but contribute to a shared project corpus. The extraction pipeline (LELE-006) merges heuristics across experts for that project, with deduplication per LELE-009.

**One expert → many projects** — an expert can switch projects between sessions (or even mid-session via the project selector). Each session segment is tagged to the project that was active when those events were captured.

## Extension UX

### Popup / Side Panel States

| State | What the expert sees |
|-------|---------------------|
| **Idle** | Project dropdown (last-used pre-selected) + "Start Listening" button |
| **Listening** | Red recording indicator + current project name + "Stop" button + "Switch Project" option + live narration feed |
| **Paused** | Yellow indicator + "Resume" / "Stop & Save" buttons (for bathroom breaks, sensitive screens, etc.) |

### Project Picker

- Dropdown populated from `GET /api/projects` (projects the expert has been granted access to)
- "Last used" project is pre-selected on extension open
- Switching projects mid-session ends the current `observation_session` and starts a new one with the new `project_id`
- If the expert has access to only one project, the picker is hidden and that project is auto-selected

### Recording Controls

- **Start Listening** — creates an `observation_session` tagged with `{expert_id, project_id}`, begins event capture
- **Pause** — stops event capture, keeps the session open (no new `observation_session` on resume)
- **Stop** — ends the session, flushes remaining buffer, triggers coverage score computation (LELE-012)
- **Switch Project** — equivalent to Stop + Start with a different `project_id`

## Backend Changes

### `observation_sessions` table additions

```sql
ALTER TABLE observation_sessions
  ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id),
  ADD COLUMN expert_id  UUID NOT NULL REFERENCES experts(id);
```

All downstream tables (`action_events`, `distillations`, `abstracted_tasks`) inherit project scope via their `session_id` foreign key — no schema changes needed there.

### New endpoint: `GET /api/projects`

Returns projects the authenticated expert has access to:

```json
[
  { "id": "uuid", "name": "Outbound SDR Playbook", "last_used": "2025-06-01T..." },
  { "id": "uuid", "name": "CS Renewal Workflows", "last_used": null }
]
```

### Project access control

`expert_project_access` join table:

```sql
CREATE TABLE expert_project_access (
  expert_id  UUID REFERENCES experts(id),
  project_id UUID REFERENCES projects(id),
  role       TEXT NOT NULL DEFAULT 'contributor', -- contributor | admin
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (expert_id, project_id)
);
```

- **contributor** — can record sessions for this project
- **admin** — can invite other experts, manage project settings, review all sessions

## Downstream Impact

### Narrator (LELE-012)
The narrator's context window construction must scope prior narrations to the current **project**, not just the current session. This lets the narrator reference what other experts in the same project have already narrated, producing more consistent terminology.

### Extraction Pipeline (LELE-006)
Extraction and segmentation already operate per-session. Adding `project_id` enables a project-level aggregation pass: after individual session extraction, a merge step combines heuristics from all experts in the project and deduplicates (LELE-009).

### Agent Training
The distilled corpus for a project becomes the training data for that project's agents. When a customer creates a workspace powered by "Outbound SDR Playbook," they get agents trained on sessions from all experts who contributed to that project. This is the core value loop: **experts listen → data flows into project → agents improve for that project's customers**.

## Privacy Considerations

- Project-scoped data means an expert's sessions are visible to project admins — the consent flow (LELE-013) must disclose this
- An expert switching projects must not leak events from Project A into Project B's session (clean session boundary on switch)
- The extension must clearly show which project is active at all times to prevent accidental data routing

## Open Questions

- Should mid-session project switching create two separate sessions, or one session with a `project_id` change event? (Two sessions is simpler and avoids cross-project data in a single session.)
- Should experts be able to create new projects from the extension, or only from the web dashboard?
- How do we handle an expert who forgets to select a project and starts recording? Default to last-used? Require selection before recording can begin?
- Should project admins see a real-time feed of all active listening sessions across their experts?

## Dependencies

- LELE-005 (Browser Extension MV3) — the extension runtime this builds on
- LELE-009 (Multi-Expert Dedup) — how multi-expert contributions are merged per project
- LELE-012 (Distillation Narrator) — narrator must become project-aware
- LELE-013 (Privacy/Onboarding) — consent flow must cover project-scoped visibility

## Acceptance Criteria

- [ ] Extension popup shows project selector populated from backend
- [ ] "Start Listening" creates an `observation_session` with `project_id` and `expert_id`
- [ ] Recording indicator clearly shows active project name at all times
- [ ] Switching projects mid-session cleanly ends the old session and starts a new one
- [ ] Pause/resume works without creating a new session
- [ ] `GET /api/projects` returns only projects the expert has access to
- [ ] `expert_project_access` table enforces contributor/admin roles
- [ ] Events from different projects are never mixed within a single `observation_session`
- [ ] Narrator scopes prior narration context to the active project
- [ ] An expert with access to 3+ projects can switch between them without restarting the extension
