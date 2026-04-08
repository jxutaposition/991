/**
 * INV-026: tc-workflows direct runs (Swe router — NOT "Ewe" as INV-025 guessed).
 *
 * Bundle resolved 2026-04-07: https://app.clay.com/assets/index-D2XXxr_J.js
 *
 * Router Swe (found at offset ~361931) contains:
 *   createWorkflowRun          POST   /workspaces/:ws/tc-workflows/:wf/runs
 *     body: { inputs?: Record<string,any>, batchId?: string, standaloneActions?: J_[] }
 *     200:  { workflowRun: Q_ }
 *   getWorkflowRuns            GET    /workspaces/:ws/tc-workflows/:wf/runs?limit=50&offset=0
 *     200:  { runs: Q_[], total: number }
 *   getWorkflowRun             GET    /workspaces/:ws/tc-workflows/:wf/runs/:runId
 *     200:  union { type:'current', workflowRun, workflowRunSteps[], workflowSnapshot }
 *           | { type:'archived', archivedAgentRun }
 *   continueWorkflowRunStep    POST   .../runs/:runId/steps/:stepId/continue
 *     body: { humanFeedbackInput: { type:'ApproveToolCall'|'RejectToolCall'|'DenyToolCall'|'DenyTransition'|... } }
 *     200:  { success, stepId, status }
 *   getWaitingSteps            GET    /workspaces/:ws/tc-workflows/:wf/steps/waiting
 *     200:  { waitingSteps: [...] }
 *   pauseWorkflowRun           POST   .../runs/:runId/pause   body:{}  200:{success,runId,status}
 *   unpauseWorkflowRun         POST   .../runs/:runId/unpause body:{}  200:{success,runId,status}
 *
 * WorkflowRun (Q_) shape:
 *   { id, workflowId, workflowName, workflowSnapshotId, batchId, streamId,
 *     runStatus: 'pending'|'running'|'paused'|'completed'|'failed'|'waiting',
 *     runState: discriminated union by status
 *       - running: base
 *       - paused: base
 *       - completed: +outputs, completedAt, completedByStepId?, completedByNodeId?
 *       - failed: +failedAt, error, failedByStepId?, failedByNodeId?
 *     maxUninterruptedSteps, createdAt, updatedAt, langsmithTraceHeader? }
 *
 * NOTE: There is no DELETE or cancelWorkflowRun in the direct-runs router —
 * only pause/unpause. Cancellation is batch-level only.
 *
 * Credit safety: we use inert `regular` nodes (no model/prompt/tools) per
 * INV-025. A regular node with no model definition is a no-op. We still
 * measure credit delta before/after and abort if we see any motion.
 */
import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE_ID = 1080480;
const RESULTS_DIR = path.join(__dirname, "..", "results");
const COOKIE_FILE = path.join(RESULTS_DIR, ".session-cookies.json");

function loadCookies(): string {
  const c = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return c.map((x: any) => `${x.name}=${x.value}`).join("; ");
}

type Result = { label: string; method: string; url: string; status: number; response: any };
const out: Result[] = [];

async function call(
  method: string,
  url: string,
  body: any,
  cookieHeader: string,
  label: string,
): Promise<Result> {
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "application/json",
  };
  let finalBody: any;
  if (body !== null && body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    finalBody = JSON.stringify(body);
  }
  const r = await fetch(url, { method, headers, body: finalBody });
  const text = await r.text().catch(() => "");
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text.substring(0, 800); }
  const res = { label, method, url, status: r.status, response: parsed };
  console.log(`[${label}] ${method} ${url.replace(API_BASE, "")} -> ${r.status}`);
  out.push(res);
  await new Promise((r) => setTimeout(r, 200));
  return res;
}

