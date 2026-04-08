# Slack — Integration Requirements

## Credentials

Slack OAuth token (Bot Token) — configured in Settings > Integrations.
Grants access to the workspace the bot was installed in.

## Access Model

- The bot token gives access to ALL public channels the bot is a member of
- Private channels require the bot to be explicitly invited
- The token alone does NOT tell you which channel to use — that's always a user decision
- DMs require the bot to have `chat:write` scope and the target user's ID

## Runtime Configuration

### Channel ID

- **What**: The specific Slack channel to post messages to (e.g., `C01ABCDEF`)
- **Why**: Any workflow that posts to Slack needs a target channel. There is no default.
- **Input type**: `slack_channel`
- **How to ask**: Use `request_user_action` with a `type: "inputs"` section:
  ```json
  {
    "type": "inputs",
    "title": "Slack Configuration",
    "inputs": [{
      "id": "slack_channel",
      "label": "Slack channel for notifications",
      "input_type": "slack_channel",
      "required": true,
      "description": "Which channel should messages be posted to?"
    }]
  }
  ```
- **How to validate**: Call `conversations.info` with the channel ID. HTTP 200 = valid. `channel_not_found` error = invalid.
- **Fallback**: If the user can't decide, suggest creating a dedicated channel (e.g., `#lele-alerts`).

### Thread vs Top-Level

- **What**: Whether to post as new messages or reply in a thread
- **Why**: Some workflows need threaded updates (e.g., status tracking per lead)
- **Input type**: `select` (options: `"top_level"`, `"threaded"`)
- **Default**: `"top_level"` — only ask if the use case is ambiguous

### Multiple Channels

Some plans require posting to different channels for different purposes (e.g., `#hot-leads` for A+ leads, `#weekly-digest` for summaries). Ask for each channel separately with a clear label explaining what it's for.
