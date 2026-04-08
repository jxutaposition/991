/**
 * INV-025: tc-workflows step / snapshot CRUD + bonus probes
 *          (cpj_search batch type, batch cancellation via PATCH).
 *
 * Routers extracted from current Clay bundle (index-Ba1k0a3-.js):
 *
 *   uYe (~668 KB)  - tc-workflows top-level + snapshots
 *     getWorkflowSnapshots:  GET    /v3/workspaces/:ws/tc-workflows/:wf/snapshots
 *     getWorkflowSnapshot:   GET    /v3/workspaces/:ws/tc-workflows/:wf/snapshots/:snapshotId
 *     restoreWorkflowFromSnapshot: POST .../tc-workflows/:wf/restore/:snapshotId
 *     createWorkflowFromSnapshot:  POST .../tc-workflows/from-snapshot/:snapshotId
 *     duplicateWorkflow:           POST .../tc-workflows/:wf/duplicate
 *
 *   mYe (~669 KB)  - tc-workflows graph (nodes + edges)
 *     getWorkflowGraph:   GET    /v3/workspaces/:ws/tc-workflows/:wf/graph
 *     createWorkflowNode: POST   /v3/workspaces/:ws/tc-workflows/:wf/nodes
 *         body: { name, description?, nodeType (regular|code|conditional|map|reduce|tool) (default 'regular'),
 *                 modelId?, promptVersionId?, position?:{x,y}, isInitial?, isTerminal? }
 *         response: { node }
 *     updateWorkflowNode: PATCH  /v3/workspaces/:ws/tc-workflows/:wf/nodes/:nodeId
 *     batchUpdateWorkflowNodes: PATCH .../nodes  body {updates:[{nodeId,position}]}
 *     deleteWorkflowNode: DELETE /v3/workspaces/:ws/tc-workflows/:wf/nodes/:nodeId
 *     duplicateWorkflowNode: POST .../nodes/:nodeId/duplicate
 *     batchDeleteWorkflowNodes: DELETE .../nodes  body {nodeIds:string[]}
 *     createWorkflowEdge: POST   .../edges  body {sourceNodeId, targetNodeId, metadata?}
 *     updateWorkflowEdge: PATCH  .../edges/:edgeId
 *     deleteWorkflowEdge: DELETE .../edges/:edgeId
 *
 * Credit safety:
 *   - We DO NOT execute the workflow. We never POST a batch against a workflow
 *     that has any nodes attached. Steps are exercised purely as definitions.
 *   - For batch / cpj_search / cancellation probes we recreate an empty
 *     workflow with zero nodes (proven credit-safe in INV-024).
 *   - 'regular' nodes with no modelId / no prompt are inert definitions —
 *     they do nothing on their own.
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

async function s3FormPost(
  uploadUrl: string,
  fields: Record<string, string>,
  fileBuf: Buffer,
  filename: string,
  contentType: string,
  label: string,
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([fileBuf], { type: contentType }), filename);
  const r = await fetch(uploadUrl, { method: "POST", body: fd });
  const text = await r.text().catch(() => "");
  out.push({
    label,
    method: "POST",
    url: new URL(uploadUrl).host,
    status: r.status,
    response: text.substring(0, 400),
  });
  console.log(`[${label}] S3 POST ${new URL(uploadUrl).host} -> ${r.status}`);
  return r.status;
}

async function main() {
  const cookie = loadCookies();
  const startedAt = Date.now();

  // Auth precheck
  const me = await call("GET", `${API_BASE}/v3/me`, null, cookie, "auth-check");
  if (me.status !== 200) {
    console.error("session expired - STOP");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-025-workflow-steps-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(2);
  }

  // Read credit balance before
  const wsBefore = await call(
    "GET",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}`,
    null,
    cookie,
    "credits-before",
  );
  const creditsBefore = wsBefore.response?.workspace?.credits;

  // Create scratch workflow A (for steps + snapshots probes)
  const wfA = await call(
    "POST",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
    { name: `INV-025 steps scratch ${Date.now()}` },
    cookie,
    "create-wf-A",
  );
  const wfIdA: string | undefined = wfA.response?.workflow?.id;
  console.log("wfIdA=", wfIdA);
  if (!wfIdA) {
    console.error("could not create scratch wf");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-025-workflow-steps-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(3);
  }

  let nodeId: string | undefined;
  let nodeId2: string | undefined;
  let edgeId: string | undefined;
  let snapshotIdResolved: string | undefined;
  let wfIdB: string | undefined;
  let cancelBatchId: string | undefined;
  let cpjBatchId: string | undefined;

  try {
    // ======================================================================
    // 1. GRAPH + NODE + EDGE CRUD
    // ======================================================================

    // GET initial graph (should be empty)
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/graph`,
      null,
      cookie,
      "graph-empty",
    );

    // POST node — minimal regular node (no model, no prompt -> inert)
    const createNode = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/nodes`,
      {
        name: "INV-025 first node",
        nodeType: "regular",
        position: { x: 100, y: 100 },
        isInitial: true,
      },
      cookie,
      "create-node-1",
    );
    nodeId = createNode.response?.node?.id;
    console.log("nodeId=", nodeId);

    // POST node 2 (target of an edge)
    const createNode2 = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/nodes`,
      {
        name: "INV-025 second node",
        nodeType: "regular",
        position: { x: 300, y: 100 },
        isTerminal: true,
      },
      cookie,
      "create-node-2",
    );
    nodeId2 = createNode2.response?.node?.id;

    // PATCH node — rename
    if (nodeId) {
      await call(
        "PATCH",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/nodes/${nodeId}`,
        { name: "INV-025 first node (renamed)", description: "patched in inv-025" },
        cookie,
        "patch-node-1",
      );
    }

    // POST edge between node1 -> node2
    if (nodeId && nodeId2) {
      const ce = await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/edges`,
        { sourceNodeId: nodeId, targetNodeId: nodeId2 },
        cookie,
        "create-edge",
      );
      edgeId = ce.response?.edge?.id;
    }

    // GET graph again (should now have nodes+edge)
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/graph`,
      null,
      cookie,
      "graph-after-create",
    );

    // batchUpdateWorkflowNodes — move both
    if (nodeId && nodeId2) {
      await call(
        "PATCH",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/nodes`,
        {
          updates: [
            { nodeId, position: { x: 150, y: 150 } },
            { nodeId: nodeId2, position: { x: 350, y: 150 } },
          ],
        },
        cookie,
        "batch-update-nodes",
      );
    }

    // ======================================================================
    // 2. SNAPSHOT CRUD
    // ======================================================================

    // GET snapshots — initially empty (no batches yet)
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/snapshots`,
      null,
      cookie,
      "snapshots-list-empty",
    );

    // To get a snapshot to materialize we'd need to create a batch — but THIS
    // workflow has nodes, so a batch could spawn runs and burn credits. We
    // sidestep by listing workflow B's snapshots after we exercise its batch.
    // Skip materialization here.

    // ======================================================================
    // 3. CLEANUP graph (delete edge + nodes BEFORE workflow delete is fine)
    //    but defer to finally block.
    // ======================================================================

    // ======================================================================
    // 4. SECOND SCRATCH WORKFLOW (empty, credit-safe) — exercise batch PATCH,
    //    cpj_search, snapshot listing after batch creates one.
    // ======================================================================
    const wfB = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
      { name: `INV-025 batches scratch ${Date.now()}` },
      cookie,
      "create-wf-B",
    );
    wfIdB = wfB.response?.workflow?.id;

    if (wfIdB) {
      // 4a. cpj_search probes — try several shapes
      const cpjShapes: any[] = [
        { label: "cpj-empty-config", body: { workflowSnapshotId: "latest", type: "cpj_search", config: {} } },
        { label: "cpj-no-config", body: { workflowSnapshotId: "latest", type: "cpj_search" } },
        {
          label: "cpj-with-search",
          body: {
            workflowSnapshotId: "latest",
            type: "cpj_search",
            config: { searchType: "people", query: { keywords: "engineer" } },
          },
        },
      ];

      for (const shape of cpjShapes) {
        const r = await call(
          "POST",
          `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/batches`,
          shape.body,
          cookie,
          shape.label,
        );
        if (r.status === 200 && r.response?.batch?.id) {
          cpjBatchId = r.response.batch.id;
          break;
        }
      }

      // 4b. Create a real csv_import batch then PATCH to cancel it
      const csvBody = "Name,Email\nAlice,alice@example.com\n";
      const csvBuf = Buffer.from(csvBody, "utf-8");
      const init = await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/batches/csv-upload-url`,
        { filename: "inv025-test.csv", fileSize: csvBuf.length },
        cookie,
        "csv-upload-url",
      );
      if (init.status === 200 && init.response?.uploadToken) {
        const s3 = await s3FormPost(
          init.response.uploadUrl,
          init.response.fields,
          csvBuf,
          "inv025-test.csv",
          "text/csv",
          "s3-post",
        );
        if (s3 >= 200 && s3 < 300) {
          const create = await call(
            "POST",
            `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/batches`,
            {
              workflowSnapshotId: "latest",
              type: "csv_import",
              csvUploadToken: init.response.uploadToken,
              config: { standaloneActions: [] },
            },
            cookie,
            "create-csv-batch-for-cancel",
          );
          cancelBatchId = create.response?.batch?.id;
          snapshotIdResolved = create.response?.batch?.workflowSnapshotId;

          // 4c. Immediate PATCH cancel — race the auto-fail (~430ms in INV-024)
          if (cancelBatchId) {
            await call(
              "PATCH",
              `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/batches/${cancelBatchId}`,
              { status: "cancelled" },
              cookie,
              "patch-batch-cancel",
            );

            // GET to read final status
            await call(
              "GET",
              `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/batches/${cancelBatchId}`,
              null,
              cookie,
              "get-cancelled-batch",
            );
          }
        }
      }

      // 4d. Now snapshots should exist for wfB. List them.
      const snaps = await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/snapshots`,
        null,
        cookie,
        "snapshots-list-after-batch",
      );
      const snapshots = snaps.response?.snapshots;
      if (Array.isArray(snapshots) && snapshots.length > 0) {
        const sid = snapshots[0]?.id;
        if (sid) {
          await call(
            "GET",
            `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/snapshots/${sid}`,
            null,
            cookie,
            "get-snapshot",
          );
        }
      }
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
    // Cleanup wfA: delete edge -> nodes -> workflow
    if (edgeId && wfIdA) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/edges/${edgeId}`,
        {},
        cookie,
        "cleanup-edge",
      );
    }
    // Use batchDeleteWorkflowNodes for both nodes (also exercises that endpoint)
    if (wfIdA && (nodeId || nodeId2)) {
      const ids = [nodeId, nodeId2].filter(Boolean) as string[];
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}/nodes`,
        { nodeIds: ids },
        cookie,
        "cleanup-batch-delete-nodes",
      );
    }
    if (wfIdA) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdA}`,
        {},
        cookie,
        "cleanup-wf-A",
      );
    }

    // Cleanup wfB: delete batches then workflow
    if (cancelBatchId && wfIdB) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/batches/${cancelBatchId}`,
        {},
        cookie,
        "cleanup-cancel-batch",
      );
    }
    if (cpjBatchId && wfIdB) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}/batches/${cpjBatchId}`,
        {},
        cookie,
        "cleanup-cpj-batch",
      );
    }
    if (wfIdB) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfIdB}`,
        {},
        cookie,
        "cleanup-wf-B",
      );
    }

    // Read credit balance after
    const wsAfter = await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}`,
      null,
      cookie,
      "credits-after",
    );
    const creditsAfter = wsAfter.response?.workspace?.credits;
    out.push({
      label: "credit-delta",
      method: "-",
      url: "-",
      status: 0,
      response: { before: creditsBefore, after: creditsAfter },
    });
    console.log("credits before:", JSON.stringify(creditsBefore));
    console.log("credits after :", JSON.stringify(creditsAfter));

    const f = path.join(RESULTS_DIR, `inv-025-workflow-steps-${startedAt}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log("\nsaved", f);
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(RESULTS_DIR, `inv-025-workflow-steps-error-${Date.now()}.json`),
    JSON.stringify({ error: String(e), out }, null, 2),
  );
  process.exit(1);
});
