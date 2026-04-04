const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "50mb" }));

let sessions = {};
let allEvents = [];
let allScreenshots = [];
let flushLog = [];
let sseConnections = [];

// ── Observe API stubs (matches what the extension expects) ──────────────────

app.post("/api/observe/session/start", (req, res) => {
  const id = crypto.randomUUID();
  sessions[id] = {
    expert_id: req.body.expert_id ?? "unknown",
    started_at: Date.now(),
    ended: false,
    events: [],
    screenshots: [],
  };
  res.json({ session_id: id });
});

app.post("/api/observe/session/:id/events", (req, res) => {
  const { events = [], screenshots = [] } = req.body;
  const sid = req.params.id;

  allEvents.push(...events);

  // Store screenshot stubs (keep first 50 chars of base64 + length to save memory)
  const stubs = screenshots.map((s) => ({
    timestamp: s.timestamp,
    base64: s.base64 ? s.base64.slice(0, 50) : "",
    base64_length: s.base64 ? s.base64.length : 0,
    session_id: sid,
  }));
  allScreenshots.push(...stubs);

  flushLog.push({
    session_id: sid,
    event_count: events.length,
    screenshot_count: screenshots.length,
    timestamp: Date.now(),
  });

  if (sessions[sid]) {
    sessions[sid].events.push(...events);
    sessions[sid].screenshots.push(...stubs);
  }

  res.json({
    received: events.length,
    screenshots_stored: screenshots.length,
    gaps_detected: [],
  });
});

app.post("/api/observe/session/:id/end", (req, res) => {
  const sid = req.params.id;
  if (sessions[sid]) sessions[sid].ended = true;
  res.json({ session_id: sid, coverage_score: 0.85 });
});

// SSE stub — track connections so we can clean up
app.get("/api/observe/session/:id/narration", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: narration_chunk\n");
  res.write(
    `data: ${JSON.stringify({ text: "Mock narration active." })}\n\n`,
  );

  sseConnections.push(res);
  req.on("close", () => {
    sseConnections = sseConnections.filter((c) => c !== res);
  });
});

// Correction stub
app.post("/api/observe/session/:id/correction", (_req, res) => {
  res.json({ ok: true });
});

// ── Test introspection endpoints ────────────────────────────────────────────

app.get("/api/test/events", (_req, res) => {
  res.json({
    events: allEvents,
    screenshots: allScreenshots,
    sessions,
    flushLog,
  });
});

app.get("/api/test/session/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

app.post("/api/test/reset", (_req, res) => {
  sessions = {};
  allEvents = [];
  allScreenshots = [];
  flushLog = [];
  res.json({ ok: true });
});

// Catch-all for unmatched routes (extension may probe other paths)
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

// Express error handler
app.use((err, _req, res, _next) => {
  console.error("[mock-backend] Express error:", err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.MOCK_BACKEND_PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`[mock-backend] listening on http://localhost:${PORT}`);
});

// Prevent crash on unhandled errors
process.on("uncaughtException", (err) => {
  console.error("[mock-backend] uncaughtException:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("[mock-backend] unhandledRejection:", err);
});

module.exports = { app, server };
