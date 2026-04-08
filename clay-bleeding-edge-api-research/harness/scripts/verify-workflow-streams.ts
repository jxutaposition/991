/**
 * INV-027: tc-workflows streams (lKe router) + webhook ingestion (uKe router)
 *
 * Bundle resolved 2026-04-07: https://app.clay.com/assets/index-BS8vlUPJ.js
 *
 * Routers (from bundle scan, offset ~623100-625900):
 *
 * lKe = terracottaWorkflowRunStreams:
 *   createWorkflowRunStream  POST   /workspaces/:ws/tc-workflows/:wf/streams
 *     body: { workflowSnapshotId, streamType, name, config: any, status?: 'active'|'paused'|'disabled' }
 *     200:  { stream: VS }
 *   getWorkflowRunStreams    GET    .../streams?limit&offset&status&streamType
 *     200:  { streams: VS[], total }
 *   getWorkflowRunStream     GET    .../streams/:streamId
 *     200:  { stream: VS }
 *   updateWorkflowRunStream  PATCH  .../streams/:streamId
 *     body: { name?, workflowSnapshotId?, config?, status? }
 *     200:  { stream: VS }
 *   deleteWorkflowRunStream  DELETE .../streams/:streamId  body:{}  200:{success}
 *   getWorkflowRunStreamRuns GET    .../streams/:streamId/runs?limit&offset&status
 *     200:  { runs: Q_[], total }
 *
 * uKe = terracottaStreamWebhook  (NOTE: root path, NO /workspaces prefix):
 *   postWebhook       POST  /tc-workflows/streams/:streamId/webhook
 *     body: Record<string, any>   (arbitrary JSON payload)
 *     202:  { success: true, workflowRunId, message }
 *     400/404/429
 *   postWebhookBatch  POST  /tc-workflows/streams/:streamId/webhook/batch
 *     body: { items: [{ entityId?, backfillId?, requestData: object }] }
 *     202:  { success: true, runs: [{requestId, workflowRunId}], count }
 *
 * VS (WorkflowRunStream) shape:
 *   { id, workflowId, workflowSnapshotId, streamType: 'webhook'|'agent_action'|'workflow_action',
 *     name, createdBy: number|null, config: any (nullable), status: 'active'|'paused'|'disabled',
 *     createdAt, updatedAt, deletedAt|null, webhookUrl?: string,
 *     referencedTables?: [{tableId, tableName, workbookId|null}] }
 *
 * Strategy: build inert tc-workflow (INV-026 pattern), POST a stream of each
 * type, look for webhookUrl in response, fire postWebhook + postWebhookBatch,
 * poll runs, exercise lifecycle (PATCH status, GET stream/runs, DELETE).
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
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.substring(0, 800);
  }
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
      path.join(RESULTS_DIR, `inv-027-streams-${startedAt}.json`),
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
    { name: `INV-027 streams scratch ${Date.now()}` },
    cookie,
    "create-wf",
  );
  const wfId: string | undefined = wfR.response?.workflow?.id;
  console.log("wfId=", wfId);
  if (!wfId) {
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-027-streams-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(3);
  }

  let nodeId1: string | undefined;
  let nodeId2: string | undefined;
  let edgeId: string | undefined;
  const createdStreamIds: string[] = [];

  try {
    // 2. Build inert two-node graph (INV-026 pattern)
    const n1 = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`,
      {
        name: "INV-027 initial (inert)",
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
        name: "INV-027 terminal (inert)",
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

    // Need a snapshotId — easiest path: kick off a direct run, which forces
    // snapshot materialization, then read /snapshots to get a wfs_ id.
    // Alternatively the stream router accepts 'latest' as a magic value (worth probing).

    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/snapshots`,
      null,
      cookie,
      "snapshots-before",
    );

    // Trigger snapshot materialization via a no-op direct run
    const seedRun = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`,
      { inputs: {} },
      cookie,
      "seed-run-for-snapshot",
    );
    const seedSnapshotId: string | undefined =
      seedRun.response?.workflowRun?.workflowSnapshotId;
    console.log("seedSnapshotId=", seedSnapshotId);

    const snapsAfter = await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/snapshots`,
      null,
      cookie,
      "snapshots-after",
    );
    const snapshotId: string | undefined =
      seedSnapshotId ??
      snapsAfter.response?.snapshots?.[0]?.id ??
      snapsAfter.response?.workflowSnapshots?.[0]?.id;
    console.log("snapshotId=", snapshotId);

    // 3. List streams (empty)
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams`,
      null,
      cookie,
      "streams-list-empty",
    );

    // 4. Try createWorkflowRunStream variants
    // Body: { workflowSnapshotId, streamType, name, config, status? }
    // streamType enum: 'webhook' | 'agent_action' | 'workflow_action'
    // config shape unknown — try {} first, then minimal {inputSchema:{type:'object'}}
    // and {inputSchema:{...}, webhook:{requiresAuth:false}}.
    const variants: Array<{ label: string; body: any }> = [
      {
        label: "stream-create-webhook-empty-config",
        body: {
          workflowSnapshotId: snapshotId ?? "latest",
          streamType: "webhook",
          name: "INV-027 webhook stream A",
          config: {},
        },
      },
      {
        label: "stream-create-webhook-input-schema",
        body: {
          workflowSnapshotId: snapshotId ?? "latest",
          streamType: "webhook",
          name: "INV-027 webhook stream B",
          config: {
            inputSchema: { type: "object", properties: { email: { type: "string" } } },
            webhook: { requiresAuth: false },
          },
        },
      },
      {
        label: "stream-create-webhook-status-active",
        body: {
          workflowSnapshotId: snapshotId ?? "latest",
          streamType: "webhook",
          name: "INV-027 webhook stream C",
          config: { inputSchema: { type: "object" }, webhook: { requiresAuth: false } },
          status: "active",
        },
      },
      {
        label: "stream-create-agent-action",
        body: {
          workflowSnapshotId: snapshotId ?? "latest",
          streamType: "agent_action",
          name: "INV-027 agent_action stream",
          config: {},
        },
      },
      {
        label: "stream-create-workflow-action",
        body: {
          workflowSnapshotId: snapshotId ?? "latest",
          streamType: "workflow_action",
          name: "INV-027 workflow_action stream",
          config: {},
        },
      },
    ];

    let webhookStreamId: string | undefined;
    let webhookStreamUrl: string | undefined;

    for (const v of variants) {
      const r = await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams`,
        v.body,
        cookie,
        v.label,
      );
      const s = r.response?.stream;
      if (r.status === 200 && s?.id) {
        createdStreamIds.push(s.id);
        if (s.streamType === "webhook" && !webhookStreamId) {
          webhookStreamId = s.id;
          webhookStreamUrl = s.webhookUrl;
        }
      }
    }

    // 5. List streams (populated)
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams`,
      null,
      cookie,
      "streams-list-after",
    );

    if (webhookStreamId) {
      // 6. Read individual stream
      await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${webhookStreamId}`,
        null,
        cookie,
        "stream-get",
      );

      // 7. List runs for this stream (empty)
      await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${webhookStreamId}/runs`,
        null,
        cookie,
        "stream-runs-empty",
      );

      // 8. Fire postWebhook (uKe router — root path, no /workspaces prefix)
      const wh1 = await call(
        "POST",
        `${API_BASE}/v3/tc-workflows/streams/${webhookStreamId}/webhook`,
        { email: "inv027@example.com", company: "Lele" },
        cookie,
        "post-webhook-single",
      );
      const wfRunIdFromWebhook: string | undefined = wh1.response?.workflowRunId;

      // 8b. Some routers register webhook under /v3/. Try without /v3 too just in case.
      await call(
        "POST",
        `${API_BASE}/tc-workflows/streams/${webhookStreamId}/webhook`,
        { email: "inv027b@example.com" },
        cookie,
        "post-webhook-single-no-v3",
      );

      // 9. Fire postWebhookBatch
      await call(
        "POST",
        `${API_BASE}/v3/tc-workflows/streams/${webhookStreamId}/webhook/batch`,
        {
          items: [
            { requestData: { email: "batch1@example.com" } },
            { requestData: { email: "batch2@example.com" }, entityId: 42 },
          ],
        },
        cookie,
        "post-webhook-batch",
      );

      // 10. Poll: does a new workflow run appear? Check stream-runs and the
      //     workflow's main /runs endpoint.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const sr = await call(
          "GET",
          `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${webhookStreamId}/runs`,
          null,
          cookie,
          `stream-runs-poll-${i}`,
        );
        const total = sr.response?.total ?? sr.response?.runs?.length;
        if (total && total > 0) break;
      }

      await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`,
        null,
        cookie,
        "wf-runs-after-webhook",
      );

      // 11. If we got a workflow run id directly from postWebhook, poll it
      if (wfRunIdFromWebhook) {
        for (let i = 0; i < 12; i++) {
          const poll = await call(
            "GET",
            `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs/${wfRunIdFromWebhook}`,
            null,
            cookie,
            `webhook-run-poll-${i}`,
          );
          const status =
            poll.response?.workflowRun?.runStatus ??
            poll.response?.archivedAgentRun?.status;
          console.log(`  webhook-run poll ${i}: ${status}`);
          if (status === "completed" || status === "failed") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // 12. PATCH update — pause the stream
      await call(
        "PATCH",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${webhookStreamId}`,
        { status: "paused" },
        cookie,
        "stream-patch-pause",
      );
      // 13. Try posting to a paused stream
      await call(
        "POST",
        `${API_BASE}/v3/tc-workflows/streams/${webhookStreamId}/webhook`,
        { email: "paused@example.com" },
        cookie,
        "post-webhook-while-paused",
      );

      // 14. Negative probes: bad streamId, bad path
      await call(
        "POST",
        `${API_BASE}/v3/tc-workflows/streams/wrs_does_not_exist/webhook`,
        { x: 1 },
        cookie,
        "post-webhook-bad-id",
      );
    }
  } catch (e: any) {
    console.error("error:", e?.message || e);
    out.push({
      label: "main-error",
      method: "-",
      url: "-",
      status: -1,
      response: String(e?.message || e),
    });
  } finally {
    // Cleanup streams
    for (const sid of createdStreamIds) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${sid}`,
        {},
        cookie,
        `cleanup-stream-${sid}`,
      );
    }

    // Cleanup graph + workflow
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

    const f = path.join(RESULTS_DIR, `inv-027-streams-${startedAt}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log("\nsaved", f);
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(RESULTS_DIR, `inv-027-streams-error-${Date.now()}.json`),
    JSON.stringify({ error: String(e), out }, null, 2),
  );
  process.exit(1);
});
