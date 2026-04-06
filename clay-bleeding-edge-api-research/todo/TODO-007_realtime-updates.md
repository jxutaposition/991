# TODO-007: Discover Real-time Update Channel

**Priority:** P2 (upgrades to P1 if it solves TODO-004)
**Status:** Open
**Related Gap:** GAP-015

## Problem

Clay's UI shows real-time updates (enrichment progress, cell values filling in, collaborator cursors). This implies a WebSocket, SSE, or long-polling channel that we haven't discovered yet.

## What We Know

- Clay is a React SPA
- Real-time cell updates visible in UI during enrichments
- No WebSocket endpoints discovered in enumeration (but WS wouldn't show in HTTP probing)

## Investigation Plan

1. Open Clay table in browser with DevTools Network tab filtered to WS/SSE
2. CDP interception with WebSocket frame logging enabled
3. Check for `wss://` connections to `api.clay.com` or any other domain
4. Check for EventSource/SSE connections
5. If found, document the subscription protocol and message format

## Success Criteria

- Identify the real-time transport (WS/SSE/polling)
- Document connection URL and auth mechanism
- Document message format for cell updates
- Potentially solve TODO-004 (enrichment completion) as a side effect
