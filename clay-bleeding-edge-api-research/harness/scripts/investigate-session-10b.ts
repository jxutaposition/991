/**
 * Session 10B: Route-Row Pipeline + Source PATCH + Field Update Probes
 *
 * ALL CREDIT-FREE — no enrichment triggers, no autoRun with action columns.
 *
 * TODO-038: Cross-table route-row pipeline (schema-only, no enrichment trigger)
 * TODO-025: tableSettings exploration
 * TODO-028: Source scheduling via typeSettings
 * + Source PATCH operations
 * + Field PATCH operations (rename, update typeSettings)
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-10b.ts
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE = process.env.CLAY_WORKSPACE || "1080480";

function loadCookie(): string {
  const f = path.join(__dirname, "..", "results", ".session-cookies.json");
  return "claysession=" + JSON.parse(fs.readFileSync(f, "utf-8")).find((c: any) => c.name === "claysession").value;
}
const COOKIE = loadCookie();
const results: any[] = [];

async function hit(probe: string, method: string, urlPath: string, body?: any): Promise<any> {
  const url = `${API_BASE}${urlPath}`;
  const opts: RequestInit = { method, headers: { Cookie: COOKIE, Accept: "application/json", "Content-Type": "application/json" } };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const start = Date.now();
  try {
    const resp = await fetch(url, opts);
    const b = await resp.json().catch(() => resp.text());
    const r = { probe, method, url: urlPath, status: resp.status, latencyMs: Date.now() - start, body: b };
    results.push(r);
    return r;
  } catch (err: any) {
    const r = { probe, method, url: urlPath, status: 0, body: null, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const mark = (s: number) => s === 200 || s === 201 ? "✅" : s === 400 ? "⚠️" : s === 404 ? "❌" : `[${s}]`;

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 10B: Route-Row, Source PATCH, Field PATCH             ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // EXP 1: Cross-Table Route-Row Pipeline (TODO-038) — SCHEMA ONLY
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> EXP 1: Cross-Table Route-Row Pipeline\n");

    // Create Table A (source)
    const tA = await hit("1a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-routerow-A"
    });
    const tableAId = tA.body?.table?.id;
    tablesToClean.push(tableAId);
    await delay(500);

    let schemaA = await hit("1b", "GET", `/v3/tables/${tableAId}`);
    const viewA = ((schemaA.body?.table || schemaA.body)?.gridViews || [])[0]?.id;

    // Create columns on A
    const colName = await hit("1c", "POST", `/v3/tables/${tableAId}/fields`, {
      name: "Company", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: viewA
    });
    const nameFid = colName.body?.field?.id;

    await delay(100);
    const colUrl = await hit("1d", "POST", `/v3/tables/${tableAId}/fields`, {
      name: "Website", type: "text", typeSettings: { dataTypeSettings: { type: "url" } }, activeViewId: viewA
    });
    const urlFid = colUrl.body?.field?.id;

    // Create Table B (target)
    await delay(200);
    const tB = await hit("1e", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-routerow-B"
    });
    const tableBId = tB.body?.table?.id;
    tablesToClean.push(tableBId);

    console.log(`  Table A: ${tableAId} (fields: name=${nameFid}, url=${urlFid})`);
    console.log(`  Table B: ${tableBId}`);

    // Create route-row on Table A → Table B
    await delay(300);
    const routeRow = await hit("1f", "POST", `/v3/tables/${tableAId}/fields`, {
      name: "Send to B", type: "action",
      typeSettings: {
        actionKey: "route-row",
        inputsBinding: [
          { name: "tableId", formulaText: `"${tableBId}"` },
          { name: "rowData", formulaMap: {
            "Company Name": `{{${nameFid}}}`,
            "Website URL": `{{${urlFid}}}`
          }}
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewA
    });
    const routeRowFid = routeRow.body?.field?.id;
    console.log(`  Route-row field: ${routeRowFid} (${routeRow.status})`);
    if (routeRow.status !== 200) {
      console.log(`    Error: ${JSON.stringify(routeRow.body).substring(0, 400)}`);
    }

    // Read Table B schema — did route-row auto-create source + columns?
    await delay(1000);
    const schemaB = await hit("1g", "GET", `/v3/tables/${tableBId}`);
    const tblB = schemaB.body?.table || schemaB.body;
    const fieldsB = tblB?.fields || [];
    const viewsB = tblB?.gridViews || tblB?.views || [];
    console.log(`\n  Table B after route-row creation:`);
    console.log(`    Fields (${fieldsB.length}):`);
    for (const f of fieldsB) {
      console.log(`      ${f.name} (${f.type}): ${JSON.stringify(f.typeSettings).substring(0, 150)}`);
    }
    console.log(`    Sources: ${JSON.stringify(tblB?.sources || "none").substring(0, 200)}`);

    // Insert rows into Table A
    await delay(200);
    const rowsA = await hit("1h", "POST", `/v3/tables/${tableAId}/records`, {
      records: [
        { cells: { [nameFid]: "Anthropic", [urlFid]: "https://anthropic.com" } },
        { cells: { [nameFid]: "Stripe", [urlFid]: "https://stripe.com" } },
      ]
    });
    const recordAIds = (rowsA.body?.records || []).map((r: any) => r.id);
    console.log(`\n  Inserted ${recordAIds.length} rows in Table A`);

    // Trigger route-row (this is an action trigger but route-row itself is FREE — it just moves data)
    if (routeRowFid && recordAIds.length > 0) {
      await delay(500);
      const trigger = await hit("1i", "PATCH", `/v3/tables/${tableAId}/run`, {
        runRecords: { recordIds: recordAIds },
        fieldIds: [routeRowFid],
        forceRun: true
      });
      console.log(`  Route-row trigger: ${JSON.stringify(trigger.body)}`);

      // Wait and check Table B
      console.log("  Waiting 5s for route-row delivery...");
      await delay(5000);
      const viewB = viewsB.find((v: any) => v.name === "All rows")?.id || viewsB[0]?.id;
      if (viewB) {
        const rowsB = await hit("1j", "GET", `/v3/tables/${tableBId}/views/${viewB}/records?limit=100`);
        const bRecords = rowsB.body?.results || [];
        console.log(`  Table B rows: ${bRecords.length}`);
        for (const r of bRecords) {
          console.log(`    ${r.id}: ${JSON.stringify(r.cells).substring(0, 200)}`);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 2: Field PATCH Operations (confirmed untested in registry)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 2: Field PATCH Operations\n");

    // Rename a field
    const rename = await hit("2a", "PATCH", `/v3/tables/${tableAId}/fields/${nameFid}`, {
      name: "Company Name (renamed)"
    });
    console.log(`  ${mark(rename.status)} Rename field: ${rename.body?.name || rename.body?.field?.name || JSON.stringify(rename.body).substring(0, 150)}`);

    // Update formula text on a formula field
    await delay(100);
    const formulaCol = await hit("2b", "POST", `/v3/tables/${tableAId}/fields`, {
      name: "Test Formula", type: "formula",
      typeSettings: { formulaText: `{{${nameFid}}}`, formulaType: "text", dataTypeSettings: { type: "text" } },
      activeViewId: viewA
    });
    const formulaFid = formulaCol.body?.field?.id;

    if (formulaFid) {
      await delay(100);
      const updateFormula = await hit("2c", "PATCH", `/v3/tables/${tableAId}/fields/${formulaFid}`, {
        typeSettings: { formulaText: `UPPER({{${nameFid}}})`, formulaType: "text", dataTypeSettings: { type: "text" } }
      });
      console.log(`  ${mark(updateFormula.status)} Update formula: ${updateFormula.body?.typeSettings?.formulaText || JSON.stringify(updateFormula.body).substring(0, 150)}`);

      // Can you change field type? (text → formula, etc.)
      await delay(100);
      const changeType = await hit("2d", "PATCH", `/v3/tables/${tableAId}/fields/${urlFid}`, {
        type: "formula",
        typeSettings: { formulaText: `"https://" + {{${nameFid}}}`, formulaType: "text" }
      });
      console.log(`  ${mark(changeType.status)} Change field type (text→formula): ${JSON.stringify(changeType.body).substring(0, 200)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 3: Source PATCH & Scheduling (TODO-028)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 3: Source PATCH & Scheduling\n");

    // Create a manual source
    const src = await hit("3a", "POST", "/v3/sources", {
      workspaceId: parseInt(WORKSPACE), tableId: tableAId, name: "Test Source", type: "manual", typeSettings: {}
    });
    const srcId = src.body?.id;
    console.log(`  Source: ${srcId} (${src.status})`);

    if (srcId) {
      // Read source full detail
      await delay(200);
      const srcDetail = await hit("3b", "GET", `/v3/sources/${srcId}`);
      console.log(`  Source detail: ${JSON.stringify(srcDetail.body).substring(0, 400)}`);

      // PATCH source name
      await delay(100);
      const srcRename = await hit("3c", "PATCH", `/v3/sources/${srcId}`, { name: "Renamed Source" });
      console.log(`  ${mark(srcRename.status)} Rename: ${srcRename.body?.name}`);

      // PATCH source typeSettings with schedule-like keys
      await delay(100);
      const srcSched = await hit("3d", "PATCH", `/v3/sources/${srcId}`, {
        typeSettings: { schedule: { enabled: true, interval: "daily" } }
      });
      console.log(`  ${mark(srcSched.status)} Schedule typeSettings: ${JSON.stringify(srcSched.body?.typeSettings).substring(0, 200)}`);

      // Read back to see what stuck
      await delay(200);
      const srcAfter = await hit("3e", "GET", `/v3/sources/${srcId}`);
      console.log(`  After PATCH typeSettings: ${JSON.stringify(srcAfter.body?.typeSettings).substring(0, 200)}`);

      // Delete source
      await delay(100);
      const srcDel = await hit("3f", "DELETE", `/v3/sources/${srcId}`);
      console.log(`  ${mark(srcDel.status)} Delete source`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 4: Full tableSettings Exploration (TODO-025)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 4: tableSettings Exhaustive Exploration\n");

    // Set many different keys and check what the system adds/transforms
    const settingsTests = [
      { autoRun: false },
      { dedupeFieldId: nameFid, dedupeEnabled: true },
      { enabledEnrichmentFieldIds: [nameFid] },
      { maxRowsPerRun: 100 },
      { batchSize: 50 },
      { retryOnError: true },
      { notifyOnComplete: true },
      { maxConcurrentRuns: 5 },
    ];

    for (const s of settingsTests) {
      await delay(100);
      const r = await hit("4", "PATCH", `/v3/tables/${tableAId}`, { tableSettings: s });
      const ts = (r.body?.table || r.body)?.tableSettings;
      console.log(`  ${mark(r.status)} ${JSON.stringify(s)}: accepted=${r.status === 200}, result keys=${Object.keys(ts || {}).join(",")}`);
    }

    // Read final state
    await delay(200);
    const finalSchema = await hit("4-final", "GET", `/v3/tables/${tableAId}`);
    const finalSettings = (finalSchema.body?.table || finalSchema.body)?.tableSettings;
    console.log(`\n  Final tableSettings: ${JSON.stringify(finalSettings, null, 2)}`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 5: Workspace Workbooks — Deeper Inspection
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 5: Workbook Deep Inspection\n");

    const wbs = await hit("5a", "GET", `/v3/workspaces/${WORKSPACE}/workbooks`);
    const wbList = wbs.body || [];
    console.log(`  ${Array.isArray(wbList) ? wbList.length : 0} workbooks`);

    if (Array.isArray(wbList) && wbList[0]) {
      // Dump first workbook fully
      console.log(`  First workbook FULL: ${JSON.stringify(wbList[0], null, 2)}`);

      // Check if workbooks have tables listed
      for (const wb of wbList.slice(0, 3)) {
        await delay(50);
        const wbTables = await hit("5b", "GET", `/v3/workbooks/${wb.id}/tables`);
        console.log(`  ${mark(wbTables.status)} GET /v3/workbooks/${wb.id}/tables: ${JSON.stringify(wbTables.body).substring(0, 150)}`);
      }
    }

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-10b-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
