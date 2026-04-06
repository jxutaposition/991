/**
 * Session 9: Deep Investigation — Field Lifecycle & Enrichment Results
 *
 * TODO-039: Field lock settings
 * TODO-040: Fix broken formulas via PATCH
 * TODO-042: Field dependency deletion behavior
 * TODO-043: Enrichment result deep structure
 * TODO-029: Dedup behavior (source-fed rows vs direct insert)
 * TODO-033: Enrichment retry (forceRun false on succeeded cells)
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-9-deep.ts
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE = process.env.CLAY_WORKSPACE || "1080480";

function loadCookie(): string {
  const f = path.join(__dirname, "..", "results", ".session-cookies.json");
  const cookies = JSON.parse(fs.readFileSync(f, "utf-8"));
  return "claysession=" + cookies.find((c: any) => c.name === "claysession").value;
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
    const r = { probe, method, url: urlPath, status: 0, body: null, latencyMs: Date.now() - start, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 9: Field Lifecycle & Enrichment Results               ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // Create main test table
    const t = await hit("init", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-session-9-deep"
    });
    const tableId = t.body?.table?.id;
    tablesToClean.push(tableId);
    await delay(500);

    let s = await hit("init-s", "GET", `/v3/tables/${tableId}`);
    const tbl = s.body?.table || s.body;
    const viewId = (tbl?.gridViews || tbl?.views || []).find((v: any) => v.name === "All rows")?.id || (tbl?.gridViews || tbl?.views || [])[0]?.id;

    // Create columns
    const col1 = await hit("init-c1", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Name", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: viewId
    });
    const nameFid = col1.body?.field?.id;

    await delay(100);
    const col2 = await hit("init-c2", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Score", type: "text", typeSettings: { dataTypeSettings: { type: "number" } }, activeViewId: viewId
    });
    const scoreFid = col2.body?.field?.id;

    await delay(100);
    const col3 = await hit("init-c3", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Upper", type: "formula",
      typeSettings: { formulaText: `UPPER({{${nameFid}}})`, formulaType: "text", dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const upperFid = col3.body?.field?.id;

    await delay(100);
    const col4 = await hit("init-c4", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Enriched", type: "action",
      typeSettings: {
        actionKey: "normalize-company-name",
        actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
        inputsBinding: [{ name: "companyName", formulaText: `{{${nameFid}}}` }],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    const enrichFid = col4.body?.field?.id;

    // Enable autoRun
    await hit("init-ar", "PATCH", `/v3/tables/${tableId}`, { tableSettings: { autoRun: true } });

    console.log(`Table: ${tableId}, View: ${viewId}`);
    console.log(`Fields: name=${nameFid}, score=${scoreFid}, upper=${upperFid}, enrich=${enrichFid}\n`);

    // Insert test rows
    await delay(200);
    const rows = await hit("init-rows", "POST", `/v3/tables/${tableId}/records`, {
      records: [
        { cells: { [nameFid]: "Anthropic", [scoreFid]: "95" } },
        { cells: { [nameFid]: "Stripe", [scoreFid]: "80" } },
      ]
    });
    const rowIds = (rows.body?.records || []).map((r: any) => r.id);
    console.log(`Rows: ${rowIds.join(", ")}`);

    // Wait for autoRun enrichments
    console.log("Waiting 6s for autoRun enrichments...\n");
    await delay(6000);

    // ══════════════════════════════════════════════════════════════════
    // EXP 1: Enrichment Result Deep Structure (TODO-043)
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> EXP 1: Enrichment Result Deep Structure\n");

    // Read via view
    const viewRows = await hit("1a", "GET", `/v3/tables/${tableId}/views/${viewId}/records?limit=10`);
    for (const r of (viewRows.body?.results || [])) {
      const enrichCell = r.cells?.[enrichFid];
      console.log(`  Row ${r.id}:`);
      console.log(`    name: ${r.cells?.[nameFid]?.value}`);
      console.log(`    upper: ${r.cells?.[upperFid]?.value}`);
      console.log(`    enrich FULL value: ${JSON.stringify(enrichCell?.value)}`);
      console.log(`    enrich metadata: ${JSON.stringify(enrichCell?.metadata)}`);
      console.log(`    recordMetadata: ${JSON.stringify(r.recordMetadata)}`);
    }

    // Read single record for potentially richer data
    if (rowIds[0]) {
      const single = await hit("1b", "GET", `/v3/tables/${tableId}/records/${rowIds[0]}`);
      const enrichCell = single.body?.cells?.[enrichFid];
      console.log(`\n  Single record enrichment FULL:`);
      console.log(`    value: ${JSON.stringify(enrichCell?.value, null, 2)}`);
      console.log(`    metadata: ${JSON.stringify(enrichCell?.metadata, null, 2)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 2: forceRun=false on Already-Succeeded Cells (TODO-033)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 2: forceRun Semantics on Succeeded Cells\n");

    // Count run history entries BEFORE
    const before = await hit("2a", "GET", `/v3/tables/${tableId}/views/${viewId}/records?limit=10`);
    const beforeHist = (before.body?.results || [])[0]?.recordMetadata?.runHistory?.[enrichFid];
    console.log(`  Run history entries BEFORE: ${beforeHist?.length || 0}`);

    // forceRun=false
    const noForce = await hit("2b", "PATCH", `/v3/tables/${tableId}/run`, {
      runRecords: { recordIds: [rowIds[0]] }, fieldIds: [enrichFid], forceRun: false
    });
    console.log(`  forceRun=false response: ${JSON.stringify(noForce.body)}`);

    await delay(3000);
    const afterNoForce = await hit("2c", "GET", `/v3/tables/${tableId}/views/${viewId}/records?limit=10`);
    const afterNoForceHist = (afterNoForce.body?.results || [])[0]?.recordMetadata?.runHistory?.[enrichFid];
    console.log(`  Run history entries AFTER forceRun=false: ${afterNoForceHist?.length || 0} (expect same = skipped)`);

    // forceRun=true
    const withForce = await hit("2d", "PATCH", `/v3/tables/${tableId}/run`, {
      runRecords: { recordIds: [rowIds[0]] }, fieldIds: [enrichFid], forceRun: true
    });
    console.log(`  forceRun=true response: ${JSON.stringify(withForce.body)}`);

    await delay(3000);
    const afterForce = await hit("2e", "GET", `/v3/tables/${tableId}/views/${viewId}/records?limit=10`);
    const afterForceHist = (afterForce.body?.results || [])[0]?.recordMetadata?.runHistory?.[enrichFid];
    console.log(`  Run history entries AFTER forceRun=true: ${afterForceHist?.length || 0} (expect +1 = re-ran)`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 3: Formula Fixing (TODO-040) + Field Dependency Deletion (TODO-042)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 3: Formula Error & Fix Lifecycle\n");

    // Create formula with invalid ref
    const badFormula = await hit("3a", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Broken Formula", type: "formula",
      typeSettings: { formulaText: "UPPER({{f_NONEXISTENT}})", formulaType: "text", dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const badFid = badFormula.body?.field?.id;
    console.log(`  Created broken formula: ${badFid}`);
    console.log(`  settingsError: ${JSON.stringify(badFormula.body?.field?.settingsError)}`);
    console.log(`  inputFieldIds: ${JSON.stringify(badFormula.body?.field?.inputFieldIds)}`);

    // Try to FIX it by PATCHing with valid ref
    await delay(200);
    const fixFormula = await hit("3b", "PATCH", `/v3/tables/${tableId}/fields/${badFid}`, {
      typeSettings: { formulaText: `UPPER({{${nameFid}}})`, formulaType: "text", dataTypeSettings: { type: "text" } }
    });
    console.log(`  PATCH to fix: ${fixFormula.status}`);
    console.log(`  After fix settingsError: ${JSON.stringify(fixFormula.body?.settingsError || fixFormula.body?.field?.settingsError)}`);

    // Read back to confirm
    await delay(200);
    s = await hit("3c", "GET", `/v3/tables/${tableId}`);
    const fixedField = ((s.body?.table || s.body)?.fields || []).find((f: any) => f.id === badFid);
    console.log(`  Fixed field settingsError: ${JSON.stringify(fixedField?.settingsError)}`);
    console.log(`  Fixed field formulaText: ${fixedField?.typeSettings?.formulaText}`);

    // Now test deletion cascade: delete the Name field that formula+enrichment reference
    console.log("\n  Deleting Name field (referenced by Upper formula + Enriched action)...");
    await delay(200);
    const delName = await hit("3d", "DELETE", `/v3/tables/${tableId}/fields/${nameFid}`);
    console.log(`  Delete Name field: ${delName.status}`);

    // Read back — check Upper formula and Enriched action for errors
    await delay(500);
    s = await hit("3e", "GET", `/v3/tables/${tableId}`);
    const postDeleteFields = (s.body?.table || s.body)?.fields || [];
    for (const f of postDeleteFields) {
      if (f.id === upperFid || f.id === enrichFid || f.id === badFid) {
        console.log(`  ${f.name} (${f.type}): settingsError=${JSON.stringify(f.settingsError)}`);
        console.log(`    inputFieldIds: ${JSON.stringify(f.inputFieldIds)}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 4: Field Lock Settings (TODO-039)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 4: Field Lock Settings\n");

    // Check system field lock settings
    const sysField = postDeleteFields.find((f: any) => f.id === "f_created_at");
    console.log(`  System field (Created At) lockSettings: ${JSON.stringify(sysField?.lockSettings)}`);
    console.log(`  System field isLocked: ${sysField?.isLocked}`);

    // Check user field lock settings
    const userField = postDeleteFields.find((f: any) => f.id === scoreFid);
    console.log(`  User field (Score) lockSettings: ${JSON.stringify(userField?.lockSettings)}`);
    console.log(`  User field isLocked: ${userField?.isLocked}`);

    // Try setting lock on user field
    await delay(100);
    const lockResp = await hit("4a", "PATCH", `/v3/tables/${tableId}/fields/${scoreFid}`, {
      lockSettings: { lockDelete: true, lockUpdateCells: false, lockUpdateSettings: false }
    });
    console.log(`  PATCH lockSettings: ${lockResp.status}`);
    console.log(`  Response lockSettings: ${JSON.stringify(lockResp.body?.lockSettings || lockResp.body?.field?.lockSettings)}`);

    // Try isLocked flag
    await delay(100);
    const lockResp2 = await hit("4b", "PATCH", `/v3/tables/${tableId}/fields/${scoreFid}`, {
      isLocked: true
    });
    console.log(`  PATCH isLocked=true: ${lockResp2.status}`);

    // Read back
    await delay(200);
    s = await hit("4c", "GET", `/v3/tables/${tableId}`);
    const lockedField = ((s.body?.table || s.body)?.fields || []).find((f: any) => f.id === scoreFid);
    console.log(`  After lock attempt: lockSettings=${JSON.stringify(lockedField?.lockSettings)}, isLocked=${lockedField?.isLocked}`);

    // Try deleting the locked field
    if (lockedField?.isLocked || lockedField?.lockSettings?.lockDelete) {
      await delay(100);
      const delLocked = await hit("4d", "DELETE", `/v3/tables/${tableId}/fields/${scoreFid}`);
      console.log(`  Delete locked field: ${delLocked.status} — ${JSON.stringify(delLocked.body).substring(0, 200)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 5: Dedup with Source-Fed Rows (TODO-029)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 5: Dedup Behavior — Direct Insert vs Table Settings\n");

    // Create a fresh table for clean dedup test
    const dedupTable = await hit("5a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-dedup-v2"
    });
    const dedupTableId = dedupTable.body?.table?.id;
    tablesToClean.push(dedupTableId);
    await delay(500);

    const dedupSchema = await hit("5b", "GET", `/v3/tables/${dedupTableId}`);
    const dedupView = ((dedupSchema.body?.table || dedupSchema.body)?.gridViews || dedupSchema.body?.views || []).find((v: any) => v.name === "All rows")?.id;

    const dedupCol = await hit("5c", "POST", `/v3/tables/${dedupTableId}/fields`, {
      name: "Email", type: "text", typeSettings: { dataTypeSettings: { type: "email" } }, activeViewId: dedupView
    });
    const dedupFid = dedupCol.body?.field?.id;

    // Set dedup field
    await delay(100);
    await hit("5d", "PATCH", `/v3/tables/${dedupTableId}`, {
      tableSettings: { dedupeFieldId: dedupFid }
    });

    // Insert 3 rows: 2 unique, 1 duplicate
    await delay(300);
    const dedupRows = await hit("5e", "POST", `/v3/tables/${dedupTableId}/records`, {
      records: [
        { cells: { [dedupFid]: "alice@test.com" } },
        { cells: { [dedupFid]: "bob@test.com" } },
        { cells: { [dedupFid]: "alice@test.com" } },
      ]
    });
    console.log(`  Inserted: ${(dedupRows.body?.records || []).length} rows created`);
    for (const r of (dedupRows.body?.records || [])) {
      console.log(`    ${r.id}: email=${r.cells?.[dedupFid]?.value || r.cells?.[dedupFid]}, dedupeValue=${r.dedupeValue}`);
    }

    // Read back
    await delay(500);
    const dedupRead = await hit("5f", "GET", `/v3/tables/${dedupTableId}/views/${dedupView}/records?limit=100`);
    const dedupResults = dedupRead.body?.results || [];
    console.log(`  Total rows in table: ${dedupResults.length}`);
    for (const r of dedupResults) {
      console.log(`    ${r.id}: ${r.cells?.[dedupFid]?.value}, dedupeValue=${r.dedupeValue}`);
    }

    // Now insert ANOTHER duplicate
    await delay(200);
    const dedupRows2 = await hit("5g", "POST", `/v3/tables/${dedupTableId}/records`, {
      records: [{ cells: { [dedupFid]: "alice@test.com" } }]
    });
    console.log(`  Second insert of alice@test.com: ${dedupRows2.status}, created=${(dedupRows2.body?.records || []).length}`);

    await delay(500);
    const dedupRead2 = await hit("5h", "GET", `/v3/tables/${dedupTableId}/views/${dedupView}/records?limit=100`);
    console.log(`  Total rows now: ${(dedupRead2.body?.results || []).length}`);

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-9-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
