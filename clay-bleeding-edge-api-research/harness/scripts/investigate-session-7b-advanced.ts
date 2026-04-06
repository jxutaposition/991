/**
 * Session 7B: Advanced Operations
 *
 * TODO-033: Enrichment retry (forceRun true vs false on succeeded/errored cells)
 * TODO-035: Concurrent writes
 * TODO-037: Conditional run formulas
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-7b-advanced.ts
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
  const headers: Record<string, string> = { Cookie: COOKIE, Accept: "application/json", "Content-Type": "application/json" };
  const options: RequestInit = { method, headers };
  if (body && method !== "GET") options.body = JSON.stringify(body);
  try {
    const resp = await fetch(url, options);
    const ms = Date.now() - start;
    let b: any; try { b = await resp.json(); } catch { b = await resp.text(); }
    const r = { probe, method, url: urlPath, status: resp.status, latencyMs: ms, body: b };
    results.push(r);
    return r;
  } catch (err: any) {
    const r = { probe, method, url: urlPath, status: 0, latencyMs: Date.now() - start, body: null, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 7B: Advanced Operations                               ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // TODO-033: Enrichment Retry — forceRun Behavior
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> TODO-033: Enrichment Retry & forceRun Behavior\n");

    // Find existing table with enrichment results
    const tables = await hit("33a", "GET", `/v3/workspaces/${WORKSPACE}/tables`);
    const tableList = (tables.body?.results || []);

    // Find a table with action columns that have SUCCESS and ERROR cells
    let targetTable: any = null;
    let targetEnrichFieldId: string | null = null;
    let targetViewId: string | null = null;
    let successRecordIds: string[] = [];
    let errorRecordIds: string[] = [];

    for (const t of tableList.slice(0, 10)) {
      const schema = await hit(`33b-${t.id}`, "GET", `/v3/tables/${t.id}`);
      const tbl = schema.body?.table || schema.body;
      const fields = tbl?.fields || [];
      const actionFields = fields.filter((f: any) => f.type === "action" && f.typeSettings?.actionKey !== "route-row");

      if (actionFields.length > 0) {
        const views = tbl?.gridViews || tbl?.views || [];
        const allRowsView = views.find((v: any) => v.name === "All rows") || views[0];
        if (!allRowsView) continue;

        const rows = await hit(`33c-${t.id}`, "GET", `/v3/tables/${t.id}/views/${allRowsView.id}/records?limit=20`);
        const records = rows.body?.results || [];

        for (const r of records) {
          for (const af of actionFields) {
            const cell = r.cells?.[af.id];
            if (cell?.metadata?.status === "SUCCESS") successRecordIds.push(r.id);
            if (cell?.metadata?.status?.startsWith("ERROR")) errorRecordIds.push(r.id);
          }
        }

        if (successRecordIds.length > 0 || errorRecordIds.length > 0) {
          targetTable = t;
          targetEnrichFieldId = actionFields[0].id;
          targetViewId = allRowsView.id;
          console.log(`  Found table: ${t.name} (${t.id})`);
          console.log(`  Enrichment field: ${actionFields[0].name} (${targetEnrichFieldId})`);
          console.log(`  Success records: ${successRecordIds.length}, Error records: ${errorRecordIds.length}`);
          break;
        }
      }
      successRecordIds = [];
      errorRecordIds = [];
    }

    if (targetTable && targetEnrichFieldId) {
      // Test 1: forceRun=false on SUCCESS cells — should skip
      if (successRecordIds.length > 0) {
        console.log(`\n  Test 1: forceRun=false on ${successRecordIds.length} SUCCESS cells`);
        const r1 = await hit("33d-noforce-success", "PATCH", `/v3/tables/${targetTable.id}/run`, {
          runRecords: { recordIds: successRecordIds.slice(0, 2) },
          fieldIds: [targetEnrichFieldId],
          forceRun: false
        });
        console.log(`    Response: ${JSON.stringify(r1.body)}`);
      }

      // Test 2: forceRun=true on SUCCESS cells — should re-run
      if (successRecordIds.length > 0) {
        await delay(500);
        console.log(`\n  Test 2: forceRun=true on SUCCESS cells`);
        const r2 = await hit("33e-force-success", "PATCH", `/v3/tables/${targetTable.id}/run`, {
          runRecords: { recordIds: successRecordIds.slice(0, 1) },
          fieldIds: [targetEnrichFieldId],
          forceRun: true
        });
        console.log(`    Response: ${JSON.stringify(r2.body)}`);

        // Poll to see if it actually re-ran
        await delay(3000);
        const poll = await hit("33f-poll", "GET", `/v3/tables/${targetTable.id}/views/${targetViewId}/records?limit=5`);
        const row = (poll.body?.results || []).find((r: any) => r.id === successRecordIds[0]);
        if (row) {
          const runHist = row.recordMetadata?.runHistory?.[targetEnrichFieldId!];
          console.log(`    Run history entries: ${runHist?.length || 0} (more than before = re-ran)`);
          console.log(`    Latest run: ${JSON.stringify(runHist?.[runHist.length - 1])}`);
        }
      }

      // Test 3: forceRun on ERROR cells — should retry
      if (errorRecordIds.length > 0) {
        await delay(500);
        console.log(`\n  Test 3: forceRun=true on ${errorRecordIds.length} ERROR cells`);
        const r3 = await hit("33g-force-error", "PATCH", `/v3/tables/${targetTable.id}/run`, {
          runRecords: { recordIds: errorRecordIds.slice(0, 2) },
          fieldIds: [targetEnrichFieldId],
          forceRun: true
        });
        console.log(`    Response: ${JSON.stringify(r3.body)}`);
      }

      // Test 4: Run ALL records (no individual IDs)
      await delay(500);
      console.log(`\n  Test 4: runRecords variants`);
      const runAll = await hit("33h-run-all", "PATCH", `/v3/tables/${targetTable.id}/run`, {
        runRecords: { all: true },
        fieldIds: [targetEnrichFieldId],
        forceRun: false
      });
      console.log(`    {all: true}: ${JSON.stringify(runAll.body)}`);

    } else {
      console.log("  No table with enrichment results found — skipping retry tests");
    }

    // ══════════════════════════════════════════════════════════════════
    // TODO-035: Concurrent Writes
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> TODO-035: Concurrent Writes & Atomicity\n");

    const concTable = await hit("35a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-concurrent-test"
    });
    const concTableId = concTable.body?.table?.id;
    tablesToClean.push(concTableId);
    await delay(500);

    const concSchema = await hit("35b", "GET", `/v3/tables/${concTableId}`);
    const concViewId = ((concSchema.body?.table || concSchema.body)?.gridViews || [])[0]?.id;
    const concCol = await hit("35c", "POST", `/v3/tables/${concTableId}/fields`, {
      name: "Value", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: concViewId
    });
    const concFieldId = concCol.body?.field?.id;

    // Insert a row to update concurrently
    await delay(200);
    const seed = await hit("35d", "POST", `/v3/tables/${concTableId}/records`, {
      records: [{ cells: { [concFieldId]: "original" } }]
    });
    const rowId = seed.body?.records?.[0]?.id;
    console.log(`  Target row: ${rowId}`);

    // Fire 5 PATCH requests simultaneously with different values
    console.log("  Firing 5 concurrent updates...");
    const updates = ["alpha", "bravo", "charlie", "delta", "echo"].map((val, i) =>
      hit(`35e-concurrent-${i}`, "PATCH", `/v3/tables/${concTableId}/records`, {
        records: [{ id: rowId, cells: { [concFieldId]: val } }]
      })
    );
    const updateResults = await Promise.all(updates);
    for (const ur of updateResults) {
      console.log(`    ${ur.probe}: ${ur.status} ${ur.latencyMs}ms — ${JSON.stringify(ur.body).substring(0, 100)}`);
    }

    // Wait for async processing, then read
    await delay(3000);
    const readBack = await hit("35f", "GET", `/v3/tables/${concTableId}/views/${concViewId}/records?limit=10`);
    const finalRow = (readBack.body?.results || []).find((r: any) => r.id === rowId);
    console.log(`  Final value: "${finalRow?.cells?.[concFieldId]?.value}" (winner of concurrent race)`);

    // Test: Rapid-fire inserts (are all created?)
    console.log("\n  Rapid-fire 10 inserts...");
    const inserts = Array.from({ length: 10 }, (_, i) =>
      hit(`35g-rapid-${i}`, "POST", `/v3/tables/${concTableId}/records`, {
        records: [{ cells: { [concFieldId]: `rapid-${i}` } }]
      })
    );
    const insertResults = await Promise.all(inserts);
    const insertedCount = insertResults.filter(r => r.status === 200).length;
    console.log(`  ${insertedCount}/10 inserts succeeded`);

    await delay(1000);
    const allRows = await hit("35h", "GET", `/v3/tables/${concTableId}/views/${concViewId}/records?limit=100`);
    console.log(`  Total rows after rapid inserts: ${(allRows.body?.results || []).length} (expect 11: 1 original + 10 rapid)`);

    // ══════════════════════════════════════════════════════════════════
    // TODO-037: Conditional Run Formulas
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> TODO-037: Conditional Run Formulas\n");

    const condTable = await hit("37a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-conditional-run-test"
    });
    const condTableId = condTable.body?.table?.id;
    tablesToClean.push(condTableId);
    await delay(500);

    const condSchema = await hit("37b", "GET", `/v3/tables/${condTableId}`);
    const condViewId = ((condSchema.body?.table || condSchema.body)?.gridViews || [])[0]?.id;

    // Create input columns
    const companyCol = await hit("37c", "POST", `/v3/tables/${condTableId}/fields`, {
      name: "Company", type: "text",
      typeSettings: { dataTypeSettings: { type: "text" } },
      activeViewId: condViewId
    });
    const companyFieldId = companyCol.body?.field?.id;

    await delay(100);
    const scoreCol = await hit("37d", "POST", `/v3/tables/${condTableId}/fields`, {
      name: "Score", type: "text",
      typeSettings: { dataTypeSettings: { type: "number" } },
      activeViewId: condViewId
    });
    const scoreFieldId = scoreCol.body?.field?.id;

    // Create enrichment with conditional run: only run if score > 50
    await delay(200);
    const condEnrich = await hit("37e", "POST", `/v3/tables/${condTableId}/fields`, {
      name: "Conditional Enrichment", type: "action",
      typeSettings: {
        actionKey: "normalize-company-name",
        actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
        inputsBinding: [{ name: "companyName", formulaText: `{{${companyFieldId}}}` }],
        conditionalRunFormulaText: `{{${scoreFieldId}}} > 50`,
        dataTypeSettings: { type: "json" }
      },
      activeViewId: condViewId
    });
    const condEnrichFieldId = condEnrich.body?.field?.id;
    console.log(`  Conditional enrichment field: ${condEnrichFieldId}`);
    if (condEnrich.status !== 200) {
      console.log(`  Error: ${JSON.stringify(condEnrich.body).substring(0, 300)}`);
    }

    // Insert rows with different scores
    await delay(200);
    const condRows = await hit("37f", "POST", `/v3/tables/${condTableId}/records`, {
      records: [
        { cells: { [companyFieldId]: "HighScore Inc", [scoreFieldId]: "80" } },
        { cells: { [companyFieldId]: "LowScore Corp", [scoreFieldId]: "20" } },
        { cells: { [companyFieldId]: "MidScore LLC", [scoreFieldId]: "60" } },
      ]
    });
    const condRecordIds = (condRows.body?.records || []).map((r: any) => r.id);
    console.log(`  Inserted ${condRecordIds.length} rows`);

    // Trigger enrichment on all rows
    if (condEnrichFieldId && condRecordIds.length > 0) {
      await delay(500);
      const trigger = await hit("37g", "PATCH", `/v3/tables/${condTableId}/run`, {
        runRecords: { recordIds: condRecordIds },
        fieldIds: [condEnrichFieldId],
        forceRun: true
      });
      console.log(`  Trigger: ${JSON.stringify(trigger.body)}`);

      // Poll for results
      console.log("  Polling for conditional results...");
      await delay(5000);
      const condResult = await hit("37h", "GET", `/v3/tables/${condTableId}/views/${condViewId}/records?limit=10`);
      for (const r of (condResult.body?.results || [])) {
        const company = r.cells?.[companyFieldId]?.value;
        const score = r.cells?.[scoreFieldId]?.value;
        const enrichCell = r.cells?.[condEnrichFieldId];
        const status = enrichCell?.metadata?.status || enrichCell?.metadata?.staleReason || "none";
        console.log(`    ${company} (score=${score}): status=${status}, value=${JSON.stringify(enrichCell?.value)?.substring(0, 60)}`);
        if (enrichCell?.metadata) console.log(`      metadata: ${JSON.stringify(enrichCell.metadata)}`);
      }
    }

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-7b-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