async function main() {
  const cookie = loadCookies();
  const startedAt = Date.now();

  const me = await call("GET", `${API_BASE}/v3/me`, null, cookie, "auth-check");
  if (me.status !== 200) {
    console.error("session expired - STOP");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-026-direct-runs-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(2);
  }

  const wsBefore = await call(
    "GET",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}`,
    null,
    cookie,
    "credits-before",
  );
  const creditsBefore = wsBefore.response?.credits;
  console.log("credits before:", JSON.stringify(creditsBefore));

  // 1. Create scratch workflow
  const wfR = await call(
    "POST",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
    { name: `INV-026 direct-runs scratch ${Date.now()}` },
    cookie,
    "create-wf",
  );
  const wfId: string | undefined = wfR.response?.workflow?.id;
  console.log("wfId=", wfId);
  if (!wfId) {
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-026-direct-runs-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(3);
  }

  let nodeId1: string | undefined;
  let nodeId2: string | undefined;
  let edgeId: string | undefined;
  let runId: string | undefined;

  try {
    // 2. Build an inert graph: initial regular node -> terminal regular node
    const n1 = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`,
      {
        name: "INV-026 initial (inert)",
        nodeType: "regular",
        position: { x: 100, y: 100 },
        isInitial: true,
      },
      cookie,
      "create-node-initial",
    );
    nodeId1 = n1.response?.node?.id;

    const n2 = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`,
      {
        name: "INV-026 terminal (inert)",
        nodeType: "regular",
        position: { x: 300, y: 100 },
        isTerminal: true,
      },
      cookie,
      "create-node-terminal",
    );
    nodeId2 = n2.response?.node?.id;

    if (nodeId1 && nodeId2) {
      const e = await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/edges`,
        { sourceNodeId: nodeId1, targetNodeId: nodeId2 },
        cookie,
        "create-edge",
      );
      edgeId = e.response?.edge?.id;
    }

    // 3. Validate graph
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/graph`,
      null,
      cookie,
      "graph-validate",
    );

    // 4. List runs (empty initially)
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`,
      null,
      cookie,
      "runs-list-empty",
    );

    // 5. Try variants of createWorkflowRun. Per bundle, body is
    //    {inputs?, batchId?, standaloneActions?}. React caller passes {inputs: n}.
    //    Try the canonical shape first, then alternates.
    const variants: Array<{ label: string; body: any }> = [
      { label: "run-create-inputs-empty", body: { inputs: {} } },
      { label: "run-create-inputs-obj", body: { inputs: { hello: "world" } } },
      { label: "run-create-no-body", body: {} },
      { label: "run-create-standalone", body: { inputs: {}, standaloneActions: [] } },
    ];

    for (const v of variants) {
      const r = await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`,
        v.body,
        cookie,
        v.label,
      );
      if (r.status === 200 && r.response?.workflowRun?.id && !runId) {
        runId = r.response.workflowRun.id;
      }
    }

    // Also try the legacy shape names in case the route is stricter:
    if (!runId) {
      for (const v of [
        { label: "run-create-input-singular", body: { input: {} } },
        { label: "run-create-params", body: { params: {} } },
        { label: "run-create-wfsnap-latest", body: { workflowSnapshotId: "latest", inputs: {} } },
      ]) {
        const r = await call(
          "POST",
          `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`,
          v.body,
          cookie,
          v.label,
        );
        if (r.status === 200 && r.response?.workflowRun?.id) {
          runId = r.response.workflowRun.id;
          break;
        }
      }
    }

    // 6. If we got a runId, poll lifecycle (~10s)
    if (runId) {
      for (let i = 0; i < 12; i++) {
        const poll = await call(
          "GET",
          `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs/${runId}`,
          null,
          cookie,
          `poll-${i}`,
        );
        const status =
          poll.response?.workflowRun?.runStatus ??
          poll.response?.archivedAgentRun?.status;
        console.log(`  poll ${i} status=${status}`);
        if (status === "completed" || status === "failed" || status === "cancelled") break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Also list runs after creation
      await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`,
        null,
        cookie,
        "runs-list-after",
      );

      // 7. Probe getWaitingSteps
      await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/steps/waiting`,
        null,
        cookie,
        "waiting-steps",
      );

      // 8. Try pause/unpause
      await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs/${runId}/pause`,
        {},
        cookie,
        "pause-run",
      );
      await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs/${runId}/unpause`,
        {},
        cookie,
        "unpause-run",
      );

      // 9. Probe continueWorkflowRunStep (no real waiting step, expect 404/400)
      await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs/${runId}/steps/wfrs_fake_id/continue`,
        { humanFeedbackInput: { type: "ApproveToolCall", toolName: "fake", approveToolCallForEntireRun: false } },
        cookie,
        "continue-step-probe",
      );

      // 10. Probe PATCH cancel (not in router; expect 404/405)
      await call(
        "PATCH",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs/${runId}`,
        { status: "cancelled" },
        cookie,
        "patch-cancel-probe",
      );

      // 11. Probe DELETE run (not in router; expect 404/405)
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs/${runId}`,
        {},
        cookie,
        "delete-run-probe",
      );
    }
  } catch (e: any) {
    console.error("error:", e?.message || e);
    out.push({ label: "main-error", method: "-", url: "-", status: -1, response: String(e?.message || e) });
  } finally {
    // Cleanup
    if (edgeId && wfId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/edges/${edgeId}`,
        {},
        cookie,
        "cleanup-edge",
      );
    }
    const nodeIds = [nodeId1, nodeId2].filter(Boolean) as string[];
    if (wfId && nodeIds.length) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`,
        { nodeIds },
        cookie,
        "cleanup-nodes",
      );
    }
    if (wfId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}`,
        {},
        cookie,
        "cleanup-wf",
      );
    }

    const wsAfter = await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}`,
      null,
      cookie,
      "credits-after",
    );
    const creditsAfter = wsAfter.response?.credits;
    out.push({
      label: "credit-delta",
      method: "-",
      url: "-",
      status: 0,
      response: { before: creditsBefore, after: creditsAfter },
    });
    console.log("credits before:", JSON.stringify(creditsBefore));
    console.log("credits after :", JSON.stringify(creditsAfter));

    const f = path.join(RESULTS_DIR, `inv-026-direct-runs-${startedAt}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log("\nsaved", f);
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(RESULTS_DIR, `inv-026-direct-runs-error-${Date.now()}.json`),
    JSON.stringify({ error: String(e), out }, null, 2),
  );
  process.exit(1);
});
