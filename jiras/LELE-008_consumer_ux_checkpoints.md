# LELE-008: Consumer UX — Checkpoints and Approval Flow

## Problem
Multi-agent workflows can produce irreversible actions (send an email, create a CRM record, launch an ad campaign). Customers need control over when to proceed vs. pause, without having to monitor every agent's output in real time.

## Checkpoint Design

**Checkpoint types:**

1. **Plan approval** (always required): Customer reviews the full execution plan before any agent runs. Shows: agent sequence, task descriptions, estimated cost range. Approve = kick off execution. Edit = return to request box with the current plan pre-populated for modification.

2. **Output checkpoints** (configurable): After certain high-stakes agents, the workflow pauses and waits for customer approval before proceeding. Default checkpoint agents:
   - `cold_email_writer` → pause before follow-up sequence or CRM update
   - `ad_copy_writer` → pause before campaign builder
   - `meta_ads_campaign_builder` → pause before any live Meta API calls
   - `google_ads_campaign_builder` → pause before any live Google API calls

3. **Error checkpoints** (automatic): If any agent reaches `NodeStatus::Failed` after all retries, the session pauses. Customer sees the failure, the agent's output, and the judge's feedback. Options: retry, skip this agent and continue, abort.

## UI Flow

```
Request → "Build plan"
  → [Plan shown] "Approve & Execute" or "Edit"
  → [Execution starts, canvas animates]
  → [Checkpoint reached] Notification + "Review output"
    → [Output shown] "Continue" or "Stop here"
  → [Completion] Summary of all outputs + "Export to CRM"
```

**Notification mechanism:** SSE event type `checkpoint_reached` includes:
- `node_id`: which node produced the output
- `agent_slug`: which agent
- `output_preview`: first 500 chars of the output
- `requires_approval`: bool
- `choices`: array of options (continue, stop, retry)

## Email Notification (future)
For long-running sessions (>10 min estimated), offer email notification when checkpoints are reached. Customer doesn't have to sit on the page.

## Open Questions
- Should checkpoints be configurable per customer (e.g., "always pause before email send") or per workflow?
- How do we handle the case where a checkpoint agent is in the middle of a parallel branch? Do we pause the whole session or just that branch?
- Should there be a "auto-approve if judge score ≥ X" option for customers who trust the system?

## Acceptance Criteria
- [ ] Plan approval required before any execution begins
- [ ] Default checkpoint agents pause execution and emit `checkpoint_reached` SSE event
- [ ] Customer can view full agent output at checkpoint
- [ ] "Continue" / "Stop" choices work correctly from the UI
- [ ] Failed nodes pause session and surface options to customer
- [ ] Session can be resumed after a checkpoint from the sessions list
