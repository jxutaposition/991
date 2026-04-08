/**
 * INV-021 verification: confirm POST /v3/imports/{workspaceId}/multi-part-upload
 * exists and returns presigned upload parts. Also exercises the full sequence
 * end-to-end with a tiny in-memory CSV (~50 bytes) so we capture real response shapes.
 *
 * Cleans up the scratch table at the end.
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
  const headers: Record<string, string> = { Cookie: cookieHeader, Accept: "application/json", ...extraHeaders };
  let finalBody: any;
  if (body && method !== "GET") {
    if (!extraHeaders["Content-Type"]) headers["Content-Type"] = "application/json";
    finalBody = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  }
  const r = await fetch(url, { method, headers, body: finalBody });
  let parsed: any = null;
  const text = await r.text().catch(() => "");
  try { parsed = JSON.parse(text); } catch { parsed = text.substring(0, 500); }
  const result = { label, method, url, status: r.status, response: parsed };
  console.log(`[${label}] ${method} ${url} → ${r.status}`);
  return result;
}

async function main() {
  const cookie = loadCookies();
  const out: any[] = [];

  // Probe 1: bare route check (no body) — expect 400, not 404
  const probe = await call("POST", `${API_BASE}/v3/imports/${WORKSPACE_ID}/multi-part-upload`, {}, cookie, "probe-empty");
  out.push(probe);

  // Probe 2: real init request with toS3CSVImportBucket=true
  const init = await call("POST", `${API_BASE}/v3/imports/${WORKSPACE_ID}/multi-part-upload`, {
    filename: "inv021-test.csv",
    fileSize: 64,
    toS3CSVImportBucket: true,
  }, cookie, "init");
  out.push(init);
  console.log("init response keys:", Object.keys(init.response || {}));

  // If we got upload URLs, do a one-part S3 PUT and then complete the multipart upload
  const uploadId = init.response?.uploadId;
  const s3Key = init.response?.s3Key;
  const uploadParts = init.response?.uploadUrls || init.response?.uploadParts;
  if (uploadId && s3Key && Array.isArray(uploadParts) && uploadParts.length > 0) {
    console.log(`got uploadId=${uploadId} s3Key=${s3Key} parts=${uploadParts.length}`);
    const csv = "Name,Email\nAlice,alice@example.com\nBob,bob@example.com\n";
    const buf = Buffer.from(csv, "utf-8");

    // PUT to first part URL
    const partUrl = uploadParts[0].url;
    console.log("PUT first part url host:", new URL(partUrl).host);
    const putRes = await fetch(partUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
    const etag = putRes.headers.get("etag");
    console.log("S3 PUT →", putRes.status, "etag=", etag);
    out.push({ label: "s3-put", url: new URL(partUrl).host + new URL(partUrl).pathname.substring(0, 60), status: putRes.status, etag });

    if (putRes.status === 200 && etag) {
      // Complete
      const complete = await call("POST", `${API_BASE}/v3/imports/${WORKSPACE_ID}/multi-part-upload/complete`, {
        s3key: s3Key,
        uploadId,
        etags: [{ partNumber: 1, etag: etag.replace(/"/g, "") }],
        toS3CSVImportBucket: true,
      }, cookie, "complete");
      out.push(complete);

      // Now create the import job pointing at this freshly uploaded key
      const tbl = await call("POST", `${API_BASE}/v3/tables`, { workspaceId: WORKSPACE_ID, type: "spreadsheet", name: "INV-021 multipart test" }, cookie, "create-table");
      out.push(tbl);
      const tableId = tbl.response?.id || tbl.response?.table?.id;

      const f1 = await call("POST", `${API_BASE}/v3/tables/${tableId}/fields`, { name: "Name", typeSettings: { dataTypeSettings: { type: "text" } } }, cookie, "field-name");
      out.push(f1);
      const f2 = await call("POST", `${API_BASE}/v3/tables/${tableId}/fields`, { name: "Email", typeSettings: { dataTypeSettings: { type: "text" } } }, cookie, "field-email");
      out.push(f2);
      const nameFid = f1.response?.id || f1.response?.field?.id;
      const emailFid = f2.response?.id || f2.response?.field?.id;

      const create = await call("POST", `${API_BASE}/v3/imports`, {
        workspaceId: WORKSPACE_ID,
        config: {
          map: { [nameFid]: '{{"Name"}}', [emailFid]: '{{"Email"}}' },
          source: {
            key: s3Key,
            type: "S3_CSV",
            filename: "inv021-test.csv",
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

      // Cleanup
      if (tableId) {
        const del = await call("DELETE", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "cleanup");
        out.push(del);
      }
    }
  }

  // Also probe the alternate (no toS3CSVImportBucket) for completeness
  const init2 = await call("POST", `${API_BASE}/v3/imports/${WORKSPACE_ID}/multi-part-upload`, {
    filename: "inv021-doc.pdf",
    fileSize: 1024,
    toS3CSVImportBucket: false,
  }, cookie, "init-noflag");
  out.push(init2);

  const f = path.join(RESULTS_DIR, `inv-021-verify-multipart-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log("saved", f);
}

main().catch(e => { console.error(e); process.exit(1); });
