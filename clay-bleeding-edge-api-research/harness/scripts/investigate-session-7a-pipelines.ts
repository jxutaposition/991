/**
 * Session 7A: Pipeline Operations
 *
 * TODO-032: Webhook ingestion → autoRun → enrichment chain
 * TODO-034: Limits (max rows per insert, max value size)
 * TODO-036: Table duplication content verification
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-7a-pipelines.ts
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

async function hit(probe: string, method: string, urlPath: string, body?: any, extraHeaders?: Record<string,string>): Promise<any> {
  const url = urlPath.startsWith("http") ? urlPath : `${API_BASE}${urlPath}`;
  const start = Date.now();
  const headers: Record<string, string> = { Cookie: COOKIE, Accept: "application/json", "Content-Type": "application/json", ...extraHeaders };
  const options: RequestInit = { method, headers };
  if (body && method !== "GET") options.body = JSON.stringify(body);
  try {
    const resp = await fetch(url, options);
    const ms = Date.now() - start;
    let b: any; try { b = await resp.json(); } catch { b = await resp.text(); }
    const r = { probe, method, url: url.replace(API_BASE, ""), status: resp.status, latencyMs: ms, body: b };
    results.push(r);
    return r;
  } catch (err: any) {
    const r = { probe, method, url: url.replace(API_BASE, ""), status: 0, latencyMs: Date.now() - start, body: null, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 7A: Pipeline Operations                               ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // TODO-032: Webhook Ingestion + autoRun
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> TODO-032: Webhook → Row → Auto-Enrichment Pipeline\n");

    // Create table
    const t = await hit("32a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-webhook-autorun-test"
    });
    const tableId = t.body?.table?.id;
    tablesToClean.push(tableId);
    await delay(500);

    const schema = await hit("32b", "GET", `/v3/tables/${tableId}`);
    const tbl = schema.body?.table || schema.body;
    const viewId = (tbl?.gridViews || tbl?.views || [])[0]?.id;

    // Create text column
    const col = await hit("32c", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Company", type: "text",
      typeSettings: { dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const textFieldId = col.body?.field?.id;

    // Create a formula column (to test auto-eval on webhook rows)
    await delay(100);
    const formulaCol = await hit("32d", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Upper", type: "formula",
      typeSettings: { formulaText: `UPPER({{${textFieldId}}})`, formulaType: "text", dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const formulaFieldId = formulaCol.body?.field?.id;

    // Create enrichment column (normalize-company-name)
    await delay(100);
    const enrichCol = await hit("32e", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Normalized", type: "action",
      typeSettings: {
        actionKey: "normalize-company-name",
        actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
        inputsBinding: [{ name: "companyName", formulaText: `{{${textFieldId}}}` }],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    const enrichFieldId = enrichCol.body?.field?.id;
    console.log(`  Fields: text=${textFieldId}, formula=${formulaFieldId}, enrich=${enrichFieldId}`);

    // Enable autoRun
    await delay(100);
    await hit("32f", "PATCH", `/v3/tables/${tableId}`, { tableSettings: { autoRun: true } });

    // Create webhook source
    await delay(100);
    const src = await hit("32g", "POST", "/v3/sources", {
      workspaceId: parseInt(WORKSPACE), tableId, name: "Test Webhook", type: "webhook", typeSettings: {}
    });
    const sourceId = src.body?.id;
    console.log(`  Source: ${sourceId}`);

    // Read source to get webhook URL
    await delay(300);
    const srcDetail = await hit("32h", "GET", `/v3/sources/${sourceId}`);
    const webhookUrl = srcDetail.body?.state?.url;
    console.log(`  Webhook URL: ${webhookUrl}`);

    if (webhookUrl) {
      // POST data to webhook — try different formats
      console.log("\n  Posting data to webhook...");

      // Format 1: Simple JSON object
      const wh1 = await hit("32i-json", "POST", webhookUrl, { Company: "Anthropic" }, {});
      console.log(`  JSON POST: ${wh1.status} — ${JSON.stringify(wh1.body).substring(0, 200)}`);

      await delay(500);

      // Format 2: Array of objects
      const wh2 = await hit("32j-array", "POST", webhookUrl, [{ Company: "OpenAI" }, { Company: "Google DeepMind" }], {});
      console.log(`  Array POST: ${wh2.status} — ${JSON.stringify(wh2.body).substring(0, 200)}`);

      // Wait for processing
      console.log("\n  Waiting 5s for webhook processing + potential auto-enrichment...");
      await delay(5000);

      // Read rows
      const rows = await hit("32k", "GET", `/v3/tables/${tableId}/views/${viewId}/records?limit=100`);
      const records = rows.body?.results || [];
      console.log(`\n  Rows in table: ${records.length}`);
      for (const r of records) {
        const company = r.cells?.[textFieldId]?.value;
        const upper = r.cells?.[formulaFieldId];
        const enriched = r.cells?.[enrichFieldId];
        console.log(`    ${r.id}: company="${company}", formula=${JSON.stringify(upper)}, enrich_status=${enriched?.metadata?.status || "none"}, enrich_value=${JSON.stringify(enriched?.value)?.substring(0, 80)}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // TODO-036: Table Duplication Content Verification
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> TODO-036: Table Duplication — What Gets Copied?\n");

    // First insert some rows via API (not webhook)
    await delay(200);
    await hit("36a", "POST", `/v3/tables/${tableId}/records`, {
      records: [
        { cells: { [textFieldId]: "Stripe" } },
        { cells: { [textFieldId]: "Coinbase" } },
      ]
    });

    // Duplicate the table
    await delay(500);
    const dup = await hit("36b", "POST", `/v3/tables/${tableId}/duplicate`, { name: "INV-duplication-copy" });
    const dupId = dup.body?.table?.id;
    if (dupId) {
      tablesToClean.push(dupId);
      console.log(`  Duplicate created: ${dupId}`);

      // Read duplicate schema
      await delay(500);
      const dupSchema = await hit("36c", "GET", `/v3/tables/${dupId}`);
      const dupTbl = dupSchema.body?.table || dupSchema.body;
      const dupFields = dupTbl?.fields || [];
      const dupViews = dupTbl?.gridViews || dupTbl?.views || [];
      const dupSettings = dupTbl?.tableSettings;
      const dupWorkbookId = dupTbl?.workbookId;
      const origWorkbookId = tbl?.workbookId;

      console.log(`  Original workbook: ${origWorkbookId}, Duplicate workbook: ${dupWorkbookId} (${origWorkbookId === dupWorkbookId ? "SAME" : "DIFFERENT"})`);
      console.log(`  Original fields: ${(tbl?.fields || []).length}, Duplicate fields: ${dupFields.length}`);
      console.log(`  Original views: ${(tbl?.gridViews || tbl?.views || []).length}, Duplicate views: ${dupViews.length}`);
      console.log(`  Duplicate tableSettings: ${JSON.stringify(dupSettings)}`);

      // Compare fields
      console.log("\n  Field comparison:");
      for (const df of dupFields) {
        const orig = (tbl?.fields || []).find((f: any) => f.name === df.name);
        const match = orig ? "✅ matched" : "❓ new";
        const typeMatch = orig?.type === df.type ? "" : ` (type: ${orig?.type}→${df.type})`;
        console.log(`    ${df.name} (${df.type}): ${match}${typeMatch}`);
        if (df.type === "action") {
          console.log(`      actionKey: ${df.typeSettings?.actionKey}, inputsBinding: ${JSON.stringify(df.typeSettings?.inputsBinding)?.substring(0, 100)}`);
        }
      }

      // Check if rows were copied
      const dupViewId = dupViews[0]?.id;
      if (dupViewId) {
        await delay(200);
        const dupRows = await hit("36d", "GET", `/v3/tables/${dupId}/views/${dupViewId}/records?limit=100`);
        console.log(`\n  Rows copied: ${(dupRows.body?.results || []).length}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // TODO-034: Limits — Max Rows Per Insert
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> TODO-034: Limits Testing\n");

    const limTable = await hit("34a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-limits-test"
    });
    const limTableId = limTable.body?.table?.id;
    tablesToClean.push(limTableId);
    await delay(500);

    const limSchema = await hit("34b", "GET", `/v3/tables/${limTableId}`);
    const limViewId = ((limSchema.body?.table || limSchema.body)?.gridViews || [])[0]?.id;
    const limCol = await hit("34c", "POST", `/v3/tables/${limTableId}/fields`, {
      name: "Data", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: limViewId
    });
    const limFieldId = limCol.body?.field?.id;

    // Test: 100 rows in one call
    await delay(200);
    const batch100 = Array.from({ length: 100 }, (_, i) => ({ cells: { [limFieldId]: `row-${i}` } }));
    const r100 = await hit("34d-100rows", "POST", `/v3/tables/${limTableId}/records`, { records: batch100 });
    console.log(`  100 rows: ${r100.status}, created=${r100.body?.records?.length || 0} (${r100.latencyMs}ms)`);

    // Test: 500 rows in one call
    await delay(200);
    const batch500 = Array.from({ length: 500 }, (_, i) => ({ cells: { [limFieldId]: `row-${100 + i}` } }));
    const r500 = await hit("34e-500rows", "POST", `/v3/tables/${limTableId}/records`, { records: batch500 });
    console.log(`  500 rows: ${r500.status}, created=${r500.body?.records?.length || 0} (${r500.latencyMs}ms)`);
    if (r500.status !== 200) console.log(`    Error: ${JSON.stringify(r500.body).substring(0, 300)}`);

    // Test: Large value
    await delay(200);
    const bigValue = "x".repeat(50000); // 50KB string
    const rBig = await hit("34f-bigvalue", "POST", `/v3/tables/${limTableId}/records`, {
      records: [{ cells: { [limFieldId]: bigValue } }]
    });
    console.log(`  50KB value: ${rBig.status}, created=${rBig.body?.records?.length || 0}`);

    // Test: Very large value (500KB)
    await delay(200);
    const hugeValue = "y".repeat(500000);
    const rHuge = await hit("34g-hugevalue", "POST", `/v3/tables/${limTableId}/records`, {
      records: [{ cells: { [limFieldId]: hugeValue } }]
    });
    console.log(`  500KB value: ${rHuge.status}, created=${rHuge.body?.records?.length || 0}`);
    if (rHuge.status !== 200) console.log(`    Error: ${JSON.stringify(rHuge.body).substring(0, 300)}`);

    // Count total rows
    await delay(500);
    const allRows = await hit("34h-count", "GET", `/v3/tables/${limTableId}/views/${limViewId}/records?limit=10000`);
    console.log(`  Total rows in table: ${(allRows.body?.results || []).length}`);

    // Test: Partial failure — mix valid and invalid field IDs
    console.log("\n  Testing partial failure (invalid field ID)...");
    await delay(200);
    const rMixed = await hit("34i-mixed", "POST", `/v3/tables/${limTableId}/records`, {
      records: [
        { cells: { [limFieldId]: "valid-row" } },
        { cells: { "f_NONEXISTENT": "invalid-row" } },
        { cells: { [limFieldId]: "another-valid" } },
      ]
    });
    console.log(`  Mixed valid/invalid: ${rMixed.status}, created=${rMixed.body?.records?.length || 0}`);
    if (rMixed.body?.records) {
      for (const r of rMixed.body.records) {
        console.log(`    ${r.id}: ${JSON.stringify(r.cells).substring(0, 100)}`);
      }
    }

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-7a-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
