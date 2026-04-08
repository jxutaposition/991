/**
 * INV-024: Close the tc-workflows ingestion loop by exercising
 *          createWorkflowRunBatch (consumes the uploadToken from
 *          csv-upload-url to actually kick off a workflow run batch).
 *
 * Routes (extracted from app.clay.com bundle, ts-rest router xwe):
 *   POST   /v3/workspaces/:ws/tc-workflows/:wf/batches
 *          body discriminated on `type`:
 *            { workflowSnapshotId: "latest", type: "csv_import",
 *              csvUploadToken, config?: object }
 *            { workflowSnapshotId: "latest", type: "cpj_search", config?: object }
 *          response: { batch: WorkflowRunBatch }
 *   GET    /v3/workspaces/:ws/tc-workflows/:wf/batches
 *   GET    /v3/workspaces/:ws/tc-workflows/:wf/batches/:batchId
 *   PATCH  /v3/workspaces/:ws/tc-workflows/:wf/batches/:batchId  body {status?, config?, state?}
 *   DELETE /v3/workspaces/:ws/tc-workflows/:wf/batches/:batchId  body {}
 *   GET    /v3/workspaces/:ws/tc-workflows/:wf/batches/:batchId/runs
 *
 * Credit safety: scratch workflow has zero defined steps. The bundle indicates
 * batch runs only execute the workflow's defined steps; with no steps there is
 * nothing to execute and no enrichment credits should be consumed. We use a
 * 1-row CSV. We DELETE the batch and the scratch workflow at the end.
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
  // gentle throttle
  await new Promise((res) => setTimeout(res, 200));
  return res;
}

async function s3FormPost(uploadUrl: string, fields: Record<string, string>, fileBuf: Buffer, filename: string, contentType: string, label: string) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([fileBuf], { type: contentType }), filename);
  const r = await fetch(uploadUrl, { method: "POST", body: fd });
  const text = await r.text().catch(() => "");
  const res = { label, method: "POST", url: new URL(uploadUrl).host, status: r.status, response: text.substring(0, 400) };
  console.log(`[${label}] S3 POST ${new URL(uploadUrl).host} -> ${r.status}`);
  out.push(res as Result);
  return r.status;
}

async function sessionOk(cookie: string) {
  const me = await call("GET", `${API_BASE}/v3/me`, null, cookie, "auth-check");
  return me.status === 200;
}

async function main() {
  const cookie = loadCookies();
  const startedAt = Date.now();

  if (!(await sessionOk(cookie))) {
    console.error("session cookie expired (GET /v3/me did not return 200). STOP.");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-024-workflow-batch-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(2);
  }

  // 1. List existing tc-workflows
  const list = await call(
    "GET",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
    null,
    cookie,
    "list-workflows",
  );

  let workflowId: string | undefined;
  let createdScratchWorkflow = false;
  const workflows = list.response?.workflows;
  if (Array.isArray(workflows) && workflows.length > 0) {
    // Prefer an existing workflow whose name starts with INV- (our scratch),
    // otherwise create a fresh scratch one to be safe (don't risk running
    // batches against user workflows).
    const existingScratch = workflows.find((w: any) => /^INV-/.test(w?.name || ""));
    if (existingScratch) {
      workflowId = existingScratch.id;
      console.log(`reusing existing scratch workflow id=${workflowId}`);
    }
  }

  if (!workflowId) {
    const created = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
      { name: `INV-024 scratch ${Date.now()}` },
      cookie,
      "create-scratch-workflow",
    );
    workflowId = created.response?.workflow?.id;
    createdScratchWorkflow = !!workflowId;
    console.log(`created scratch workflow id=${workflowId}`);
  }

  if (!workflowId) {
    console.error("no workflow available; aborting");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-024-workflow-batch-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(3);
  }

  let batchId: string | undefined;

  try {
    // 2. csv-upload-url -> uploadToken
    const csvBody = "Name,Email\nAlice,alice@example.com\n";
    const csvBuf = Buffer.from(csvBody, "utf-8");
    const init = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches/csv-upload-url`,
      { filename: "inv024-test.csv", fileSize: csvBuf.length },
      cookie,
      "csv-upload-url",
    );
    if (init.status !== 200 || !init.response?.uploadToken) {
      throw new Error(`csv-upload-url failed: ${init.status}`);
    }
    const uploadToken: string = init.response.uploadToken;

    // 3. S3 POST upload
    const s3Status = await s3FormPost(
      init.response.uploadUrl,
      init.response.fields,
      csvBuf,
      "inv024-test.csv",
      "text/csv",
      "s3-post",
    );
    if (s3Status < 200 || s3Status >= 300) {
      throw new Error(`S3 POST failed: ${s3Status}`);
    }

    // 4. Create batch — empty body first to verify route exists (expect 400 BadRequest)
    await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches`,
      {},
      cookie,
      "create-batch-empty",
    );

    // 5. Create batch — full body per bundle schema
    const create = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches`,
      {
        workflowSnapshotId: "latest",
        type: "csv_import",
        csvUploadToken: uploadToken,
        config: { standaloneActions: [] },
      },
      cookie,
      "create-batch-full",
    );

    batchId = create.response?.batch?.id;
    console.log(`created batch id=${batchId}`);

    // 6. List batches for this workflow
    await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches`,
      null,
      cookie,
      "list-batches",
    );

    // 7. Poll batch status (max 8 polls = ~16s)
    if (batchId) {
      for (let i = 0; i < 8; i++) {
        const poll = await call(
          "GET",
          `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches/${batchId}`,
          null,
          cookie,
          `poll-batch-${i}`,
        );
        const status = poll.response?.batch?.status;
        if (status && ["completed", "failed", "cancelled"].includes(status)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      // 8. List runs for the batch
      await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches/${batchId}/runs`,
        null,
        cookie,
        "list-runs",
      );
    }
  } catch (e: any) {
    console.error("error in main flow:", e?.message || e);
    out.push({ label: "main-error", method: "-", url: "-", status: -1, response: String(e?.message || e) });
  } finally {
    // Cleanup
    if (batchId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches/${batchId}`,
        {},
        cookie,
        "cleanup-batch",
      );
    }
    if (createdScratchWorkflow && workflowId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}`,
        {},
        cookie,
        "cleanup-scratch-workflow",
      );
    }

    const f = path.join(RESULTS_DIR, `inv-024-workflow-batch-${startedAt}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log("\nsaved", f);
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(RESULTS_DIR, `inv-024-workflow-batch-error-${Date.now()}.json`),
    JSON.stringify({ error: String(e), out }, null, 2),
  );
  process.exit(1);
});
