# LELE-018: Video Recording for Observation Sessions

## Problem
The current observation system captures DOM events (clicks, navigation, form submits) and takes periodic screenshots (every 30s). But these structured signals miss a lot of context — what the expert was reading, how long they paused on a page, visual cues they were responding to, and the overall flow of their decision-making. Video provides the ground truth reference that DOM events alone cannot.

## Design
Record screen video during expert sessions alongside the existing event + screenshot capture. Video serves as a reference layer — the structured events remain the primary input for the narrator and extraction pipeline, but video can be reviewed to validate extraction quality and catch what events missed.

## Key Questions
- **Capture method**: MediaRecorder API in the Chrome extension (via `chrome.tabCapture` or `chrome.desktopCapture`)? Or a separate screen recording tool with timestamp alignment?
- **Storage**: MinIO/S3 for video files. Chunked upload during session (every 30-60s) to avoid memory buildup.
- **Playback**: Add video player to the `/observe/:session_id` detail page. Sync timestamps between video timeline and narration/event entries.
- **Privacy**: Same filtering as events — blur/mask sensitive fields in video? Or rely on the expert's consent model?
- **Size**: 720p 30fps H.264 at ~2Mbps = ~900MB/hour. Consider 10fps or lower resolution for storage efficiency.

## Future Integration
- Video frames at key moments (clicks, navigation) could be sent to a vision LLM (Claude with vision) for richer narration
- Video + timestamps + events combined could drive the continuous reasoning loop (LELE-019)
- Video review enables ground-truth richness measurement (LELE-020)

## Acceptance Criteria
- [ ] Video recording starts/stops with observation session
- [ ] Video chunks uploaded to object storage during session
- [ ] Video playback on observe detail page with timestamp scrubbing
- [ ] Narration timestamps link to video position (click narration → jump to video moment)
- [ ] Video files cleaned up after configurable retention period
