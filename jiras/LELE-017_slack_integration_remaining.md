# LELE-017: Slack Integration — Remaining Work

## Problem
The Slack integration foundation is built (client, routes, notifier, messages, migration) but the app is not yet fully operational because Slack app configuration and Socket Mode support are incomplete.

## What's Done
- `slack.rs` — Slack Web API client (post_message, update_message, set_status, verify_signature)
- `slack_messages.rs` — Block Kit message builders for all event types
- `slack_notifier.rs` — EventBus subscriber that bridges execution events to Slack messages with 2s batching
- `slack_routes.rs` — Inbound handlers for /api/slack/commands, /interactions, /events
- `004_slack.sql` — Migration for slack_channel_mappings table + clarification columns
- Config, state, main.rs wiring — all complete with feature flag

## What's Left

### 1. Socket Mode Support (P0)
The backend currently only supports HTTP mode (Slack POSTs to our server). For local dev without a public URL, we need Socket Mode — a WebSocket connection FROM our server TO Slack.

- Add `slack-morphism` Socket Mode listener using `SlackClientSocketModeListener`
- Route socket events to the same handlers as HTTP mode
- Gate on `SLACK_MODE=socket` config (already in Settings)
- Requires `SLACK_APP_TOKEN` (xapp-...) env var

### 2. Slack App Configuration (P0, manual)
The Slack app (A0APK3F1TSS) needs these settings enabled:
- **App Home → Messages Tab**: toggle ON "Allow users to send Slash commands and messages"
- **Socket Mode**: toggle ON, create App-Level Token with `connections:write` scope
- **Event Subscriptions**: subscribe to `message.im`, `assistant_thread_started`, `assistant_thread_context_changed`
- **Interactivity**: enable (Request URL only needed for HTTP mode)
- **Scopes** (already added): `assistant:write`, `chat:write`, `im:write`, `im:history`, `im:read`, `commands`, `users:read`

### 3. Slash Command Registration (P1)
Register `/lele` slash command in Slack app settings. In Socket Mode this routes automatically; in HTTP mode needs a Request URL.

### 4. End-to-End Testing (P1)
- DM the bot → receive suggested prompts
- Type a GTM request → see plan with Approve/Reject buttons
- Click Approve → see streaming node progress in thread
- Session completes → see summary with View Results link
- Clarification flow → agent asks question → user replies in thread → node resumes

### 5. Frontend URL Configuration (P2)
`slack_notifier.rs` has hardcoded `http://localhost:3000` for the "View Results" link. Should read from a `FRONTEND_URL` env var.

## Acceptance Criteria
- [ ] Socket Mode listener connects to Slack and receives events
- [ ] Slash command `/lele run <goal>` creates a session and posts plan
- [ ] Approve/Reject buttons work from Slack
- [ ] Node progress updates appear as threaded messages
- [ ] Session completion summary posts with View Results link
- [ ] Clarification thread reply resumes paused node
- [ ] Works without public URL (Socket Mode)
