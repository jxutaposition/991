/**
 * Investigation: Quick Wins
 *
 * Solves TODO-006 (formula re-evaluation), TODO-019 (row sorting).
 * Also probes: credit tracking, run history detail.
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-quick-wins.ts
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
  console.log("║  Investigation: Quick Wins                                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  let testTableId: string | null = null;

  try {
    // ── Experiment 1: Formula Auto-Evaluation ─────────────────────────
    console.log(">>> Experiment 1: Formula auto-evaluation (TODO-006)...");

    const createTable = await hit("1-create-table", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "INV-quick-wins-test"
    });
    const table = createTable.body?.table || createTable.body;
    testTableId = table?.id;
    if (!testTableId) { console.error("Failed to create table"); return; }

    await delay(500);
    const schema = await hit("1b-schema", "GET", `/v3/tables/${testTableId}`);
    const tableObj = schema.body?.table || schema.body;
    const viewId = (tableObj?.gridViews || tableObj?.views || [])[0]?.id;

    // Create text input column
    const textCol = await hit("1c-text-col", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Input Text",
      type: "text",
      typeSettings: { dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const textFieldId = textCol.body?.field?.id || textCol.body?.id;
    console.log(`  Text field: ${textFieldId}`);

    await delay(200);

    // Create a number column
    const numCol = await hit("1d-num-col", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Number Val",
      type: "text",
      typeSettings: { dataTypeSettings: { type: "number" } },
      activeViewId: viewId
    });
    const numFieldId = numCol.body?.field?.id || numCol.body?.id;
    console.log(`  Number field: ${numFieldId}`);

    await delay(200);

    // Create formula column: UPPER(Input Text)
    const formulaCol = await hit("1e-formula-col", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Upper Case",
      type: "formula",
      typeSettings: {
        formulaText: `UPPER({{${textFieldId}}})`,
        formulaType: "text",
        dataTypeSettings: { type: "text" }
      },
      activeViewId: viewId
    });
    const formulaFieldId = formulaCol.body?.field?.id || formulaCol.body?.id;
    console.log(`  Formula field: ${formulaFieldId}`);

    await delay(200);

    // Create a numeric formula: Number Val * 2
    const numFormulaCol = await hit("1f-num-formula", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Doubled",
      type: "formula",
      typeSettings: {
        formulaText: `{{${numFieldId}}} * 2`,
        formulaType: "number",
        dataTypeSettings: { type: "number" }
      },
      activeViewId: viewId
    });
    const numFormulaFieldId = numFormulaCol.body?.field?.id || numFormulaCol.body?.id;
    console.log(`  Numeric formula field: ${numFormulaFieldId}`);

    // Insert a row with data
    await delay(300);
    const seedRow = await hit("1g-seed-row", "POST", `/v3/tables/${testTableId}/records`, {
      records: [{ cells: { [textFieldId]: "hello world", [numFieldId]: "42" } }]
    });
    const rowId = seedRow.body?.records?.[0]?.id;
    console.log(`  Seeded row: ${rowId}`);

    // Wait a moment for formulas to evaluate
    await delay(2000);

    // Read the row back
    const readRow = await hit("1h-read-row", "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=10`);
    const rows = readRow.body?.results || [];
    for (const row of rows) {
      const inputVal = row.cells?.[textFieldId]?.value;
      const formulaVal = row.cells?.[formulaFieldId]?.value;
      const numVal = row.cells?.[numFieldId]?.value;
      const numFormulaVal = row.cells?.[numFormulaFieldId]?.value;
      console.log(`  Row ${row.id}:`);
      console.log(`    Input Text: "${inputVal}" → Upper Case formula: "${formulaVal}"`);
      console.log(`    Number Val: ${numVal} → Doubled formula: ${numFormulaVal}`);
      console.log(`    Formula auto-evaluated: ${formulaVal ? "YES" : "NO (null)"}`);

      // Dump full cell structure for formula columns
      console.log(`    Formula cell detail: ${JSON.stringify(row.cells?.[formulaFieldId])}`);
      console.log(`    Num formula cell detail: ${JSON.stringify(row.cells?.[numFormulaFieldId])}`);
    }

    // Test: update the input and check if formula re-evaluates
    console.log("\n  Testing formula re-evaluation after row update...");
    await hit("1i-update-row", "PATCH", `/v3/tables/${testTableId}/records`, {
      records: [{ id: rowId, cells: { [textFieldId]: "updated value", [numFieldId]: "100" } }]
    });

    // Wait for async update + potential formula recalc
    await delay(3000);

    const readAfterUpdate = await hit("1j-read-after-update", "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=10`);
    for (const row of readAfterUpdate.body?.results || []) {
      const inputVal = row.cells?.[textFieldId]?.value;
      const formulaVal = row.cells?.[formulaFieldId]?.value;
      const numVal = row.cells?.[numFieldId]?.value;
      const numFormulaVal = row.cells?.[numFormulaFieldId]?.value;
      console.log(`  After update:`);
      console.log(`    Input: "${inputVal}" → Formula: "${formulaVal}" (expect "UPDATED VALUE")`);
      console.log(`    Number: ${numVal} → Doubled: ${numFormulaVal} (expect 200)`);
      console.log(`    Re-evaluated: ${formulaVal === "UPDATED VALUE" ? "YES" : "NO"}`);
    }

    // Test: explicit formula trigger via PATCH /run
    if (formulaFieldId) {
      console.log("\n  Testing explicit formula trigger via PATCH /run...");
      const triggerResp = await hit("1k-formula-trigger", "PATCH", `/v3/tables/${testTableId}/run`, {
        runRecords: { recordIds: [rowId] },
        fieldIds: [formulaFieldId],
        forceRun: true
      });
      console.log(`  PATCH /run for formula field: ${triggerResp.status} — ${JSON.stringify(triggerResp.body)}`);
    }

    // ── Experiment 2: Row Sorting via Query Params ────────────────────
    console.log("\n>>> Experiment 2: Row sorting via query params (TODO-019)...");

    // Insert more rows for sorting test
    await delay(300);
    await hit("2a-more-rows", "POST", `/v3/tables/${testTableId}/records`, {
      records: [
        { cells: { [textFieldId]: "alpha", [numFieldId]: "3" } },
        { cells: { [textFieldId]: "charlie", [numFieldId]: "1" } },
        { cells: { [textFieldId]: "bravo", [numFieldId]: "2" } },
      ]
    });

    await delay(500);

    // Test sort query params
    const fields = (schema.body?.table || schema.body)?.fields || [];
    const createdAtId = fields.find((f: any) => f.name === "Created At")?.id || "f_created_at";

    const sortParams = [
      `sort=${textFieldId}&direction=ASC`,
      `sort=${textFieldId}&direction=DESC`,
      `sortBy=${textFieldId}&order=asc`,
      `orderBy=${textFieldId}&order=desc`,
      `sort=${createdAtId}&direction=DESC`,
      `sortField=${textFieldId}&sortDirection=asc`,
    ];

    // Read default order first
    const defaultOrder = await hit("2b-default-order", "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=10`);
    const defaultVals = (defaultOrder.body?.results || []).map((r: any) => r.cells?.[textFieldId]?.value);
    console.log(`  Default order: ${defaultVals.join(", ")}`);

    for (const param of sortParams) {
      await delay(100);
      const resp = await hit(`2c-sort-${param.split("&")[0].split("=")[0]}`, "GET",
        `/v3/tables/${testTableId}/views/${viewId}/records?limit=10&${param}`);
      const vals = (resp.body?.results || []).map((r: any) => r.cells?.[textFieldId]?.value);
      console.log(`  ?${param.split("=")[0]}: ${vals.join(", ")} (${resp.status})`);
    }

    // ── Experiment 3: Credit Tracking ────────────────────────────────
    console.log("\n>>> Experiment 3: Credit tracking endpoints...");

    const credits = await hit("3a-credits", "GET", `/v3/workspaces/${WORKSPACE}`);
    console.log(`  Current credits: ${JSON.stringify(credits.body?.credits)}`);
    console.log(`  Credit budgets: ${JSON.stringify(credits.body?.creditBudgets)}`);

    // Try credit-specific endpoints
    const creditEndpoints = [
      `/v3/workspaces/${WORKSPACE}/credits`,
      `/v3/workspaces/${WORKSPACE}/credit-usage`,
      `/v3/workspaces/${WORKSPACE}/billing`,
      `/v3/workspaces/${WORKSPACE}/usage`,
      `/v3/credits`,
      `/v3/billing`,
    ];

    for (const ep of creditEndpoints) {
      await delay(100);
      const resp = await hit(`3-${ep.split("/").pop()}`, "GET", ep);
      console.log(`  GET ${ep.replace(WORKSPACE, "{id}")}: ${resp.status}`);
      if (resp.status === 200) {
        console.log(`    Body: ${JSON.stringify(resp.body).substring(0, 300)}`);
      }
    }

    // ── Experiment 4: API Keys endpoint ──────────────────────────────
    console.log("\n>>> Experiment 4: API keys...");
    const apiKeys = await hit("4-api-keys", "GET", "/v3/api-keys");
    console.log(`  GET /v3/api-keys: ${apiKeys.status} — ${JSON.stringify(apiKeys.body).substring(0, 300)}`);

    // ── Experiment 5: Export mechanics ────────────────────────────────
    console.log("\n>>> Experiment 5: Export endpoints...");
    const exportEndpoints = [
      { method: "GET", path: `/v3/exports/csv?tableId=${testTableId}` },
      { method: "POST", path: "/v3/exports", body: { tableId: testTableId, format: "csv" } },
      { method: "POST", path: "/v3/exports/csv", body: { tableId: testTableId } },
      { method: "GET", path: `/v3/exports?tableId=${testTableId}` },
      { method: "GET", path: `/v3/exports/download?tableId=${testTableId}` },
      { method: "POST", path: `/v3/tables/${testTableId}/export`, body: { format: "csv" } },
      { method: "POST", path: `/v3/tables/${testTableId}/exports`, body: {} },
    ];

    for (const ep of exportEndpoints) {
      await delay(100);
      const resp = await hit(`5-export-${ep.path.split("/").pop()?.split("?")[0]}`, ep.method, ep.path, ep.body);
      console.log(`  ${ep.method} ${ep.path.replace(testTableId!, "{id}").substring(0, 60)}: ${resp.status} — ${JSON.stringify(resp.body).substring(0, 200)}`);
    }

  } finally {
    if (testTableId) {
      console.log(`\n>>> Cleanup: Deleting test table ${testTableId}...`);
      await delay(500);
      await hit("cleanup-delete", "DELETE", `/v3/tables/${testTableId}`);
    }

    const outputFile = path.join(__dirname, "..", "results", `investigate-quick-wins-${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${outputFile}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
