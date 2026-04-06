/**
 * Investigation: Table/Workbook Duplication
 *
 * Solves TODO-013 (table duplication) and TODO-015 (workbook CRUD).
 * Feature flag workbookDuplicationTableLimit: 10 proves duplication exists.
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-duplication.ts
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
  console.log("║  Investigation: Table/Workbook Duplication + Workbook CRUD      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ── Step 1: Create a source table with columns + rows ────────────
    console.log(">>> Step 1: Creating source table...");
    const createTable = await hit("1-create-table", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "INV-duplication-source"
    });
    const table = createTable.body?.table || createTable.body;
    const sourceTableId = table?.id;
    if (!sourceTableId) { console.error("Failed to create table"); return; }
    tablesToClean.push(sourceTableId);

    await delay(500);
    const schema = await hit("1b-schema", "GET", `/v3/tables/${sourceTableId}`);
    const tableObj = schema.body?.table || schema.body;
    const viewId = (tableObj?.gridViews || tableObj?.views || [])[0]?.id;
    const workbookId = tableObj?.workbookId || table?.workbookId;
    console.log(`  Table: ${sourceTableId}, View: ${viewId}, Workbook: ${workbookId}`);

    // Add a text column
    const textCol = await hit("1c-text-col", "POST", `/v3/tables/${sourceTableId}/fields`, {
      name: "Company",
      type: "text",
      typeSettings: { dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const textFieldId = textCol.body?.field?.id || textCol.body?.id;

    // Add a row
    await delay(200);
    await hit("1d-seed-row", "POST", `/v3/tables/${sourceTableId}/records`, {
      records: [{ cells: { [textFieldId]: "Acme Corp" } }]
    });

    // ── Step 2: Probe table duplication ──────────────────────────────
    console.log("\n>>> Step 2: Probing table duplication endpoints...");

    const dupEndpoints = [
      { probe: "2a", path: `/v3/tables/${sourceTableId}/duplicate`, body: { name: "Copy A" } },
      { probe: "2b", path: `/v3/tables/${sourceTableId}/clone`, body: { name: "Copy B" } },
      { probe: "2c", path: `/v3/tables/${sourceTableId}/copy`, body: { name: "Copy C" } },
      { probe: "2d", path: `/v3/tables/${sourceTableId}/duplicate`, body: {} },
      { probe: "2e", path: `/v3/tables/${sourceTableId}/duplicate`, body: { workspaceId: parseInt(WORKSPACE) } },
    ];

    for (const ep of dupEndpoints) {
      await delay(200);
      const resp = await hit(ep.probe, "POST", ep.path, ep.body);
      console.log(`  POST ${ep.path.replace(sourceTableId, "{id}")}: ${resp.status} — ${JSON.stringify(resp.body).substring(0, 300)}`);
      // Track any created tables for cleanup
      const newId = resp.body?.table?.id || resp.body?.id;
      if (newId && resp.status >= 200 && resp.status < 300) {
        tablesToClean.push(newId);
        console.log(`    CREATED! New table: ${newId}`);
      }
    }

    // Try creating a table with sourceTableId
    await delay(200);
    const createFromSource = await hit("2f-create-from-source", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "Copy via create",
      sourceTableId: sourceTableId
    });
    console.log(`  POST /v3/tables with sourceTableId: ${createFromSource.status} — ${JSON.stringify(createFromSource.body).substring(0, 300)}`);
    const newId1 = createFromSource.body?.table?.id || createFromSource.body?.id;
    if (newId1 && createFromSource.status >= 200 && createFromSource.status < 300) tablesToClean.push(newId1);

    await delay(200);
    const createFromDup = await hit("2g-create-dup", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "Copy via dup",
      duplicateFromTableId: sourceTableId
    });
    console.log(`  POST /v3/tables with duplicateFromTableId: ${createFromDup.status} — ${JSON.stringify(createFromDup.body).substring(0, 300)}`);
    const newId2 = createFromDup.body?.table?.id || createFromDup.body?.id;
    if (newId2 && createFromDup.status >= 200 && createFromDup.status < 300) tablesToClean.push(newId2);

    // ── Step 3: Probe workbook duplication ───────────────────────────
    console.log("\n>>> Step 3: Probing workbook duplication...");

    if (workbookId) {
      const wbDupEndpoints = [
        { probe: "3a", path: `/v3/workbooks/${workbookId}/duplicate`, body: { name: "WB Copy A" } },
        { probe: "3b", path: `/v3/workbooks/${workbookId}/clone`, body: { name: "WB Copy B" } },
        { probe: "3c", path: `/v3/workbooks/${workbookId}/copy`, body: {} },
        { probe: "3d", path: `/v3/workbooks/${workbookId}/duplicate`, body: { workspaceId: parseInt(WORKSPACE) } },
      ];

      for (const ep of wbDupEndpoints) {
        await delay(200);
        const resp = await hit(ep.probe, "POST", ep.path, ep.body);
        console.log(`  POST ${ep.path.replace(workbookId, "{wbId}")}: ${resp.status} — ${JSON.stringify(resp.body).substring(0, 300)}`);
      }
    } else {
      console.log("  No workbookId found, skipping workbook duplication probes");
    }

    // ── Step 4: Probe workbook CRUD ─────────────────────────────────
    console.log("\n>>> Step 4: Probing workbook CRUD...");

    // List workbooks
    const wbList = await hit("4a-list-workbooks", "GET", `/v3/workspaces/${WORKSPACE}/workbooks`);
    console.log(`  GET workbooks: ${wbList.status} — ${JSON.stringify(wbList.body).substring(0, 400)}`);
    const workbooks = wbList.body?.results || wbList.body || [];
    console.log(`  Found ${Array.isArray(workbooks) ? workbooks.length : 0} workbooks`);

    if (workbookId) {
      // GET single workbook
      await delay(200);
      const wbGet = await hit("4b-get-workbook", "GET", `/v3/workbooks/${workbookId}`);
      console.log(`  GET /v3/workbooks/{id}: ${wbGet.status} — ${JSON.stringify(wbGet.body).substring(0, 300)}`);

      // PATCH workbook (rename)
      await delay(200);
      const wbPatch = await hit("4c-patch-workbook", "PATCH", `/v3/workbooks/${workbookId}`, {
        name: "Renamed Workbook Test"
      });
      console.log(`  PATCH /v3/workbooks/{id}: ${wbPatch.status} — ${JSON.stringify(wbPatch.body).substring(0, 300)}`);

      // Rename back if successful
      if (wbPatch.status === 200) {
        await delay(200);
        await hit("4c2-patch-revert", "PATCH", `/v3/workbooks/${workbookId}`, {
          name: "INV-duplication-source"
        });
      }
    }

    // POST create workbook
    await delay(200);
    const wbCreate = await hit("4d-create-workbook", "POST", "/v3/workbooks", {
      workspaceId: parseInt(WORKSPACE),
      name: "INV-test-workbook"
    });
    console.log(`  POST /v3/workbooks: ${wbCreate.status} — ${JSON.stringify(wbCreate.body).substring(0, 300)}`);

    // ── Step 5: Probe table history/restore ──────────────────────────
    console.log("\n>>> Step 5: Probing table history/restore...");
    const historyEndpoints = [
      `/v3/tables/${sourceTableId}/history`,
      `/v3/tables/${sourceTableId}/versions`,
      `/v3/tables/${sourceTableId}/snapshots`,
      `/v3/tables/${sourceTableId}/restore`,
      `/v3/tables/${sourceTableId}/activity`,
      `/v3/tables/${sourceTableId}/runs`,
      `/v3/tables/${sourceTableId}/jobs`,
      `/v3/tables/${sourceTableId}/stats`,
    ];

    for (const ep of historyEndpoints) {
      await delay(100);
      const resp = await hit(`5-${ep.split("/").pop()}`, "GET", ep);
      console.log(`  GET ${ep.replace(sourceTableId, "{id}")}: ${resp.status} — ${JSON.stringify(resp.body).substring(0, 200)}`);
    }

  } finally {
    // Cleanup all created tables
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      await delay(300);
      const del = await hit(`cleanup-${tid}`, "DELETE", `/v3/tables/${tid}`);
      console.log(`  Delete ${tid}: ${del.status}`);
    }

    const outputFile = path.join(__dirname, "..", "results", `investigate-duplication-${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${outputFile}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
