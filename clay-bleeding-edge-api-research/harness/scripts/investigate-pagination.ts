/**
 * Investigation: Pagination
 *
 * Solves TODO-009 (row pagination), TODO-012 (row count).
 *
 * Approach:
 *   1. Create a test table, bulk-insert 150+ rows
 *   2. Test large limit values (100, 500, 1000, 10000, no-limit)
 *   3. Test cursor-based params (?cursor, ?after, ?startAfter, etc.)
 *   4. Test page-based params (?page, ?pageNumber, ?skip)
 *   5. Check table schema for row count fields
 *   6. Clean up
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-pagination.ts
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE = process.env.CLAY_WORKSPACE || "1080480";

function loadCookie(): string {
  const cookieFile = path.join(__dirname, "..", "results", ".session-cookies.json");
  if (fs.existsSync(cookieFile)) {
    const cookies = JSON.parse(fs.readFileSync(cookieFile, "utf-8"));
    const clay = cookies.find((c: any) => c.name === "claysession");
    if (clay) return `claysession=${clay.value}`;
  }
  const env = process.env.CLAY_SESSION;
  if (env) return env.startsWith("claysession=") ? env : `claysession=${env}`;
  console.error("ERROR: No cookie found.");
  process.exit(1);
}

const COOKIE = loadCookie();

interface ProbeResult {
  probe: string;
  method: string;
  url: string;
  status: number;
  latencyMs: number;
  body: any;
  headers: Record<string, string>;
  error?: string;
}

const results: ProbeResult[] = [];

async function hit(probe: string, method: string, urlPath: string, body?: any): Promise<ProbeResult> {
  const url = `${API_BASE}${urlPath}`;
  const start = Date.now();
  const headers: Record<string, string> = { Cookie: COOKIE, Accept: "application/json", "Content-Type": "application/json" };
  const options: RequestInit = { method, headers };
  if (body && method !== "GET") options.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, options);
    const ms = Date.now() - start;
    let b: any; try { b = await resp.json(); } catch { b = await resp.text(); }
    const h: Record<string, string> = {};
    resp.headers.forEach((v, k) => { h[k] = v; });
    const r: ProbeResult = { probe, method, url, status: resp.status, latencyMs: ms, body: b, headers: h };
    results.push(r);
    return r;
  } catch (err: any) {
    const r: ProbeResult = { probe, method, url, status: 0, latencyMs: Date.now() - start, body: null, headers: {}, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Investigation: Pagination                                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  let testTableId: string | null = null;

  try {
    // ── Step 1: Create test table ──────────────────────────────────────
    console.log(">>> Step 1: Creating test table...");
    const createTable = await hit("1-create-table", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "INV-pagination-test"
    });
    const table = createTable.body?.table || createTable.body;
    testTableId = table?.id;
    if (!testTableId) { console.error("Failed to create table"); return; }

    await delay(500);
    const schema = await hit("1b-schema", "GET", `/v3/tables/${testTableId}`);
    const fields = schema.body?.fields || schema.body?.table?.fields || [];
    const views = schema.body?.gridViews || schema.body?.views || schema.body?.table?.gridViews || schema.body?.table?.views || [];
    const viewId = views[0]?.id;
    console.log(`  Table: ${testTableId}, View: ${viewId}`);

    // Create a text column to hold data
    const textCol = await hit("1c-text-col", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Item",
      type: "text",
      typeSettings: { dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const textFieldId = textCol.body?.field?.id || textCol.body?.id;
    console.log(`  Text field: ${textFieldId}`);

    // ── Step 2: Bulk insert 160 rows ──────────────────────────────────
    console.log("\n>>> Step 2: Inserting 160 rows...");
    const TOTAL_ROWS = 160;
    const BATCH_SIZE = 40; // insert in batches

    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const records = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const n = batch * BATCH_SIZE + i + 1;
        records.push({ cells: { [textFieldId]: `Row-${String(n).padStart(3, "0")}` } });
      }
      const resp = await hit(`2-insert-batch-${batch}`, "POST", `/v3/tables/${testTableId}/records`, { records });
      console.log(`  Batch ${batch + 1}: inserted ${resp.body?.records?.length || 0} rows (status ${resp.status})`);
      await delay(200);
    }

    await delay(1000);

    // ── Step 3: Check table schema for row count ──────────────────────
    console.log("\n>>> Step 3: Checking table schema for row count...");
    const schemaAfter = await hit("3-schema-after", "GET", `/v3/tables/${testTableId}`);
    const tableObj = schemaAfter.body?.table || schemaAfter.body;
    // Look for anything count-related
    const countKeys = Object.keys(tableObj || {}).filter(k =>
      k.toLowerCase().includes("count") || k.toLowerCase().includes("num") ||
      k.toLowerCase().includes("size") || k.toLowerCase().includes("total") ||
      k.toLowerCase().includes("record")
    );
    console.log(`  Count-related keys in table schema: ${countKeys.length > 0 ? countKeys.join(", ") : "NONE"}`);
    if (countKeys.length > 0) {
      for (const k of countKeys) console.log(`    ${k}: ${JSON.stringify(tableObj[k])}`);
    }

    // Check views for count info
    const viewsAfter = tableObj?.gridViews || tableObj?.views || [];
    for (const v of viewsAfter.slice(0, 2)) {
      const vCountKeys = Object.keys(v || {}).filter((k: string) =>
        k.toLowerCase().includes("count") || k.toLowerCase().includes("num") || k.toLowerCase().includes("total")
      );
      console.log(`  View ${v.id} count keys: ${vCountKeys.length > 0 ? vCountKeys.join(", ") : "NONE"}`);
    }

    // ── Step 4: Test limit values ─────────────────────────────────────
    console.log("\n>>> Step 4: Testing limit values...");
    const limitTests = [10, 50, 100, 150, 200, 500, 1000, 10000];

    for (const limit of limitTests) {
      await delay(100);
      const resp = await hit(`4-limit-${limit}`, "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=${limit}`);
      const rows = resp.body?.results || [];
      const firstId = rows[0]?.id;
      const lastId = rows[rows.length - 1]?.id;
      const firstVal = rows[0]?.cells?.[textFieldId]?.value;
      const lastVal = rows[rows.length - 1]?.cells?.[textFieldId]?.value;
      console.log(`  limit=${limit}: returned ${rows.length} rows [${firstVal}...${lastVal}] (${resp.latencyMs}ms)`);

      // Check for pagination metadata in response
      const respKeys = Object.keys(resp.body || {});
      const metaKeys = respKeys.filter(k => k !== "results");
      if (metaKeys.length > 0) {
        console.log(`    Extra response keys: ${metaKeys.join(", ")} = ${metaKeys.map(k => JSON.stringify(resp.body[k])).join(", ")}`);
      }
    }

    // Test with no limit
    await delay(100);
    const noLimit = await hit("4-no-limit", "GET", `/v3/tables/${testTableId}/views/${viewId}/records`);
    const noLimitRows = noLimit.body?.results || [];
    console.log(`  no limit: returned ${noLimitRows.length} rows (${noLimit.latencyMs}ms)`);

    // ── Step 5: Test cursor-based pagination ──────────────────────────
    console.log("\n>>> Step 5: Testing cursor-based pagination...");

    // Get first page to get a cursor record ID
    const page1 = await hit("5-page1", "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=50`);
    const page1Rows = page1.body?.results || [];
    const lastRecordId = page1Rows[page1Rows.length - 1]?.id;
    const lastRecordVal = page1Rows[page1Rows.length - 1]?.cells?.[textFieldId]?.value;
    console.log(`  Page 1: ${page1Rows.length} rows, last = ${lastRecordId} (${lastRecordVal})`);

    if (lastRecordId) {
      const cursorParams = [
        `cursor=${lastRecordId}`,
        `after=${lastRecordId}`,
        `startAfter=${lastRecordId}`,
        `lastRecordId=${lastRecordId}`,
        `fromRecordId=${lastRecordId}`,
        `startingAfter=${lastRecordId}`,
      ];

      for (const param of cursorParams) {
        await delay(100);
        const resp = await hit(`5-cursor-${param.split("=")[0]}`, "GET",
          `/v3/tables/${testTableId}/views/${viewId}/records?limit=50&${param}`);
        const rows = resp.body?.results || [];
        const firstVal = rows[0]?.cells?.[textFieldId]?.value;
        const lastVal = rows[rows.length - 1]?.cells?.[textFieldId]?.value;
        console.log(`  ?${param.split("=")[0]}: ${rows.length} rows [${firstVal}...${lastVal}] (${resp.status})`);

        // Check if these overlap with page 1 or continue after
        if (rows.length > 0) {
          const firstRowInPage1 = page1Rows.find((r: any) => r.id === rows[0].id);
          console.log(`    Overlaps with page 1: ${firstRowInPage1 ? "YES (same start)" : "NO (different start)"}`);
        }
      }
    }

    // ── Step 6: Test page-based pagination ────────────────────────────
    console.log("\n>>> Step 6: Testing page-based pagination...");
    const pageParams = ["page=2", "pageNumber=2", "skip=50", "start=50", "from=50"];

    for (const param of pageParams) {
      await delay(100);
      const resp = await hit(`6-page-${param.split("=")[0]}`, "GET",
        `/v3/tables/${testTableId}/views/${viewId}/records?limit=50&${param}`);
      const rows = resp.body?.results || [];
      const firstVal = rows[0]?.cells?.[textFieldId]?.value;
      console.log(`  ?${param}: ${rows.length} rows, first = ${firstVal} (${resp.status})`);
    }

    // Re-test offset explicitly
    await delay(100);
    const offsetTest = await hit("6-offset-retest", "GET",
      `/v3/tables/${testTableId}/views/${viewId}/records?limit=50&offset=50`);
    const offsetRows = offsetTest.body?.results || [];
    const offsetFirst = offsetRows[0]?.cells?.[textFieldId]?.value;
    console.log(`  ?offset=50: ${offsetRows.length} rows, first = ${offsetFirst} (confirming offset ignored)`);

    // ── Step 7: POST-based query ──────────────────────────────────────
    console.log("\n>>> Step 7: Testing POST-based record query...");
    const postQuery = await hit("7-post-query", "POST",
      `/v3/tables/${testTableId}/views/${viewId}/records`,
      { limit: 50, cursor: lastRecordId }
    );
    console.log(`  POST records: status ${postQuery.status}, body: ${JSON.stringify(postQuery.body).substring(0, 200)}`);

    // ── Summary ───────────────────────────────────────────────────────
    console.log("\n\n>>> SUMMARY:");
    console.log(`  Total rows inserted: ${TOTAL_ROWS}`);
    console.log(`  Max rows returnable in single call: check limit tests above`);

  } finally {
    if (testTableId) {
      console.log(`\n>>> Cleanup: Deleting test table ${testTableId}...`);
      await delay(500);
      const del = await hit("cleanup-delete", "DELETE", `/v3/tables/${testTableId}`);
      console.log(`  Delete status: ${del.status}`);
    }

    const outputFile = path.join(__dirname, "..", "results", `investigate-pagination-${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${outputFile}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
