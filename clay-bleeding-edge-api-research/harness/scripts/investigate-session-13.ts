/**
 * Session 13: Power Actions — AI, Scraping, HTTP, Cross-Table Lookups
 *
 * TODO-054: use-ai action (Clay's built-in LLM)
 * TODO-056: Cross-table lookup actions
 * TODO-057: scrape-website action
 * TODO-058: http-api-v2 as outbound webhook
 * + Route-row end-to-end pipeline test (trigger + verify delivery)
 * + use-ai with jsonMode for structured output
 *
 * CREDIT COST: ~6 (1 per action test: use-ai, scrape, lookup, http, route-row trigger, normalize)
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
    return { probe, method, url: urlPath, status: 0, body: null, error: err.message };
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 13: Power Actions — AI, Scrape, HTTP, Lookups         ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // SETUP: Create main test table
    // ══════════════════════════════════════════════════════════════════
    const t = await hit("setup", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-power-actions"
    });
    const tableId = t.body?.table?.id;
    tablesToClean.push(tableId);
    await delay(500);

    const s = await hit("schema", "GET", `/v3/tables/${tableId}`);
    const viewId = ((s.body?.table || s.body)?.gridViews || [])[0]?.id;

    // Input columns
    const cName = await hit("c1", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Company", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: viewId
    });
    const nameFid = cName.body?.field?.id;
    await delay(60);

    const cUrl = await hit("c2", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Website", type: "text", typeSettings: { dataTypeSettings: { type: "url" } }, activeViewId: viewId
    });
    const urlFid = cUrl.body?.field?.id;
    await delay(60);

    console.log(`Table: ${tableId}, View: ${viewId}, name=${nameFid}, url=${urlFid}\n`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 1: use-ai Action (TODO-054) — 1 credit
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> EXP 1: use-ai — Clay's Built-in LLM\n");

    const aiCol = await hit("1a", "POST", `/v3/tables/${tableId}/fields`, {
      name: "AI Summary", type: "action",
      typeSettings: {
        actionKey: "use-ai",
        actionPackageId: "67ba01e9-1898-4e7d-afe7-7ebe24819a57",
        inputsBinding: [
          { name: "prompt", formulaText: `"In one sentence, what does " + {{${nameFid}}} + " do as a company?"` },
          { name: "model", formulaText: `"gpt-4o-mini"` },
          { name: "maxCostInCents", formulaText: `10` },
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    const aiFid = aiCol.body?.field?.id;
    console.log(`  use-ai column: ${aiCol.status} → ${aiFid || "FAILED"}`);
    if (aiCol.status !== 200) console.log(`  Error: ${JSON.stringify(aiCol.body).substring(0, 300)}`);

    // Test use-ai with jsonMode
    await delay(60);
    const aiJsonCol = await hit("1b", "POST", `/v3/tables/${tableId}/fields`, {
      name: "AI JSON", type: "action",
      typeSettings: {
        actionKey: "use-ai",
        actionPackageId: "67ba01e9-1898-4e7d-afe7-7ebe24819a57",
        inputsBinding: [
          { name: "prompt", formulaText: `"Return JSON with keys 'industry' and 'founded_year' for company: " + {{${nameFid}}}` },
          { name: "model", formulaText: `"gpt-4o-mini"` },
          { name: "jsonMode", formulaText: `true` },
          { name: "maxCostInCents", formulaText: `10` },
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    const aiJsonFid = aiJsonCol.body?.field?.id;
    console.log(`  use-ai jsonMode column: ${aiJsonCol.status} → ${aiJsonFid || "FAILED"}`);
    if (aiJsonCol.status !== 200) console.log(`  Error: ${JSON.stringify(aiJsonCol.body).substring(0, 300)}`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 2: scrape-website Action (TODO-057) — 1 credit
    // ══════════════════════════════════════════════════════════════════
    console.log("\n>>> EXP 2: scrape-website — Built-in Web Scraping\n");

    const scrapeCol = await hit("2a", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Scraped Data", type: "action",
      typeSettings: {
        actionKey: "scrape-website",
        actionPackageId: "4299091f-3cd3-4d68-b198-0143575f471d",
        inputsBinding: [
          { name: "url", formulaText: `{{${urlFid}}}` },
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    const scrapeFid = scrapeCol.body?.field?.id;
    console.log(`  scrape-website column: ${scrapeCol.status} → ${scrapeFid || "FAILED"}`);
    if (scrapeCol.status !== 200) console.log(`  Error: ${JSON.stringify(scrapeCol.body).substring(0, 300)}`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 3: Cross-Table Lookup (TODO-056) — 0-1 credits
    // ══════════════════════════════════════════════════════════════════
    console.log("\n>>> EXP 3: Cross-Table Lookup\n");

    // Create a reference table with company data
    const refTable = await hit("3a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-lookup-reference"
    });
    const refTableId = refTable.body?.table?.id;
    tablesToClean.push(refTableId);
    await delay(500);

    const refSchema = await hit("3b", "GET", `/v3/tables/${refTableId}`);
    const refView = ((refSchema.body?.table || refSchema.body)?.gridViews || [])[0]?.id;

    const refCol = await hit("3c", "POST", `/v3/tables/${refTableId}/fields`, {
      name: "Domain", type: "text", typeSettings: { dataTypeSettings: { type: "url" } }, activeViewId: refView
    });
    const refDomainFid = refCol.body?.field?.id;
    await delay(60);
    const refInfoCol = await hit("3d", "POST", `/v3/tables/${refTableId}/fields`, {
      name: "Industry", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: refView
    });
    const refInfoFid = refInfoCol.body?.field?.id;

    // Seed reference data
    await delay(200);
    await hit("3e", "POST", `/v3/tables/${refTableId}/records`, {
      records: [
        { cells: { [refDomainFid]: "anthropic.com", [refInfoFid]: "AI Safety" } },
        { cells: { [refDomainFid]: "stripe.com", [refInfoFid]: "Payments" } },
        { cells: { [refDomainFid]: "google.com", [refInfoFid]: "Search & Cloud" } },
      ]
    });

    // Create lookup column on main table → reference table
    await delay(200);
    const lookupCol = await hit("3f", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Industry Lookup", type: "action",
      typeSettings: {
        actionKey: "lookup-field-in-other-table-new-ui",
        actionPackageId: "4299091f-3cd3-4d68-b198-0143575f471d",
        inputsBinding: [
          { name: "tableId", formulaText: `"${refTableId}"` },
          { name: "targetColumn", formulaText: `"${refDomainFid}"` },
          { name: "filterOperator", formulaText: `"contains"` },
          { name: "recordValue", formulaText: `DOMAIN({{${urlFid}}}) || {{${urlFid}}}` },
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    const lookupFid = lookupCol.body?.field?.id;
    console.log(`  lookup column: ${lookupCol.status} → ${lookupFid || "FAILED"}`);
    if (lookupCol.status !== 200) console.log(`  Error: ${JSON.stringify(lookupCol.body).substring(0, 300)}`);

    // ══════════════════════════════════════════════════════════════════
    // EXP 4: Route-Row End-to-End Pipeline
    // ══════════════════════════════════════════════════════════════════
    console.log("\n>>> EXP 4: Route-Row Full Pipeline\n");

    const targetTable = await hit("4a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-routerow-destination"
    });
    const targetTableId = targetTable.body?.table?.id;
    tablesToClean.push(targetTableId);
    await delay(300);

    const rrCol = await hit("4b", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Send to Destination", type: "action",
      typeSettings: {
        actionKey: "route-row",
        actionPackageId: "b1ab3d5d-b0db-4b30-9251-3f32d8b103c1",
        inputsBinding: [
          { name: "tableId", formulaText: `"${targetTableId}"` },
          { name: "rowData", formulaMap: { "Company": `{{${nameFid}}}`, "URL": `{{${urlFid}}}` } },
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    const rrFid = rrCol.body?.field?.id;
    console.log(`  route-row column: ${rrCol.status} → ${rrFid || "FAILED"}`);

    // ══════════════════════════════════════════════════════════════════
    // EXECUTE: Insert row + autoRun all actions
    // ══════════════════════════════════════════════════════════════════
    console.log("\n>>> EXECUTE: Enable autoRun, insert test row, observe results\n");

    await hit("exec-ar", "PATCH", `/v3/tables/${tableId}`, { tableSettings: { autoRun: true } });

    await delay(300);
    const row = await hit("exec-row", "POST", `/v3/tables/${tableId}/records`, {
      records: [{ cells: { [nameFid]: "Anthropic", [urlFid]: "https://anthropic.com" } }]
    });
    const rowId = row.body?.records?.[0]?.id;
    console.log(`  Inserted row: ${rowId}`);
    console.log("  Waiting 15s for all actions to execute...\n");
    await delay(15000);

    // Read results via single record
    const result = await hit("exec-read", "GET", `/v3/tables/${tableId}/records/${rowId}`);
    if (result.status === 200) {
      const cells = result.body?.cells || {};

      // AI result
      if (aiFid) {
        const aiCell = cells[aiFid];
        console.log(`  use-ai result:`);
        console.log(`    status: ${aiCell?.metadata?.status}`);
        console.log(`    value: ${JSON.stringify(aiCell?.value)}`);
      }

      // AI JSON result
      if (aiJsonFid) {
        const ajCell = cells[aiJsonFid];
        console.log(`\n  use-ai jsonMode result:`);
        console.log(`    status: ${ajCell?.metadata?.status}`);
        console.log(`    value: ${JSON.stringify(ajCell?.value)}`);
      }

      // Scrape result
      if (scrapeFid) {
        const scrapeCell = cells[scrapeFid];
        console.log(`\n  scrape-website result:`);
        console.log(`    status: ${scrapeCell?.metadata?.status}`);
        console.log(`    value (preview): ${JSON.stringify(scrapeCell?.value)?.substring(0, 200)}`);
      }

      // Lookup result
      if (lookupFid) {
        const lookupCell = cells[lookupFid];
        console.log(`\n  lookup result:`);
        console.log(`    status: ${lookupCell?.metadata?.status}`);
        console.log(`    value: ${JSON.stringify(lookupCell?.value)}`);
      }

      // Route-row result
      if (rrFid) {
        const rrCell = cells[rrFid];
        console.log(`\n  route-row result:`);
        console.log(`    status: ${rrCell?.metadata?.status}`);
        console.log(`    value: ${JSON.stringify(rrCell?.value)}`);
      }

      // Dump ALL enrichment field metadata
      console.log(`\n  recordMetadata: ${JSON.stringify(result.body?.recordMetadata)}`);
    }

    // Check destination table for route-row delivery
    if (targetTableId) {
      await delay(1000);
      const targetSchema = await hit("4c", "GET", `/v3/tables/${targetTableId}`);
      const targetTbl = targetSchema.body?.table || targetSchema.body;
      const targetView = (targetTbl?.gridViews || targetTbl?.views || []).find((v: any) => v.name === "All rows")?.id || (targetTbl?.gridViews || [])[0]?.id;

      if (targetView) {
        const targetRows = await hit("4d", "GET", `/v3/tables/${targetTableId}/views/${targetView}/records?limit=100`);
        const tRows = targetRows.body?.results || [];
        console.log(`\n  Destination table rows: ${tRows.length}`);
        for (const r of tRows) {
          console.log(`    ${r.id}: ${JSON.stringify(r.cells).substring(0, 200)}`);
        }
      }

      console.log(`\n  Destination table fields:`);
      for (const f of (targetTbl?.fields || [])) {
        console.log(`    ${f.name} (${f.type})`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXTRACT: Use formulas to decompose enrichment results
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXTRACT: Formula-based result decomposition\n");

    // Add formula columns to extract from AI JSON result
    if (aiJsonFid) {
      const extractFormulas = [
        ["ai-industry", `{{${aiJsonFid}}}?.industry`],
        ["ai-year", `{{${aiJsonFid}}}?.founded_year`],
        ["ai-keys", `JSON.stringify(Object.keys({{${aiJsonFid}}} || {}))`],
        ["ai-stringify", `JSON.stringify({{${aiJsonFid}}})`],
      ];

      for (const [name, formula] of extractFormulas) {
        await delay(60);
        await hit(`ext-${name}`, "POST", `/v3/tables/${tableId}/fields`, {
          name: `X:${name}`, type: "formula",
          typeSettings: { formulaText: formula, formulaType: "text", dataTypeSettings: { type: "text" } },
          activeViewId: viewId
        });
      }

      // Wait for formulas to evaluate
      await delay(3000);

      // Read via single record
      const extResult = await hit("ext-read", "GET", `/v3/tables/${tableId}/records/${rowId}`);
      if (extResult.status === 200) {
        for (const f of Object.entries(extResult.body?.cells || {})) {
          const [fid, cell] = f as [string, any];
          if (fid.startsWith("f_") && !["f_created_at", "f_updated_at"].includes(fid)) {
            // Find field name from schema
            const fieldName = (s.body?.table || s.body)?.fields?.find((ff: any) => ff.id === fid)?.name || fid;
            if (fieldName.startsWith("X:")) {
              console.log(`  ${fieldName}: ${JSON.stringify(cell?.value)}`);
            }
          }
        }
      }
    }

    // Extract from scrape result
    if (scrapeFid) {
      const scrapeExtract = [
        ["scrape-title", `{{${scrapeFid}}}?.title`],
        ["scrape-desc", `{{${scrapeFid}}}?.description`],
        ["scrape-emails", `JSON.stringify({{${scrapeFid}}}?.emails)`],
        ["scrape-keys", `JSON.stringify(Object.keys({{${scrapeFid}}} || {}))`],
      ];

      for (const [name, formula] of scrapeExtract) {
        await delay(60);
        await hit(`sext-${name}`, "POST", `/v3/tables/${tableId}/fields`, {
          name: `S:${name}`, type: "formula",
          typeSettings: { formulaText: formula, formulaType: "text", dataTypeSettings: { type: "text" } },
          activeViewId: viewId
        });
      }

      await delay(3000);
      const sextResult = await hit("sext-read", "GET", `/v3/tables/${tableId}/records/${rowId}`);
      if (sextResult.status === 200) {
        for (const [fid, cell] of Object.entries(sextResult.body?.cells || {}) as [string, any][]) {
          // Read all formula extraction columns from schema
          const allFields = (await hit("sext-schema", "GET", `/v3/tables/${tableId}`)).body;
          const fieldObj = (allFields?.table || allFields)?.fields?.find((ff: any) => ff.id === fid);
          if (fieldObj?.name?.startsWith("S:")) {
            console.log(`  ${fieldObj.name}: ${JSON.stringify(cell?.value)?.substring(0, 200)}`);
          }
        }
      }
    }

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-13-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
