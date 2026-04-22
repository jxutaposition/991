/**
 * Minimal HTTP stub on :3001 for local verification that the Next.js
 * /api/* catch-all proxy forwards to API_BACKEND_URL at request time.
 * Run: node scripts/mock-api-backend.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_LOG = path.join(__dirname, "..", "debug-8025bc.log");
function agentAppendLog(payload) {
  try {
    fs.appendFileSync(
      DEBUG_LOG,
      JSON.stringify({ sessionId: "8025bc", runId: "pre-fix", timestamp: Date.now(), ...payload }) + "\n",
    );
  } catch {
    /* ignore */
  }
}

const server = http.createServer((req, res) => {
  const u = req.url ?? "";
  if (u === "/api/health" || u.startsWith("/api/health?")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stub: true }));
    return;
  }
  if (u === "/api/auth/google" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      // #region agent log
      agentAppendLog({
        hypothesisId: "H1",
        location: "scripts/mock-api-backend.mjs:POST /api/auth/google",
        message: "mock stub auth/google handler (always 401 by default)",
        data: {
          receivedBytes: body.length,
          jsonLooksLikeIdTokenKey: /"id_token"\s*:/.test(body),
        },
      });
      // #endregion
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stub: invalid id_token", receivedBytes: body.length }));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("stub: not found");
});

server.listen(3001, "127.0.0.1", () => {
  console.log("mock-api-backend listening on http://127.0.0.1:3001");
});
