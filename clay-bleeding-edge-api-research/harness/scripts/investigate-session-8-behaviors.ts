/**
 * Session 8: Behavioral Deep Dive
 *
 * P0 questions that block agent autonomy:
 *   1. Duplication field ID remapping — do formulas break in the duplicate?
 *   2. autoRun actual behavior — does inserting rows via API trigger enrichments?
 *   3. Enrichment conditional execution tracking — what metadata appears?
 *   4. forceRun=false vs true — does false skip already-succeeded cells?
 *   5. Formula error handling — what happens with invalid references?
 *   6. Optional enrichment params — can you bind optional action inputs?
 *   7. tableSettings merge semantics — replace or accumulate?
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-8-behaviors.ts
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
  const start = Date.now();
  const opts: RequestInit = { method, headers: { Cookie: COOKIE, Accept: "application/json", "Content-Type": "application/json" } };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  try {
    const resp = await fetch(url, opts);
    const ms = Date.now() - start;
    let b: any; try { b = await resp.json(); } catch { b = await resp.text(); }
    const r = { probe, method, url: urlPath, status: resp.status, latencyMs: ms, body: b };
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
  console.log("║  Session 8: Behavioral Deep Dive                               ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // EXP 1: Duplication — Do Formulas Work in the Duplicate?
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> EXP 1: Duplication Field ID Remapping\n");

    const t1 = await hit("1a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-dup-remap-orig"
    });
    const origId = t1.body?.table?.id;
    tablesToClean.push(origId);
    await delay(500);

    let s1 = await hit("1b", "GET", `/v3/tables/${origId}`);
    const origView = ((s1.body?.table || s1.body)?.gridViews || [])[0]?.id;

    // Create columns: text + formula referencing text
    const nameCol = await hit("1c", "POST", `/v3/tables/${origId}/fields`, {
      name: "Name", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: origView
    });
    const nameFieldId = nameCol.body?.field?.id;

    await delay(100);
    const upperCol = await hit("1d", "POST", `/v3/tables/${origId}/fields`, {
      name: "Upper Name", type: "formula",
      typeSettings: { formulaText: `UPPER({{${nameFieldId}}})`, formulaType: "text", dataTypeSettings: { type: "text" } },
      activeViewId: origView
    });
    const upperFieldId = upperCol.body?.field?.id;

    // Insert a test row in original
    await delay(200);
    await hit("1e", "POST", `/v3/tables/${origId}/records`, {
      records: [{ cells: { [nameFieldId]: "anthropic" } }]
    });

    // Verify formula works in original
    await delay(1000);
    const origRows = await hit("1f", "GET", `/v3/tables/${origId}/views/${origView}/records?limit=10`);
    for (const r of (origRows.body?.results || [])) {
      console.log(`  Original: name="${r.cells?.[nameFieldId]?.value}" upper="${r.cells?.[upperFieldId]?.value}"`);
    }

    // DUPLICATE the table
    await delay(200);
    const dup = await hit("1g", "POST", `/v3/tables/${origId}/duplicate`, { name: "INV-dup-remap-copy" });
    const dupId = dup.body?.table?.id;
    tablesToClean.push(dupId);
    console.log(`  Duplicate: ${dupId}`);

    // Read duplicate schema
    await delay(500);
    const dupSchema = await hit("1h", "GET", `/v3/tables/${dupId}`);
    const dupTbl = dupSchema.body?.table || dupSchema.body;
    const dupFields = dupTbl?.fields || [];
    const dupView = (dupTbl?.gridViews || dupTbl?.views || [])[0]?.id;

    // Find the duplicate's field IDs
    const dupNameField = dupFields.find((f: any) => f.name === "Name");
    const dupUpperField = dupFields.find((f: any) => f.name === "Upper Name");

    console.log(`  Orig Name field: ${nameFieldId}`);
    console.log(`  Dup  Name field: ${dupNameField?.id} (${dupNameField?.id === nameFieldId ? "SAME ID!" : "DIFFERENT ID"})`);
    console.log(`  Dup  Upper formula: ${dupUpperField?.typeSettings?.formulaText}`);
    console.log(`  Formula references original? ${dupUpperField?.typeSettings?.formulaText?.includes(nameFieldId) ? "YES — STALE REF" : "NO — REMAPPED"}`);

    // Insert row into duplicate and check formula
    await delay(200);
    const dupNameId = dupNameField?.id;
    const dupUpperId = dupUpperField?.id;
    if (dupNameId) {
      await hit("1i", "POST", `/v3/tables/${dupId}/records`, {
        records: [{ cells: { [dupNameId]: "openai" } }]
      });
      await delay(1500);
      const dupRows = await hit("1j", "GET", `/v3/tables/${dupId}/views/${dupView}/records?limit=10`);
      for (const r of (dupRows.body?.results || [])) {
        const nameVal = r.cells?.[dupNameId]?.value;
        const upperVal = r.cells?.[dupUpperId]?.value;
        console.log(`  Duplicate: name="${nameVal}" upper="${upperVal}" (expect "OPENAI" if formula remapped)`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 2: autoRun — Does API Insert Trigger Enrichments?
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 2: Does autoRun Trigger Enrichments on API Inserts?\n");

    const t2 = await hit("2a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-autorun-test"
    });
    const autoTableId = t2.body?.table?.id;
    tablesToClean.push(autoTableId);
    await delay(500);

    const s2 = await hit("2b", "GET", `/v3/tables/${autoTableId}`);
    const autoView = ((s2.body?.table || s2.body)?.gridViews || [])[0]?.id;

    // Create input column + enrichment column
    const inputCol = await hit("2c", "POST", `/v3/tables/${autoTableId}/fields`, {
      name: "Company", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: autoView
    });
    const inputFid = inputCol.body?.field?.id;

    await delay(100);
    const enrichCol = await hit("2d", "POST", `/v3/tables/${autoTableId}/fields`, {
      name: "Normalized", type: "action",
      typeSettings: {
        actionKey: "normalize-company-name",
        actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
        inputsBinding: [{ name: "companyName", formulaText: `{{${inputFid}}}` }],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: autoView
    });
    const enrichFid = enrichCol.body?.field?.id;
    console.log(`  Fields: input=${inputFid}, enrich=${enrichFid}`);

    // Enable autoRun
    await delay(100);
    await hit("2e", "PATCH", `/v3/tables/${autoTableId}`, { tableSettings: { autoRun: true } });
    console.log("  autoRun enabled");

    // Insert row via API
    await delay(200);
    const autoRow = await hit("2f", "POST", `/v3/tables/${autoTableId}/records`, {
      records: [{ cells: { [inputFid]: "Stripe" } }]
    });
    const autoRowId = autoRow.body?.records?.[0]?.id;
    console.log(`  Inserted row: ${autoRowId}`);

    // Poll for enrichment execution
    console.log("  Polling for auto-enrichment (8 polls, 2s each)...");
    for (let i = 1; i <= 8; i++) {
      await delay(2000);
      const poll = await hit(`2g-poll-${i}`, "GET", `/v3/tables/${autoTableId}/views/${autoView}/records?limit=10`);
      const rows = poll.body?.results || [];
      for (const r of rows) {
        const cell = r.cells?.[enrichFid];
        const status = cell?.metadata?.status || cell?.metadata?.staleReason || "no-metadata";
        const hasVal = cell?.value !== null && cell?.value !== undefined;
        console.log(`  [Poll ${i}] ${r.id}: status=${status}, hasValue=${hasVal}${hasVal ? `, val=${JSON.stringify(cell.value).substring(0, 60)}` : ""}`);
        if (cell?.metadata) console.log(`    metadata: ${JSON.stringify(cell.metadata)}`);
      }
      if (rows.length > 0 && rows.every((r: any) => {
        const s = r.cells?.[enrichFid]?.metadata?.status;
        return s === "SUCCESS" || s?.startsWith("ERROR");
      })) {
        console.log(`  All rows completed after poll ${i}`);
        break;
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 3: forceRun Semantics
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 3: forceRun=false vs true on Already-Succeeded Cells\n");

    // Use the autorun table — row should have SUCCESS by now
    if (enrichFid && autoRowId) {
      // forceRun=false — should skip SUCCESS cells
      const noForce = await hit("3a", "PATCH", `/v3/tables/${autoTableId}/run`, {
        runRecords: { recordIds: [autoRowId] }, fieldIds: [enrichFid], forceRun: false
      });
      console.log(`  forceRun=false: ${JSON.stringify(noForce.body)}`);

      await delay(500);

      // forceRun=true — should re-run
      const withForce = await hit("3b", "PATCH", `/v3/tables/${autoTableId}/run`, {
        runRecords: { recordIds: [autoRowId] }, fieldIds: [enrichFid], forceRun: true
      });
      console.log(`  forceRun=true: ${JSON.stringify(withForce.body)}`);

      // Check run history
      await delay(3000);
      const afterForce = await hit("3c", "GET", `/v3/tables/${autoTableId}/views/${autoView}/records?limit=10`);
      for (const r of (afterForce.body?.results || [])) {
        const hist = r.recordMetadata?.runHistory?.[enrichFid];
        console.log(`  Run history: ${hist?.length || 0} entries`);
        if (hist) hist.forEach((h: any, i: number) => console.log(`    [${i}] time=${new Date(h.time).toISOString()} runId=${h.runId}`));
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 4: Formula Error Handling
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 4: Formula Error Handling\n");

    // Try creating a formula with invalid reference
    const badFormula = await hit("4a", "POST", `/v3/tables/${autoTableId}/fields`, {
      name: "Bad Formula", type: "formula",
      typeSettings: { formulaText: "UPPER({{f_NONEXISTENT}})", formulaType: "text", dataTypeSettings: { type: "text" } },
      activeViewId: autoView
    });
    console.log(`  Invalid ref formula: ${badFormula.status} — ${JSON.stringify(badFormula.body).substring(0, 200)}`);

    // Try creating a formula with syntax error
    const syntaxFormula = await hit("4b", "POST", `/v3/tables/${autoTableId}/fields`, {
      name: "Syntax Error", type: "formula",
      typeSettings: { formulaText: "UPPER((({{" + inputFid + "}})", formulaType: "text", dataTypeSettings: { type: "text" } },
      activeViewId: autoView
    });
    console.log(`  Syntax error formula: ${syntaxFormula.status} — ${JSON.stringify(syntaxFormula.body).substring(0, 200)}`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 5: Optional Enrichment Params
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 5: Enrichment with Optional Parameters\n");

    // normalize-company-name has optional param "titleCase" (boolean)
    const optEnrich = await hit("5a", "POST", `/v3/tables/${autoTableId}/fields`, {
      name: "Title Cased", type: "action",
      typeSettings: {
        actionKey: "normalize-company-name",
        actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
        inputsBinding: [
          { name: "companyName", formulaText: `{{${inputFid}}}` },
          { name: "titleCase", formulaText: "true" }
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: autoView
    });
    const optFid = optEnrich.body?.field?.id;
    console.log(`  With optional param: ${optEnrich.status} → ${optFid || "FAILED"}`);
    if (optEnrich.status !== 200) console.log(`    Error: ${JSON.stringify(optEnrich.body).substring(0, 200)}`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 6: tableSettings Merge vs Replace
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 6: tableSettings Merge Semantics\n");

    // Set initial settings
    await hit("6a", "PATCH", `/v3/tables/${autoTableId}`, { tableSettings: { keyA: "value1", keyB: "value2" } });
    let s6 = await hit("6b", "GET", `/v3/tables/${autoTableId}`);
    console.log(`  After set A+B: ${JSON.stringify((s6.body?.table || s6.body)?.tableSettings)}`);

    // Now set keyC only — does keyA/B survive?
    await delay(100);
    await hit("6c", "PATCH", `/v3/tables/${autoTableId}`, { tableSettings: { keyC: "value3" } });
    s6 = await hit("6d", "GET", `/v3/tables/${autoTableId}`);
    console.log(`  After set C only: ${JSON.stringify((s6.body?.table || s6.body)?.tableSettings)}`);
    const settings = (s6.body?.table || s6.body)?.tableSettings || {};
    console.log(`  keyA survived? ${settings.keyA ? "YES (MERGE)" : "NO (REPLACE)"}`);

    // Now try to DELETE a key by setting it null
    await delay(100);
    await hit("6e", "PATCH", `/v3/tables/${autoTableId}`, { tableSettings: { keyA: null } });
    s6 = await hit("6f", "GET", `/v3/tables/${autoTableId}`);
    console.log(`  After null keyA: ${JSON.stringify((s6.body?.table || s6.body)?.tableSettings)}`);

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-8-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
