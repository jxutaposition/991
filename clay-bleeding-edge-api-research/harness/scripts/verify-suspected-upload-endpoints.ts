/**
 * INV-023: Verify two suspected upload-URL endpoints from the Clay bundle.
 *
 *   1) POST /v3/workspaces/:workspaceId/tc-workflows/:workflowId/batches/csv-upload-url
 *      body: {filename, fileSize} → {uploadUrl, fields, uploadToken}
 *
 *   2) POST /v3/documents/:workspaceId/upload-url
 *      body: {name, folderId?, context?=agent_playground}
 *        → {documentId, uploadUrl, fields}
 *
 * Both return an S3 POST policy (multipart/form-data POST with form fields),
 * not a PUT presigned URL. We exercise both end-to-end: get the policy, POST
 * a tiny file to S3, and clean up.
 *
 * Credit-safe: these are upload-URL / file-drop endpoints, no enrichment.
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
  if (body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    finalBody = JSON.stringify(body);
  }
  const r = await fetch(url, { method, headers, body: finalBody });
  const text = await r.text().catch(() => "");
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text.substring(0, 800); }
  const res = { label, method, url, status: r.status, response: parsed };
  console.log(`[${label}] ${method} ${url.replace(API_BASE, "")} → ${r.status}`);
  out.push(res);
  return res;
}

async function s3FormPost(uploadUrl: string, fields: Record<string, string>, fileBuf: Buffer, filename: string, contentType: string, label: string) {
  const fd = new FormData();
  // S3 POST policy: order matters — all fields before `file`.
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([fileBuf], { type: contentType }), filename);
  const r = await fetch(uploadUrl, { method: "POST", body: fd });
  const text = await r.text().catch(() => "");
  const res = { label, method: "POST", url: new URL(uploadUrl).host, status: r.status, response: text.substring(0, 400) };
  console.log(`[${label}] S3 POST ${new URL(uploadUrl).host} → ${r.status}`);
  out.push(res as Result);
  return r.status;
}

async function sessionOk(cookie: string) {
  const me = await call("GET", `${API_BASE}/v3/me`, null, cookie, "auth-check");
  return me.status === 200;
}

async function verifyTcWorkflowsCsvUpload(cookie: string) {
  console.log("\n=== PART 1: tc-workflows csv-upload-url ===");

  // List workflows
  const list = await call(
    "GET",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
    null,
    cookie,
    "list-workflows",
  );

  let workflowId: string | undefined;
  let createdScratch = false;
  const workflows = list.response?.workflows;
  if (Array.isArray(workflows) && workflows.length > 0) {
    workflowId = workflows[0].id;
    console.log(`using existing workflow id=${workflowId}`);
  } else {
    // Create a scratch workflow
    const created = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
      { name: `INV-023 scratch ${Date.now()}` },
      cookie,
      "create-scratch-workflow",
    );
    workflowId = created.response?.workflow?.id;
    createdScratch = !!workflowId;
    console.log(`created scratch workflow id=${workflowId}`);
  }

  if (!workflowId) {
    console.log("no workflow available; skipping csv-upload-url probe");
    return;
  }

  // Probe 1: empty body → expect 400
  await call(
    "POST",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches/csv-upload-url`,
    {},
    cookie,
    "tcw-upload-empty",
  );

  // Probe 2: correct body per bundle schema
  const csvBody = "Name,Email\nAlice,alice@example.com\n";
  const csvBuf = Buffer.from(csvBody, "utf-8");
  const init = await call(
    "POST",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}/batches/csv-upload-url`,
    { filename: "inv023-test.csv", fileSize: csvBuf.length },
    cookie,
    "tcw-upload-init",
  );

  if (init.status === 200 && init.response?.uploadUrl && init.response?.fields) {
    const ok = await s3FormPost(
      init.response.uploadUrl,
      init.response.fields,
      csvBuf,
      "inv023-test.csv",
      "text/csv",
      "tcw-s3-post",
    );
    console.log(`tc-workflows csv upload result: S3 returned ${ok}`);
  } else {
    console.log(`tc-workflows init returned ${init.status}; skipping S3 POST`);
  }

  // Cleanup scratch workflow if we created it
  if (createdScratch && workflowId) {
    await call(
      "DELETE",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${workflowId}`,
      {},
      cookie,
      "cleanup-scratch-workflow",
    );
  }
}

async function verifyDocumentsUpload(cookie: string) {
  console.log("\n=== PART 2: documents upload-url ===");

  // Probe 1: empty body → expect 400
  await call(
    "POST",
    `${API_BASE}/v3/documents/${WORKSPACE_ID}/upload-url`,
    {},
    cookie,
    "docs-upload-empty",
  );

  // Probe 2: correct body
  const body = "Hello from INV-023 documents upload test.\n";
  const buf = Buffer.from(body, "utf-8");
  const init = await call(
    "POST",
    `${API_BASE}/v3/documents/${WORKSPACE_ID}/upload-url`,
    { name: `inv023-test-${Date.now()}.txt` },
    cookie,
    "docs-upload-init",
  );

  let documentId: string | undefined = init.response?.documentId;

  if (init.status === 200 && init.response?.uploadUrl && init.response?.fields) {
    const ct = init.response.fields["Content-Type"] || init.response.fields["content-type"] || "text/plain";
    const s3Status = await s3FormPost(
      init.response.uploadUrl,
      init.response.fields,
      buf,
      "inv023-test.txt",
      ct,
      "docs-s3-post",
    );

    // Confirm upload (makes the document visible)
    if (s3Status >= 200 && s3Status < 300 && documentId) {
      await call(
        "POST",
        `${API_BASE}/v3/documents/${WORKSPACE_ID}/${documentId}/confirm-upload`,
        {},
        cookie,
        "docs-confirm",
      );
    }
  } else {
    console.log(`documents init returned ${init.status}; skipping S3 POST`);
  }

  // Probe 3: try with explicit context + null folderId (alt shape)
  await call(
    "POST",
    `${API_BASE}/v3/documents/${WORKSPACE_ID}/upload-url`,
    { name: `inv023-alt-${Date.now()}.txt`, folderId: null, context: "agent_playground" },
    cookie,
    "docs-upload-alt-shape",
  );

  // Cleanup uploaded document
  if (documentId) {
    await call(
      "DELETE",
      `${API_BASE}/v3/documents/${WORKSPACE_ID}/${documentId}?hard=true`,
      null,
      cookie,
      "cleanup-document",
    );
  }
}

async function main() {
  const cookie = loadCookies();

  if (!(await sessionOk(cookie))) {
    console.error("session cookie expired (GET /v3/me did not return 200). STOP.");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-023-suspected-uploads-${Date.now()}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(2);
  }

  try {
    await verifyTcWorkflowsCsvUpload(cookie);
  } catch (e: any) {
    console.error("tc-workflows section error:", e?.message || e);
    out.push({ label: "tcw-error", method: "-", url: "-", status: -1, response: String(e?.message || e) });
  }

  try {
    await verifyDocumentsUpload(cookie);
  } catch (e: any) {
    console.error("documents section error:", e?.message || e);
    out.push({ label: "docs-error", method: "-", url: "-", status: -1, response: String(e?.message || e) });
  }

  const f = path.join(RESULTS_DIR, `inv-023-suspected-uploads-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log("\nsaved", f);
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(RESULTS_DIR, `inv-023-suspected-uploads-error-${Date.now()}.json`),
    JSON.stringify({ error: String(e), out }, null, 2),
  );
  process.exit(1);
});
