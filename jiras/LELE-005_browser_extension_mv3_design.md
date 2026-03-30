# LELE-005: Browser Extension — MV3 Design

## Problem
Chrome Manifest V3 imposes strict constraints on service workers (no persistence, sleep after 30s inactivity). The extension must capture events continuously during multi-hour GTM sessions without losing data.

## Architecture Decisions

**Service worker keep-alive:** Use `chrome.alarms` to fire every 10s during active recording. Each alarm invokes a no-op keepalive function that prevents the service worker from being killed. This is the documented MV3 pattern for long-running background work.

**Event buffer:** Events are buffered in memory in the service worker. The alarm handler flushes the buffer to the backend every 10s. If the service worker is killed between alarms, the buffer is lost — this is acceptable (at most 10s of events). The session remains valid; there will just be a sequence gap.

**Sequence gap detection:** The backend detects sequence gaps on ingestion (`sequence_number` must be monotonically increasing per session). Gaps are logged in `observation_sessions.gap_count` for session quality scoring. A session with gaps is still usable — it just has lower coverage score.

**Screenshot cadence:** Every 30s via `chrome.tabs.captureVisibleTab()`. Screenshots are base64-encoded in the event payload. At 60% JPEG quality, a typical screenshot is 50-150KB. In a 1-hour session: 120 screenshots × 100KB avg = 12MB. Acceptable for backend storage in MinIO.

**Content script isolation:** Content scripts run in the page's context but cannot access the extension service worker directly. All communication goes through `chrome.runtime.sendMessage`. This has ~5ms latency — acceptable.

**Domain allowlist enforcement:** The manifest `content_scripts.matches` field enforces domain allowlisting at install time. No runtime enforcement needed in content script (the browser handles it).

## Privacy Architecture

**What is captured:**
- Click events: element type, element text (capped 100 chars), element ID, nearby text (capped 150 chars)
- Navigation: URL only
- Form submits: field names (keys) only, never values
- Copy events: text length only, never content

**What is never captured:**
- Password fields (selector-blocked at content script level)
- Credit card fields (selector-blocked)
- Input field values (only field names are recorded)
- Any field marked `data-sensitive` or `[aria-label*="password"]`

**Expert control:** The recording indicator (red dot in side panel) is always visible when recording. The expert can stop at any time. The expert can add real-time corrections to clarify what the narration got wrong.

## Open Questions
- Should the domain allowlist be configurable per-expert, or global?
- How should we handle extensions that modify the DOM (ad blockers, etc.) that might affect our content script?
- The 30s screenshot interval is aggressive. Should it be configurable? Lower frequency = less storage cost but coarser visual context.

## Acceptance Criteria
- [ ] Service worker survives 4-hour recording session without being killed (verified via Chrome Task Manager)
- [ ] Sequence gaps detected and logged on ingestion
- [ ] Screenshots landing in MinIO with correct session prefix
- [ ] Side panel shows real-time narration within 30s of event batch
- [ ] Password fields never captured (automated test with known password input)
- [ ] Stop recording terminates all alarms and flushes remaining buffer
