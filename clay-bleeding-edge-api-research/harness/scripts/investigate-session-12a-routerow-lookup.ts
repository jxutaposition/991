/**
 * Session 12A: Route-Row Reverse Engineering + Cross-Table Lookups + Enrichment Extraction
 *
 * TODO-055: Reverse-engineer route-row payload from existing columns
 * TODO-052: Enrichment result extraction via formulas
 * TODO-056: Cross-table lookup actions
 *
 * CREDIT COST: 1 (one normalize-company-name execution for enrichment extraction test)
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
  console.log("║  Session 12A: Route-Row + Lookups + Enrichment Extraction      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // EXP 1: Reverse-engineer route-row from existing tables (FREE)
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> EXP 1: Route-Row Reverse Engineering\n");

    const tables = await hit("1a", "GET", `/v3/workspaces/${WORKSPACE}/tables`);
    const tableList = tables.body?.results || [];

    for (const t of tableList.slice(0, 15)) {
      const schema = await hit(`1b-${t.id}`, "GET", `/v3/tables/${t.id}`);
      const tbl = schema.body?.table || schema.body;
      const fields = tbl?.fields || [];
      const routeRows = fields.filter((f: any) => f.type === "action" && f.typeSettings?.actionKey === "route-row");

      if (routeRows.length > 0) {
        console.log(`  TABLE: ${t.name} (${t.id})`);
        for (const rr of routeRows) {
          console.log(`    Route-row: "${rr.name}" (${rr.id})`);
          console.log(`    FULL typeSettings:\n${JSON.stringify(rr.typeSettings, null, 2)}`);
          console.log(`    inputFieldIds: ${JSON.stringify(rr.inputFieldIds)}`);
          console.log(`    conditionalRunFieldIds: ${JSON.stringify(rr.conditionalRunFieldIds)}`);
          console.log(`    delayFieldIds: ${JSON.stringify(rr.delayFieldIds)}`);
          console.log();
        }
        break; // one table is enough
      }
      await delay(50);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 2: Try creating route-row with exact format from existing
    // ══════════════════════════════════════════════════════════════════
    console.log("\n>>> EXP 2: Create Route-Row with Correct Format\n");

    // Create two tables
    const tA = await hit("2a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-routerow-source"
    });
    const tableAId = tA.body?.table?.id;
    tablesToClean.push(tableAId);
    await delay(500);

    let schemaA = await hit("2b", "GET", `/v3/tables/${tableAId}`);
    const viewA = ((schemaA.body?.table || schemaA.body)?.gridViews || [])[0]?.id;

    const colA = await hit("2c", "POST", `/v3/tables/${tableAId}/fields`, {
      name: "Company", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: viewA
    });
    const companyFid = colA.body?.field?.id;
    await delay(100);
    const colA2 = await hit("2d", "POST", `/v3/tables/${tableAId}/fields`, {
      name: "Website", type: "text", typeSettings: { dataTypeSettings: { type: "url" } }, activeViewId: viewA
    });
    const websiteFid = colA2.body?.field?.id;

    const tB = await hit("2e", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-routerow-target"
    });
    const tableBId = tB.body?.table?.id;
    tablesToClean.push(tableBId);
    await delay(500);

    console.log(`  Table A: ${tableAId} (company=${companyFid}, website=${websiteFid})`);
    console.log(`  Table B: ${tableBId}`);

    // Get the actions catalog entry for route-row
    const actionsResp = await hit("2f", "GET", `/v3/actions?workspaceId=${WORKSPACE}`);
    const allActions = actionsResp.body?.actions || actionsResp.body || [];
    const routeRowAction = allActions.find((a: any) => a.key === "route-row");
    if (routeRowAction) {
      console.log(`\n  route-row action from catalog:`);
      console.log(`    key: ${routeRowAction.key}`);
      console.log(`    package.id: ${routeRowAction.package?.id}`);
      console.log(`    version: ${routeRowAction.version}`);
      console.log(`    inputParameterSchema: ${JSON.stringify(routeRowAction.inputParameterSchema).substring(0, 500)}`);
    }

    // Try route-row creation with different payload shapes based on what we learned
    const routeRowPayloads = [
      // Shape 1: Exact format from existing route-row columns (tableId as formulaText string literal)
      {
        name: "exact-from-existing",
        ts: {
          actionKey: "route-row",
          actionPackageId: routeRowAction?.package?.id,
          inputsBinding: [
            { name: "tableId", formulaText: `"${tableBId}"` },
            { name: "rowData", formulaMap: { "Company Name": `{{${companyFid}}}`, "Website": `{{${websiteFid}}}` } },
          ],
          dataTypeSettings: { type: "json" },
        }
      },
      // Shape 2: With actionVersion
      {
        name: "with-version",
        ts: {
          actionKey: "route-row",
          actionVersion: routeRowAction?.version,
          actionPackageId: routeRowAction?.package?.id,
          inputsBinding: [
            { name: "tableId", formulaText: `"${tableBId}"` },
            { name: "rowData", formulaMap: { "Company Name": `{{${companyFid}}}` } },
          ],
          dataTypeSettings: { type: "json" },
        }
      },
      // Shape 3: Without formulaMap, using formulaText for rowData
      {
        name: "rowData-as-text",
        ts: {
          actionKey: "route-row",
          actionPackageId: routeRowAction?.package?.id,
          inputsBinding: [
            { name: "tableId", formulaText: `"${tableBId}"` },
            { name: "rowData", formulaText: `{\"Company\": {{${companyFid}}}}` },
          ],
          dataTypeSettings: { type: "json" },
        }
      },
      // Shape 4: Minimal — just tableId, no rowData
      {
        name: "minimal-no-rowdata",
        ts: {
          actionKey: "route-row",
          actionPackageId: routeRowAction?.package?.id,
          inputsBinding: [
            { name: "tableId", formulaText: `"${tableBId}"` },
          ],
          dataTypeSettings: { type: "json" },
        }
      },
    ];

    for (const p of routeRowPayloads) {
      await delay(200);
      const r = await hit(`2g-${p.name}`, "POST", `/v3/tables/${tableAId}/fields`, {
        name: `RR: ${p.name}`,
        type: "action",
        typeSettings: p.ts,
        activeViewId: viewA
      });
      const fid = r.body?.field?.id;
      console.log(`  ${r.status === 200 ? "✅" : "❌"} ${p.name}: ${r.status} ${fid ? `→ ${fid}` : ""}`);
      if (r.status !== 200) console.log(`    Error: ${JSON.stringify(r.body).substring(0, 300)}`);
      if (fid) {
        console.log(`    SUCCESS! Route-row created.`);
        console.log(`    Full response: ${JSON.stringify(r.body).substring(0, 400)}`);

        // Check what Table B looks like after route-row creation
        await delay(500);
        const schemaB = await hit("2h", "GET", `/v3/tables/${tableBId}`);
        const tblB = schemaB.body?.table || schemaB.body;
        console.log(`    Table B fields after: ${(tblB?.fields || []).map((f: any) => `${f.name}(${f.type})`).join(", ")}`);
        break;
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 3: Enrichment Result Extraction via Formulas (1 credit)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 3: Enrichment Result Extraction via Formulas\n");

    const enrichTable = await hit("3a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-enrich-extract"
    });
    const enrichTableId = enrichTable.body?.table?.id;
    tablesToClean.push(enrichTableId);
    await delay(500);

    const enrichSchema = await hit("3b", "GET", `/v3/tables/${enrichTableId}`);
    const enrichView = ((enrichSchema.body?.table || enrichSchema.body)?.gridViews || [])[0]?.id;

    const inputCol = await hit("3c", "POST", `/v3/tables/${enrichTableId}/fields`, {
      name: "Company", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: enrichView
    });
    const inputFid = inputCol.body?.field?.id;

    await delay(100);
    const enrichCol = await hit("3d", "POST", `/v3/tables/${enrichTableId}/fields`, {
      name: "Normalized", type: "action",
      typeSettings: {
        actionKey: "normalize-company-name",
        actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
        inputsBinding: [{ name: "companyName", formulaText: `{{${inputFid}}}` }],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: enrichView
    });
    const enrichFid = enrichCol.body?.field?.id;

    // Create formula columns to extract from enrichment result
    const extractFormulas = [
      ["raw-ref", `{{${enrichFid}}}`],
      ["stringify", `JSON.stringify({{${enrichFid}}})`],
      ["dot-original", `{{${enrichFid}}}?.original_name`],
      ["dot-normalized", `{{${enrichFid}}}?.normalized_name`],
      ["dot-result", `{{${enrichFid}}}?.result`],
      ["dot-output", `{{${enrichFid}}}?.output`],
      ["dot-data", `{{${enrichFid}}}?.data`],
      ["dot-name", `{{${enrichFid}}}?.name`],
      ["dot-value", `{{${enrichFid}}}?.value`],
      ["keys", `JSON.stringify(Object.keys({{${enrichFid}}} || {}))`],
    ];

    const extractFids: Record<string, string> = {};
    for (const [name, formula] of extractFormulas) {
      await delay(60);
      const r = await hit(`3e-${name}`, "POST", `/v3/tables/${enrichTableId}/fields`, {
        name: `X:${name}`, type: "formula",
        typeSettings: { formulaText: formula, formulaType: "text", dataTypeSettings: { type: "text" } },
        activeViewId: enrichView
      });
      extractFids[name] = r.body?.field?.id;
    }

    // Enable autoRun and insert row
    await hit("3f", "PATCH", `/v3/tables/${enrichTableId}`, { tableSettings: { autoRun: true } });
    await delay(200);
    const enrichRow = await hit("3g", "POST", `/v3/tables/${enrichTableId}/records`, {
      records: [{ cells: { [inputFid]: "Anthropic" } }]
    });
    const enrichRowId = enrichRow.body?.records?.[0]?.id;

    // Wait for enrichment
    console.log("  Waiting 8s for enrichment + formula eval...");
    await delay(8000);

    // Read via single record endpoint
    const enrichResult = await hit("3h", "GET", `/v3/tables/${enrichTableId}/records/${enrichRowId}`);
    if (enrichResult.status === 200) {
      console.log("\n  Enrichment cell:");
      const enrichCell = enrichResult.body?.cells?.[enrichFid];
      console.log(`    value: ${JSON.stringify(enrichCell?.value)}`);
      console.log(`    metadata: ${JSON.stringify(enrichCell?.metadata)}`);

      console.log("\n  Extraction formulas:");
      for (const [name] of extractFormulas) {
        const cell = enrichResult.body?.cells?.[extractFids[name]];
        console.log(`    ${name.padEnd(18)}: ${JSON.stringify(cell?.value)} (status: ${cell?.metadata?.status || "none"})`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 4: Actions with richest no-auth capabilities (FREE — catalog only)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 4: Interesting No-Auth Action Deep Dives\n");

    // Dump full schemas for key actions
    const interestingActions = ["use-ai", "claygent", "scrape-website", "search-google", "http-api-v2", "table-level-ai", "scrape-page"];
    for (const key of interestingActions) {
      const action = allActions.find((a: any) => a.key === key);
      if (action) {
        const inputs = (action.inputParameterSchema || []).map?.((p: any) => `${p.name}(${p.type}${p.optional ? "?" : ""})`) || Object.keys(action.inputParameterSchema?.properties || {});
        console.log(`  ${key}: "${action.displayName}"`);
        console.log(`    pkg: ${action.package?.id}`);
        console.log(`    auth: ${action.auth?.providerType || "NONE"}`);
        console.log(`    inputs: ${JSON.stringify(inputs)}`);
        console.log(`    outputs: ${JSON.stringify((action.outputParameterSchema || []).map((o: any) => o.name || o.outputPath)).substring(0, 200)}`);
        console.log();
      }
    }

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-12a-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
