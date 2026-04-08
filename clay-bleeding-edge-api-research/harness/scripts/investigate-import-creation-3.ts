/**
 * INV-020 round 3:
 *  - Enumerate valid source.type values (we know S3_CSV; INLINE_CSV rejected).
 *  - Search for upload/presign endpoint to obtain an S3 key.
 *  - Verify all import history shapes for hints.
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

async function call(method: string, url: string, body: any, cookieHeader: string, label: string, extraHeaders: Record<string, string> = {}) {
  const start = Date.now();
  const headers: Record<string, string> = { Cookie: cookieHeader, Accept: "application/json", ...extraHeaders };
  let finalBody: any;
  if (body && method !== "GET") {
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
  return { label, method, url, status, requestBody: body, responseBody, latencyMs: Date.now() - start };
}

async function main() {
  const cookie = loadCookies();
  const out: any[] = [];

  // 1) Pull import history & summarize all distinct source.type values
  const list = await call("GET", `${API_BASE}/v3/imports?workspaceId=${WORKSPACE_ID}&limit=200`, null, cookie, "list");
  out.push(list);
  const arr = list.responseBody;
  const items = Array.isArray(arr) ? arr : Object.values(arr || {});
  const sourceTypes = new Set<string>();
  const destTypes = new Set<string>();
  const uploadModes = new Set<string>();
  for (const it of items) {
    if (it?.config?.source?.type) sourceTypes.add(it.config.source.type);
    if (it?.config?.destination?.type) destTypes.add(it.config.destination.type);
    if (it?.config?.source?.uploadMode) uploadModes.add(it.config.source.uploadMode);
  }
  console.log("source.type values:", [...sourceTypes]);
  console.log("destination.type values:", [...destTypes]);
  console.log("uploadMode values:", [...uploadModes]);
  console.log("total imports:", items.length);

  // Find sample keys
  const sampleKeys = items.slice(0, 5).map((it: any) => it?.config?.source?.key).filter(Boolean);
  console.log("sample S3 keys:", sampleKeys);

  // 2) Try a known existing key from history (just to see the error change)
  const reuseKey = sampleKeys[0];
  if (reuseKey) {
    // Create a scratch table & two text fields
    const mk = await call("POST", `${API_BASE}/v3/tables`, { workspaceId: WORKSPACE_ID, type: "spreadsheet", name: "INV-020 r3" }, cookie, "create-table");
    out.push(mk);
    const tableId = mk.responseBody?.id || mk.responseBody?.table?.id;
    console.log("tableId", tableId);

    const addField = async (name: string) => {
      const r = await call("POST", `${API_BASE}/v3/tables/${tableId}/fields`, {
        name,
        type: "text",
        dataTypeSettings: { type: "text" },
      }, cookie, `add-field-${name}`);
      out.push(r);
      return r.responseBody?.id || r.responseBody?.field?.id || r.responseBody?.fieldId;
    };
    const fNameField = await addField("Name");
    const fEmailField = await addField("Email");
    console.log("name field:", fNameField, "email field:", fEmailField);

    // Try with a real existing key, mapped to scratch table
    const reuseAttempt = await call("POST", `${API_BASE}/v3/imports`, {
      workspaceId: WORKSPACE_ID,
      config: {
        map: { [fNameField]: "{{\"Name\"}}", [fEmailField]: "{{\"Email\"}}" },
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
    }, cookie, "reuse-existing-key");
    out.push(reuseAttempt);
    console.log("[reuse-existing-key]", reuseAttempt.status, JSON.stringify(reuseAttempt.responseBody).substring(0, 600));

    // Cleanup
    const del = await call("DELETE", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "delete-table");
    out.push(del);
  }

  // 3) Enumerate possible upload endpoints with different prefixes
  const uploadProbes = [
    "POST /v3/imports/file",
    "POST /v3/imports/csv-upload",
    "POST /v3/imports/url",
    "POST /v3/imports/s3-presigned",
    "POST /v3/csv-upload",
    "POST /v3/csv/upload",
    "POST /v3/csv-imports",
    "POST /v3/csv-imports/presign",
    "POST /v3/files",
    "POST /v3/file/presign",
    "POST /v3/file-uploads",
    "POST /v3/file-uploads/presign",
    "POST /v3/storage/presign",
    "POST /v3/storage/upload",
    "GET /v3/files",
    "GET /v3/uploads",
    "POST /v3/uploads/csv",
  ];
  for (const p of uploadProbes) {
    const [method, pth] = p.split(" ");
    const r = await call(
      method,
      `${API_BASE}${pth}`,
      method === "GET" ? null : { workspaceId: WORKSPACE_ID, fileName: "x.csv", mimeType: "text/csv" },
      cookie,
      `probe-${pth}`,
    );
    out.push(r);
    console.log(`  ${p} → ${r.status} ${JSON.stringify(r.responseBody).substring(0, 150)}`);
    await new Promise(res => setTimeout(res, 100));
  }

  // 4) Enumerate alternative source.type strings
  const altTypes = ["CSV", "csv", "FILE", "JSON", "INLINE", "INLINE_RECORDS", "RECORDS", "URL", "GOOGLE_SHEETS", "S3", "S3_JSON", "WEBHOOK", "GOOGLE_SHEET", "PASTE_CSV", "PASTED_CSV"];
  for (const t of altTypes) {
    const r = await call("POST", `${API_BASE}/v3/imports`, {
      workspaceId: WORKSPACE_ID,
      config: {
        map: {},
        source: { type: t, records: [{ a: "1" }] },
        destination: { type: "TABLE", tableId: "t_dummy" },
      },
    }, cookie, `source-type-${t}`);
    out.push(r);
    console.log(`  source.type=${t} → ${r.status} ${JSON.stringify(r.responseBody).substring(0, 200)}`);
    await new Promise(res => setTimeout(res, 100));
  }

  const f = path.join(RESULTS_DIR, `investigate-import-creation-r3-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log("saved", f);
}

main().catch(e => { console.error(e); process.exit(1); });
