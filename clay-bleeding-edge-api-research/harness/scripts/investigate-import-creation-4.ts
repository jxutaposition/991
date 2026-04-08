/**
 * INV-020 round 4:
 *  - Verify the created import job (previous run) actually finished and what it did
 *  - Fix field creation (with dataTypeSettings) and do a full end-to-end import cycle:
 *      create table → add fields → POST /v3/imports → poll import status → read rows
 *  - Probe for the S3 upload endpoint (/v3/imports/{id}/upload, /v3/imports/upload)
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

async function call(method: string, url: string, body: any, cookieHeader: string, label: string) {
  const start = Date.now();
  const headers: Record<string, string> = { Cookie: cookieHeader, Accept: "application/json" };
  let finalBody: any;
  if (body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    finalBody = JSON.stringify(body);
  }
  let status = 0;
  let responseBody: any = null;
  try {
    const r = await fetch(url, { method, headers, body: finalBody });
    status = r.status;
    try { responseBody = await r.json(); } catch { responseBody = await r.text().catch(() => null); }
  } catch (e: any) {
    responseBody = { error: e.message };
  }
  return { label, method, url, status, requestBody: body, responseBody, latencyMs: Date.now() - start };
}

async function main() {
  const cookie = loadCookies();
  const out: any[] = [];

  // 1) Look up the previously created import job
  const prevJobId = "ij_0td4wovJjRaxEYsEuNw";
  const lookup = await call("GET", `${API_BASE}/v3/imports/${prevJobId}`, null, cookie, "lookup-prev-job");
  out.push(lookup);
  console.log("[prev import]", lookup.status, JSON.stringify(lookup.responseBody).substring(0, 600));

  // 2) Full end-to-end test
  const mk = await call("POST", `${API_BASE}/v3/tables`, { workspaceId: WORKSPACE_ID, type: "spreadsheet", name: "INV-020 r4 e2e" }, cookie, "create-table");
  out.push(mk);
  const tableId = mk.responseBody?.id || mk.responseBody?.table?.id;
  console.log("tableId", tableId);

  // Correct field creation
  const addField = async (name: string) => {
    const r = await call("POST", `${API_BASE}/v3/tables/${tableId}/fields`, {
      name,
      dataTypeSettings: { type: "text" },
    }, cookie, `add-field-${name}`);
    out.push(r);
    const fid = r.responseBody?.id || r.responseBody?.field?.id || r.responseBody?.fieldId;
    console.log(`  add-field(${name}) → ${r.status} fid=${fid}`);
    return fid;
  };
  const nameFid = await addField("Name");
  const emailFid = await addField("Email");

  // Pull existing key
  const list = await call("GET", `${API_BASE}/v3/imports?workspaceId=${WORKSPACE_ID}&limit=5`, null, cookie, "list");
  out.push(list);
  const items = Array.isArray(list.responseBody) ? list.responseBody : Object.values(list.responseBody || {});
  const reuseKey = (items[0] as any)?.config?.source?.key;
  console.log("reuseKey:", reuseKey);

  // Create import pointing to scratch table, using a known S3 key
  const create = await call("POST", `${API_BASE}/v3/imports`, {
    workspaceId: WORKSPACE_ID,
    config: {
      map: { [nameFid]: "{{\"Name\"}}", [emailFid]: "{{\"Email\"}}" },
      source: {
        key: reuseKey,
        type: "S3_CSV",
        filename: reuseKey.split("/").pop(),
        hasHeader: true,
        recordKeys: ["Name", "Email"],
        uploadMode: "import",
        fieldDelimiter: ",",
      },
      destination: { type: "TABLE", tableId },
      isImportWithoutRun: true,
    },
  }, cookie, "create-import");
  out.push(create);
  console.log("[create-import]", create.status, JSON.stringify(create.responseBody).substring(0, 500));
  const importId = create.responseBody?.id;

  // Poll for completion
  if (importId) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await call("GET", `${API_BASE}/v3/imports/${importId}`, null, cookie, `poll-${i}`);
      out.push(poll);
      const st = poll.responseBody?.state?.status;
      const rows = poll.responseBody?.state?.numRowsSoFar;
      console.log(`  poll ${i}: state=${st} rows=${rows}`);
      if (st === "FINISHED" || st === "FAILED" || st === "ERROR") break;
    }
  }

  // Read rows from the destination table to confirm
  const tbl = await call("GET", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "get-table");
  out.push(tbl);
  const views = tbl.responseBody?.table?.views || tbl.responseBody?.views || [];
  const viewId = views[0]?.id;
  console.log("viewId:", viewId);
  if (viewId) {
    const recs = await call("GET", `${API_BASE}/v3/tables/${tableId}/views/${viewId}/records?limit=5`, null, cookie, "read-records");
    out.push(recs);
    console.log("records:", recs.status, JSON.stringify(recs.responseBody).substring(0, 500));
  }

  // 3) Probe for upload endpoints with the new import id
  const uploadProbes = [
    `POST /v3/imports/${importId}/upload`,
    `POST /v3/imports/${importId}/presign`,
    `POST /v3/imports/${importId}/file`,
    `PUT /v3/imports/${importId}`,
    `POST /v3/imports/${importId}/start`,
    `POST /v3/imports/${importId}/run`,
  ];
  for (const p of uploadProbes) {
    const [method, pth] = p.split(" ");
    const r = await call(method, `${API_BASE}${pth}`, method === "GET" ? null : {}, cookie, `probe-${pth}`);
    out.push(r);
    console.log(`  ${p} → ${r.status} ${JSON.stringify(r.responseBody).substring(0, 150)}`);
  }

  // Cleanup
  const del = await call("DELETE", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "delete-table");
  out.push(del);
  console.log("cleanup:", del.status);

  const f = path.join(RESULTS_DIR, `investigate-import-creation-r4-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log("saved", f);
}

main().catch(e => { console.error(e); process.exit(1); });
