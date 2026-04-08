/**
 * INV-020: Import Job Creation (TODO-024)
 *
 * Attempts to figure out the correct payload format for POST /v3/imports.
 * Existing records from GET /v3/imports are studied first.
 *
 * Output: ../results/investigate-import-creation-{ts}.json
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE_ID = 1080480;
const RESULTS_DIR = path.join(__dirname, "..", "results");
const COOKIE_FILE = path.join(RESULTS_DIR, ".session-cookies.json");

function loadCookies(): string {
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

interface Attempt {
  label: string;
  method: string;
  url: string;
  contentType: string;
  requestBody: any;
  status: number;
  responseBody: any;
  latencyMs: number;
}

async function call(
  method: string,
  url: string,
  body: any,
  cookieHeader: string,
  label: string,
  extraHeaders: Record<string, string> = {},
  rawBody?: Buffer | string,
): Promise<Attempt> {
  const start = Date.now();
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "application/json",
    ...extraHeaders,
  };
  let finalBody: any = undefined;
  let contentType = extraHeaders["Content-Type"] || "";
  if (rawBody !== undefined) {
    finalBody = rawBody;
  } else if (body !== null && body !== undefined && method !== "GET") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    contentType = headers["Content-Type"];
    finalBody = JSON.stringify(body);
  }
  let status = 0;
  let responseBody: any = null;
  try {
    const res = await fetch(url, { method, headers, body: finalBody });
    status = res.status;
    try {
      responseBody = await res.json();
    } catch {
      try {
        responseBody = await res.text();
      } catch {
        responseBody = null;
      }
    }
  } catch (e: any) {
    responseBody = { error: e.message };
  }
  return {
    label,
    method,
    url,
    contentType,
    requestBody: rawBody !== undefined ? "[raw]" : body,
    status,
    responseBody,
    latencyMs: Date.now() - start,
  };
}

async function main() {
  const cookieHeader = loadCookies();
  const attempts: Attempt[] = [];

  console.log("[inv-020] Step 1: GET /v3/imports");
  const list = await call(
    "GET",
    `${API_BASE}/v3/imports?workspaceId=${WORKSPACE_ID}`,
    null,
    cookieHeader,
    "list-imports",
  );
  attempts.push(list);
  console.log(`  status=${list.status} keys=${Object.keys(list.responseBody || {}).join(",")}`);

  // Bail out early if auth is broken
  if (list.status === 401 || list.status === 403) {
    console.error("[inv-020] AUTH FAILURE — session cookie likely expired");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `investigate-import-creation-${Date.now()}.json`),
      JSON.stringify(attempts, null, 2),
    );
    process.exit(2);
  }

  // Grab a sample shape
  let sampleImport: any = null;
  const lb = list.responseBody;
  if (lb) {
    const arr = lb.results || lb.imports || lb.data || (Array.isArray(lb) ? lb : null);
    if (arr && arr.length) sampleImport = arr[0];
  }
  console.log(`  sampleImport keys: ${sampleImport ? Object.keys(sampleImport).join(",") : "(none)"}`);

  // Step 2: create scratch table to import into
  console.log("[inv-020] Step 2: Create scratch table");
  const mkTable = await call(
    "POST",
    `${API_BASE}/v3/tables`,
    { workspaceId: WORKSPACE_ID, type: "spreadsheet", name: "INV-020 import scratch" },
    cookieHeader,
    "create-scratch-table",
  );
  attempts.push(mkTable);
  const tableId =
    mkTable.responseBody?.id ||
    mkTable.responseBody?.table?.id ||
    mkTable.responseBody?.tableId ||
    null;
  console.log(`  status=${mkTable.status} tableId=${tableId}`);

  if (!tableId) {
    console.error("[inv-020] Could not create scratch table, aborting write attempts");
  }

  // Step 3: probe POST /v3/imports with multiple payload variations
  const csvText = "name,email\nAlice,alice@example.com\nBob,bob@example.com\n";
  const boundary = "----InvFormBoundary" + Date.now();

  const payloadVariants: Array<{ label: string; method: string; path: string; body?: any; rawBody?: Buffer | string; headers?: Record<string, string> }> = [
    {
      label: "empty-json",
      method: "POST",
      path: `/v3/imports`,
      body: {},
    },
    {
      label: "workspaceId-only",
      method: "POST",
      path: `/v3/imports`,
      body: { workspaceId: WORKSPACE_ID },
    },
    {
      label: "workspaceId-type-csv",
      method: "POST",
      path: `/v3/imports`,
      body: { workspaceId: WORKSPACE_ID, type: "csv" },
    },
    {
      label: "workspaceId-tableId-csv",
      method: "POST",
      path: `/v3/imports`,
      body: { workspaceId: WORKSPACE_ID, tableId, type: "csv" },
    },
    {
      label: "full-guess",
      method: "POST",
      path: `/v3/imports`,
      body: {
        workspaceId: WORKSPACE_ID,
        tableId,
        type: "csv",
        fileName: "inv020.csv",
        mimeType: "text/csv",
        size: csvText.length,
      },
    },
    {
      label: "with-config",
      method: "POST",
      path: `/v3/imports`,
      body: {
        workspaceId: WORKSPACE_ID,
        tableId,
        type: "CSV",
        config: {
          fileName: "inv020.csv",
          mimeType: "text/csv",
          columnMappings: [
            { sourceColumn: "name", targetField: "Name" },
            { sourceColumn: "email", targetField: "Email" },
          ],
        },
      },
    },
    {
      label: "source-style",
      method: "POST",
      path: `/v3/imports`,
      body: {
        workspaceId: WORKSPACE_ID,
        tableId,
        sourceType: "CSV_UPLOAD",
      },
    },
    {
      label: "multipart-form",
      method: "POST",
      path: `/v3/imports`,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      rawBody: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="workspaceId"\r\n\r\n${WORKSPACE_ID}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="tableId"\r\n\r\n${tableId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="inv020.csv"\r\nContent-Type: text/csv\r\n\r\n${csvText}\r\n` +
        `--${boundary}--\r\n`,
      ),
    },
    {
      label: "put-presign",
      method: "PUT",
      path: `/v3/imports`,
      body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv", mimeType: "text/csv" },
    },
    // Alternative sibling endpoints
    {
      label: "sibling-imports-csv",
      method: "POST",
      path: `/v3/imports/csv`,
      body: { workspaceId: WORKSPACE_ID, tableId },
    },
    {
      label: "sibling-imports-upload",
      method: "POST",
      path: `/v3/imports/upload`,
      body: { workspaceId: WORKSPACE_ID, tableId, fileName: "inv020.csv" },
    },
    {
      label: "sibling-imports-presign",
      method: "POST",
      path: `/v3/imports/presign`,
      body: { workspaceId: WORKSPACE_ID, fileName: "inv020.csv", mimeType: "text/csv" },
    },
    {
      label: "sibling-imports-init",
      method: "POST",
      path: `/v3/imports/init`,
      body: { workspaceId: WORKSPACE_ID, tableId, fileName: "inv020.csv" },
    },
    {
      label: "sibling-imports-start",
      method: "POST",
      path: `/v3/imports/start`,
      body: { workspaceId: WORKSPACE_ID, tableId },
    },
    // Table-scoped variants
    {
      label: "table-scoped-imports",
      method: "POST",
      path: `/v3/tables/${tableId}/imports`,
      body: { workspaceId: WORKSPACE_ID, type: "csv" },
    },
    {
      label: "table-scoped-import",
      method: "POST",
      path: `/v3/tables/${tableId}/import`,
      body: { workspaceId: WORKSPACE_ID, type: "csv" },
    },
  ];

  console.log("[inv-020] Step 3: Probing payload variants");
  for (const v of payloadVariants) {
    if (v.path.includes("null") || (v.path.includes("/tables/") && !tableId)) continue;
    const r = await call(
      v.method,
      `${API_BASE}${v.path}`,
      v.body ?? null,
      cookieHeader,
      v.label,
      v.headers || {},
      v.rawBody,
    );
    attempts.push(r);
    const snippet = JSON.stringify(r.responseBody).substring(0, 300);
    console.log(`  [${v.label}] ${v.method} ${v.path} → ${r.status}  ${snippet}`);
    await new Promise((res) => setTimeout(res, 150));
  }

  // Step 4: Cleanup scratch table
  if (tableId) {
    console.log("[inv-020] Step 4: Cleanup scratch table");
    const del = await call(
      "DELETE",
      `${API_BASE}/v3/tables/${tableId}`,
      null,
      cookieHeader,
      "delete-scratch-table",
    );
    attempts.push(del);
    console.log(`  status=${del.status}`);
  }

  const ts = Date.now();
  const outFile = path.join(RESULTS_DIR, `investigate-import-creation-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ sampleImport, attempts }, null, 2));
  console.log(`[inv-020] Results saved: ${outFile}`);

  const summary = attempts.map((a) => `${a.status} ${a.method} ${a.url.replace(API_BASE, "")} [${a.label}]`).join("\n");
  console.log("\n=== SUMMARY ===\n" + summary);
}

main().catch((e) => {
  console.error("[inv-020] fatal", e);
  process.exit(1);
});
