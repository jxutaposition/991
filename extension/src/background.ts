import type { RecordingState, CapturedEvent, MessageToBackground } from "./types";

const BACKEND_URL = "http://localhost:3001";
const SCREENSHOT_INTERVAL_MS = 5_000; // every 5 seconds
const FLUSH_INTERVAL_MS = 10_000; // 10 second batches
const MAX_SCREENSHOTS_PER_FLUSH = 3; // Send best 3 per batch
const SCREENSHOT_BUFFER_MAX = 12; // Keep last 60 seconds

let state: RecordingState = {
  isRecording: false,
  sessionId: null,
  expertId: "default_expert",
  sequenceCounter: 0,
  eventBuffer: [],
};

// Separate screenshot buffer (not mixed with events)
let screenshotBuffer: Array<{ timestamp: number; base64: string; url: string }> = [];
let screenshotTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

// ── Session management ──────────────────────────────────────────────────────

async function startSession(expertId: string): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/observe/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expert_id: expertId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { session_id: string };
    state = { ...state, isRecording: true, sessionId: data.session_id, expertId, sequenceCounter: 0 };

    // Screenshot capture every 5s
    screenshotTimer = setInterval(captureScreenshot, SCREENSHOT_INTERVAL_MS);

    // Start batch flush timer (every 10 seconds)
    flushTimer = setInterval(flushBatch, FLUSH_INTERVAL_MS);

    broadcast({ type: "SESSION_STARTED", sessionId: data.session_id });
  } catch (err) {
    broadcast({ type: "ERROR", message: String(err) });
  }
}

async function stopSession(): Promise<void> {
  if (!state.sessionId) return;

  // Stop timers
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }

  // Final flush
  await flushBatch();

  try {
    await fetch(`${BACKEND_URL}/api/observe/session/${state.sessionId}/end`, { method: "POST" });
  } catch (_) { /* best effort */ }

  state = { ...state, isRecording: false, sessionId: null };
  screenshotBuffer = [];
  broadcast({ type: "SESSION_ENDED" });
}

// ── Event buffering ─────────────────────────────────────────────────────────

function nextSeq(): number {
  const seq = state.sequenceCounter;
  state = { ...state, sequenceCounter: seq + 1 };
  return seq;
}

function addToBuffer(event: CapturedEvent): void {
  state = { ...state, eventBuffer: [...state.eventBuffer, event] };
}

async function flushBatch(): Promise<void> {
  if (!state.sessionId) return;

  const events = [...state.eventBuffer];
  state = { ...state, eventBuffer: [] };

  // Pick screenshots: latest + evenly spaced from the buffer
  const screenshots = pickScreenshots();

  // Nothing to send?
  if (events.length === 0 && screenshots.length === 0) return;

  try {
    await fetch(`${BACKEND_URL}/api/observe/session/${state.sessionId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events, screenshots }),
    });
  } catch (_) {
    // Re-add events on failure (screenshots are dropped — they're large)
    state = { ...state, eventBuffer: [...events, ...state.eventBuffer] };
  }
}

function pickScreenshots(): Array<{ timestamp: number; base64: string }> {
  if (screenshotBuffer.length === 0) return [];

  if (screenshotBuffer.length <= MAX_SCREENSHOTS_PER_FLUSH) {
    const picked = screenshotBuffer.map(({ timestamp, base64 }) => ({ timestamp, base64 }));
    screenshotBuffer = [];
    return picked;
  }

  // Pick: first, middle, and latest
  const first = screenshotBuffer[0];
  const mid = screenshotBuffer[Math.floor(screenshotBuffer.length / 2)];
  const last = screenshotBuffer[screenshotBuffer.length - 1];
  screenshotBuffer = [];

  return [
    { timestamp: first.timestamp, base64: first.base64 },
    { timestamp: mid.timestamp, base64: mid.base64 },
    { timestamp: last.timestamp, base64: last.base64 },
  ];
}

// ── Screenshot capture (500ms interval, JPEG, downscaled) ───────────────────

async function captureScreenshot(): Promise<void> {
  if (!state.isRecording) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 75 });
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");

    screenshotBuffer.push({
      timestamp: Date.now(),
      base64,
      url: tab.url ?? "",
    });

    // Cap buffer size
    if (screenshotBuffer.length > SCREENSHOT_BUFFER_MAX) {
      screenshotBuffer.splice(0, screenshotBuffer.length - SCREENSHOT_BUFFER_MAX);
    }
  } catch (_) { /* tab may not support capture */ }
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: MessageToBackground, _sender, sendResponse) => {
    (async () => {
      switch (message.type) {
        case "START_RECORDING":
          await startSession(message.expertId);
          sendResponse({ ok: true });
          break;
        case "STOP_RECORDING":
          await stopSession();
          sendResponse({ ok: true });
          break;
        case "GET_STATE":
          sendResponse({ type: "STATE", state });
          break;
        case "CAPTURED_EVENT":
          addToBuffer({ ...message.event, sequence_number: nextSeq() });
          sendResponse({ ok: true });
          break;
      }
    })();
    return true;
  }
);

function broadcast(msg: object): void {
  chrome.runtime.sendMessage(msg).catch(() => { /* sidepanel may be closed */ });
}

console.log("[99percent] Background service worker started (screenshots: 5s JPEG@75)");
