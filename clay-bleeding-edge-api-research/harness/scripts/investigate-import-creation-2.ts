/**
 * INV-020 round 2: POST /v3/imports with proper config schema derived from
 * existing import records.
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

async function call(method: string, url: string, body: any, cookieHeader: string, label: string, extraHeaders: Record<string, string> = {}, rawBody?: Buffer | string) {
  const start = Date.now();
  const headers: Record<string, string> = { Cookie: cookieHeader, Accept: "application/json", ...extraHeaders };
  let finalBody: any;
  if (rawBody !== undefined) finalBody = rawBody;
  else if (body && method !== "GET") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
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
  return { label, method, url, status, requestBody: rawBody !== undefined ? "[raw]" : body, responseBody, latencyMs: Date.now() - start };
}

async function main() {
  const cookie = loadCookies();
  const out: any[] = [];

  // Create scratch table
  const mk = await call("POST", `${API_BASE}/v3/tables`, { workspaceId: WORKSPACE_ID, type: "spreadsheet", name: "INV-020 round2" }, cookie, "create-table");
  out.push(mk);
  const tableId = mk.responseBody?.id || mk.responseBody?.table?.id;
  console.log("tableId", tableId);

  // Fetch table to get field IDs
  const tbl = await call("GET", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "get-table");
  out.push(tbl);
  const fields = tbl.responseBody?.table?.fields || tbl.responseBody?.fields || [];
  console.log("fields:", fields.map((f: any) => `${f.id}=${f.name}`).join(", "));

  // Add two text fields for Name and Email
  const addField = async (name: string) => {
    const r = await call("POST", `${API_BASE}/v3/tables/${tableId}/fields`, {
      name,
      type: "text",
    }, cookie, `add-field-${name}`);
    out.push(r);
    return r.responseBody?.id || r.responseBody?.field?.id;
  };
  const nameFieldId = await addField("Name");
  const emailFieldId = await addField("Email");
  console.log("nameFieldId", nameFieldId, "emailFieldId", emailFieldId);

  // Probe presign / upload endpoints under various paths
  const presignAttempts = [
    { method: "POST", path: "/v3/files/presign", body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv", mimeType: "text/csv" } },
    { method: "POST", path: "/v3/files/upload", body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv", mimeType: "text/csv" } },
    { method: "POST", path: "/v3/uploads", body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv", mimeType: "text/csv" } },
    { method: "POST", path: "/v3/uploads/presign", body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv", mimeType: "text/csv" } },
    { method: "POST", path: "/v3/imports/upload-url", body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv", mimeType: "text/csv" } },
    { method: "POST", path: "/v3/imports/s3-url", body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv" } },
    { method: "POST", path: "/v3/s3/presign", body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv" } },
    { method: "GET", path: `/v3/imports/presign?workspaceId=${WORKSPACE_ID}&fileName=inv020.csv`, body: null },
  ];
  for (const p of presignAttempts) {
    const r = await call(p.method, `${API_BASE}${p.path}`, p.body, cookie, `presign-${p.path}`);
    out.push(r);
    console.log(`  [presign] ${p.method} ${p.path} → ${r.status} ${JSON.stringify(r.responseBody).substring(0, 200)}`);
    await new Promise(res => setTimeout(res, 150));
  }

  // Main attempts: POST /v3/imports with proper config schema from sample
  const fullConfig = {
    workspaceId: WORKSPACE_ID,
    config: {
      map: {
        [nameFieldId]: "{{\"Name\"}}",
        [emailFieldId]: "{{\"Email\"}}",
      },
      source: {
        key: `${WORKSPACE_ID}/inv020-test.csv`,
        type: "S3_CSV",
        records: [
          { Name: "Name", Email: "Email" },
          { Name: "Alice", Email: "alice@example.com" },
          { Name: "Bob", Email: "bob@example.com" },
        ],
        filename: "inv020-test.csv",
        hasHeader: true,
        recordKeys: ["Name", "Email"],
        uploadMode: "import",
        fieldDelimiter: ",",
      },
      destination: {
        type: "TABLE",
        tableId,
      },
      isImportWithoutRun: false,
    },
  };

  const fullConfigRes = await call("POST", `${API_BASE}/v3/imports`, fullConfig, cookie, "full-config-schema");
  out.push(fullConfigRes);
  console.log("\n[full-config-schema]", fullConfigRes.status, JSON.stringify(fullConfigRes.responseBody).substring(0, 600));

  // Inline variant — no S3 key, only records
  const inlineConfig = {
    workspaceId: WORKSPACE_ID,
    config: {
      map: {
        [nameFieldId]: "{{\"Name\"}}",
        [emailFieldId]: "{{\"Email\"}}",
      },
      source: {
        type: "INLINE_CSV",
        records: [
          { Name: "Alice", Email: "alice@example.com" },
          { Name: "Bob", Email: "bob@example.com" },
        ],
        filename: "inline.csv",
        hasHeader: true,
        recordKeys: ["Name", "Email"],
        uploadMode: "import",
        fieldDelimiter: ",",
      },
      destination: { type: "TABLE", tableId },
      isImportWithoutRun: true,
    },
  };
  const inlineRes = await call("POST", `${API_BASE}/v3/imports`, inlineConfig, cookie, "inline-records");
  out.push(inlineRes);
  console.log("[inline-records]", inlineRes.status, JSON.stringify(inlineRes.responseBody).substring(0, 600));

  // Without records — records may be pulled from S3 after upload
  const noRecordsConfig = {
    workspaceId: WORKSPACE_ID,
    config: {
      map: { [nameFieldId]: "{{\"Name\"}}", [emailFieldId]: "{{\"Email\"}}" },
      source: {
        key: `${WORKSPACE_ID}/inv020-no-records.csv`,
        type: "S3_CSV",
        filename: "inv020-no-records.csv",
        hasHeader: true,
        recordKeys: ["Name", "Email"],
        uploadMode: "import",
        fieldDelimiter: ",",
      },
      destination: { type: "TABLE", tableId },
      isImportWithoutRun: true,
    },
  };
  const noRecRes = await call("POST", `${API_BASE}/v3/imports`, noRecordsConfig, cookie, "no-records");
  out.push(noRecRes);
  console.log("[no-records]", noRecRes.status, JSON.stringify(noRecRes.responseBody).substring(0, 600));

  // Maybe top-level tableId  / destinationTableId
  const flatRes = await call("POST", `${API_BASE}/v3/imports`, {
    workspaceId: WORKSPACE_ID,
    tableId,
    map: { [nameFieldId]: "Name", [emailFieldId]: "Email" },
    source: fullConfig.config.source,
  }, cookie, "flat-shape");
  out.push(flatRes);
  console.log("[flat-shape]", flatRes.status, JSON.stringify(flatRes.responseBody).substring(0, 400));

  // If any import was created, list imports to confirm and note its id
  const listAfter = await call("GET", `${API_BASE}/v3/imports?workspaceId=${WORKSPACE_ID}`, null, cookie, "list-after");
  out.push(listAfter);
  console.log("[list-after]", listAfter.status);

  // Cleanup
  const del = await call("DELETE", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "delete-table");
  out.push(del);
  console.log("cleanup:", del.status);

  const f = path.join(RESULTS_DIR, `investigate-import-creation-r2-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log("saved", f);
}

main().catch(e => { console.error(e); process.exit(1); });
