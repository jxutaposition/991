import type { RecordingState, CapturedEvent, MessageToBackground } from "./types";

const BACKEND_URL = "http://localhost:3001";

let state: RecordingState = {
  isRecording: false,
  sessionId: null,
  expertId: "default_expert",
  sequenceCounter: 0,
  eventBuffer: [],
};

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
    state = { ...state, isRecording: true, sessionId: data.session_id, expertId };

    chrome.alarms.create("batch_flush", { periodInMinutes: 1 / 6 });
    chrome.alarms.create("screenshot", { periodInMinutes: 0.5 });

    broadcast({ type: "SESSION_STARTED", sessionId: data.session_id });
  } catch (err) {
    broadcast({ type: "ERROR", message: String(err) });
  }
}

async function stopSession(): Promise<void> {
  if (!state.sessionId) return;
  await flushBatch();
  try {
    await fetch(`${BACKEND_URL}/api/observe/session/${state.sessionId}/end`, { method: "POST" });
  } catch (_) { /* best effort */ }
  state = { ...state, isRecording: false, sessionId: null };
  chrome.alarms.clearAll();
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
  if (!state.sessionId || state.eventBuffer.length === 0) return;
  const events = [...state.eventBuffer];
  state = { ...state, eventBuffer: [] };
  try {
    await fetch(`${BACKEND_URL}/api/observe/session/${state.sessionId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch (_) {
    state = { ...state, eventBuffer: [...events, ...state.eventBuffer] };
  }
}

// ── Screenshot capture ──────────────────────────────────────────────────────

async function captureScreenshot(): Promise<void> {
  if (!state.isRecording) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png", quality: 60 });
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    addToBuffer({
      sequence_number: nextSeq(),
      event_type: "heartbeat",
      url: tab.url ?? "",
      domain: tab.url ? new URL(tab.url).hostname : "",
      dom_context: null,
      screenshot_b64: b64,
      timestamp: Date.now(),
    });
  } catch (_) { /* tab may not support capture */ }
}

// ── Alarm handler ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "batch_flush") await flushBatch();
  else if (alarm.name === "screenshot") await captureScreenshot();
});

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

console.log("[lele] Background service worker started");
