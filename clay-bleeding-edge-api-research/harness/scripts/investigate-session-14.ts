/**
 * Session 14: Creative Patterns — Formula Chains, JSON Cells, Circular Routes,
 * use-ai Debugging, Enrichment Chaining, Action Swapping, table-level-ai
 *
 * CREDIT COST: ~4 (use-ai x2, scrape x1, normalize x1; formulas/route-row/JSON are free)
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
const field = async (tableId: string, name: string, type: string, ts: any, viewId: string) => {
  await delay(60);
  const r = await hit(`field-${name}`, "POST", `/v3/tables/${tableId}/fields`, { name, type, typeSettings: ts, activeViewId: viewId });
  return r.body?.field?.id;
};

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 14: Creative Patterns Mega-Investigation              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // EXP 1: Nested JSON & Array Cell Values (FREE)
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> EXP 1: Nested JSON & Array Cell Values\n");

    const t1 = await hit("1a", "POST", "/v3/tables", { workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-json-cells" });
    const t1Id = t1.body?.table?.id; tablesToClean.push(t1Id);
    await delay(500);
    const s1 = await hit("1b", "GET", `/v3/tables/${t1Id}`);
    const v1 = ((s1.body?.table || s1.body)?.gridViews || [])[0]?.id;

    const jsonFid = await field(t1Id, "Data", "text", { dataTypeSettings: { type: "json" } }, v1);
    const textFid = await field(t1Id, "Name", "text", { dataTypeSettings: { type: "text" } }, v1);

    // Insert rows with complex data types
    await delay(200);
    const jsonRows = await hit("1c", "POST", `/v3/tables/${t1Id}/records`, {
      records: [
        { cells: { [textFid]: "nested-obj", [jsonFid]: JSON.stringify({ name: "Anthropic", meta: { founded: 2021, tags: ["AI", "Safety"] } }) } },
        { cells: { [textFid]: "raw-object", [jsonFid]: { name: "Stripe", revenue: 1000000 } } },  // Object, not string
        { cells: { [textFid]: "array", [jsonFid]: ["alpha", "bravo", "charlie"] } },  // Array directly
        { cells: { [textFid]: "number", [jsonFid]: 42 } },  // Number
        { cells: { [textFid]: "boolean", [jsonFid]: true } },  // Boolean
      ]
    });
    const jsonRowIds = (jsonRows.body?.records || []).map((r: any) => r.id);
    console.log(`  Created ${jsonRowIds.length} rows with different value types`);

    // Create formula columns to extract from each
    const fDeep = await field(t1Id, "F:deep-extract", "formula", { formulaText: `JSON.parse({{${jsonFid}}})?.meta?.tags?.[0]`, formulaType: "text", dataTypeSettings: { type: "text" } }, v1);
    const fDirect = await field(t1Id, "F:direct-access", "formula", { formulaText: `{{${jsonFid}}}?.name`, formulaType: "text", dataTypeSettings: { type: "text" } }, v1);
    const fType = await field(t1Id, "F:raw-type", "formula", { formulaText: `{{${jsonFid}}}?.constructor?.name || "primitive"`, formulaType: "text", dataTypeSettings: { type: "text" } }, v1);
    const fLen = await field(t1Id, "F:length", "formula", { formulaText: `{{${jsonFid}}}?.length`, formulaType: "text", dataTypeSettings: { type: "text" } }, v1);

    await delay(2000);
    // Read each row
    for (const rid of jsonRowIds) {
      const r = await hit(`1d-${rid}`, "GET", `/v3/tables/${t1Id}/records/${rid}`);
      const name = r.body?.cells?.[textFid]?.value;
      const raw = r.body?.cells?.[jsonFid]?.value;
      const deep = r.body?.cells?.[fDeep]?.value;
      const direct = r.body?.cells?.[fDirect]?.value;
      const ftype = r.body?.cells?.[fType]?.value;
      const len = r.body?.cells?.[fLen]?.value;
      console.log(`  ${name}: raw=${JSON.stringify(raw)?.substring(0, 60)}, deep=${deep}, direct=${direct}, type=${ftype}, len=${len}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 2: 10-Column Formula Pipeline (FREE)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 2: 10-Column Formula Pipeline\n");

    const t2 = await hit("2a", "POST", "/v3/tables", { workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-formula-pipeline" });
    const t2Id = t2.body?.table?.id; tablesToClean.push(t2Id);
    await delay(500);
    const s2 = await hit("2b", "GET", `/v3/tables/${t2Id}`);
    const v2 = ((s2.body?.table || s2.body)?.gridViews || [])[0]?.id;

    const fUrl = await field(t2Id, "Input URL", "text", { dataTypeSettings: { type: "url" } }, v2);
    // Chain: each formula references the previous
    const f1 = await field(t2Id, "1:domain", "formula", { formulaText: `{{${fUrl}}}?.match(/https?:\\/\\/([^/]+)/)?.[1] || ""`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f2 = await field(t2Id, "2:no-www", "formula", { formulaText: `{{${f1}}}?.replace("www.", "")`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f3 = await field(t2Id, "3:tld", "formula", { formulaText: `{{${f2}}}?.split(".")?.[{{${f2}}}?.split(".").length - 1]`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f4 = await field(t2Id, "4:is-com", "formula", { formulaText: `{{${f3}}} === "com" ? "commercial" : "other"`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f5 = await field(t2Id, "5:name-part", "formula", { formulaText: `{{${f2}}}?.split(".")?.[0]`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f6 = await field(t2Id, "6:name-upper", "formula", { formulaText: `UPPER({{${f5}}})`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f7 = await field(t2Id, "7:name-len", "formula", { formulaText: `LEN({{${f5}}})`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f8 = await field(t2Id, "8:brand-score", "formula", { formulaText: `{{${f7}}} < 6 ? "short-memorable" : {{${f7}}} < 12 ? "medium" : "long"`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f9 = await field(t2Id, "9:summary", "formula", { formulaText: `{{${f6}}} + " (" + {{${f4}}} + ", " + {{${f8}}} + ")"`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);
    const f10 = await field(t2Id, "10:json-out", "formula", { formulaText: `JSON.stringify({domain: {{${f2}}}, tld: {{${f3}}}, type: {{${f4}}}, brand: {{${f5}}}, score: {{${f8}}}})`, formulaType: "text", dataTypeSettings: { type: "text" } }, v2);

    await delay(200);
    const pipeRow = await hit("2c", "POST", `/v3/tables/${t2Id}/records`, {
      records: [
        { cells: { [fUrl]: "https://www.anthropic.com/research/papers" } },
        { cells: { [fUrl]: "https://stripe.com/payments" } },
        { cells: { [fUrl]: "https://news.ycombinator.com" } },
      ]
    });
    const pipeRowIds = (pipeRow.body?.records || []).map((r: any) => r.id);

    await delay(3000);
    for (const rid of pipeRowIds) {
      const r = await hit(`2d-${rid}`, "GET", `/v3/tables/${t2Id}/records/${rid}`);
      const url = r.body?.cells?.[fUrl]?.value;
      const summary = r.body?.cells?.[f9]?.value;
      const jsonOut = r.body?.cells?.[f10]?.value;
      console.log(`  ${url}`);
      console.log(`    → summary: ${summary}`);
      console.log(`    → json: ${jsonOut}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 3: Circular Route-Row (FREE — tests system safety)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 3: Circular Route-Row (A→B→A)\n");

    const tA = await hit("3a", "POST", "/v3/tables", { workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-loop-A" });
    const tAId = tA.body?.table?.id; tablesToClean.push(tAId);
    await delay(300);
    const sA = await hit("3b", "GET", `/v3/tables/${tAId}`);
    const vA = ((sA.body?.table || sA.body)?.gridViews || [])[0]?.id;
    const fAName = await field(tAId, "Item", "text", { dataTypeSettings: { type: "text" } }, vA);

    const tB = await hit("3c", "POST", "/v3/tables", { workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-loop-B" });
    const tBId = tB.body?.table?.id; tablesToClean.push(tBId);
    await delay(300);

    // A → B route-row
    const rrAB = await field(tAId, "Route to B", "action", {
      actionKey: "route-row", actionPackageId: "b1ab3d5d-b0db-4b30-9251-3f32d8b103c1",
      inputsBinding: [{ name: "tableId", formulaText: `"${tBId}"` }, { name: "rowData", formulaMap: { Item: `{{${fAName}}}` } }],
      dataTypeSettings: { type: "json" }
    }, vA);
    console.log(`  A→B route-row: ${rrAB ? "✅" : "❌"}`);

    // Get B's schema (should have auto-created fields)
    await delay(500);
    const sB = await hit("3d", "GET", `/v3/tables/${tBId}`);
    const tblB = sB.body?.table || sB.body;
    const vB = (tblB?.gridViews || tblB?.views || [])[0]?.id;
    const bItemField = (tblB?.fields || []).find((f: any) => f.name === "Item");
    console.log(`  Table B auto-fields: ${(tblB?.fields || []).map((f: any) => f.name).join(", ")}`);

    // B → A route-row (circular!)
    if (bItemField) {
      const rrBA = await field(tBId, "Route back to A", "action", {
        actionKey: "route-row", actionPackageId: "b1ab3d5d-b0db-4b30-9251-3f32d8b103c1",
        inputsBinding: [{ name: "tableId", formulaText: `"${tAId}"` }, { name: "rowData", formulaMap: { Item: `{{${bItemField.id}}}` } }],
        dataTypeSettings: { type: "json" }
      }, vB);
      console.log(`  B→A route-row: ${rrBA ? "✅" : "❌"}`);
    }

    // Enable autoRun on both
    await hit("3e", "PATCH", `/v3/tables/${tAId}`, { tableSettings: { autoRun: true } });
    await hit("3f", "PATCH", `/v3/tables/${tBId}`, { tableSettings: { autoRun: true } });

    // Insert ONE row in A → trigger chain
    await delay(300);
    await hit("3g", "POST", `/v3/tables/${tAId}/records`, { records: [{ cells: { [fAName]: "loop-test" } }] });
    console.log("  Inserted row in A. Waiting 10s for potential loop...");
    await delay(10000);

    // Check both tables
    const sAView = ((await hit("3h", "GET", `/v3/tables/${tAId}`)).body?.table?.gridViews || [])[0]?.id;
    const sBView = ((await hit("3i", "GET", `/v3/tables/${tBId}`)).body?.table?.gridViews || [])[0]?.id;

    if (sAView) {
      const aRows = await hit("3j", "GET", `/v3/tables/${tAId}/views/${sAView}/records?limit=100`);
      console.log(`  Table A rows: ${(aRows.body?.results || []).length}`);
    }
    if (sBView) {
      const bRows = await hit("3k", "GET", `/v3/tables/${tBId}/views/${sBView}/records?limit=100`);
      console.log(`  Table B rows: ${(bRows.body?.results || []).length}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 4: use-ai Explicit Trigger (1-2 credits)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 4: use-ai with Explicit PATCH /run\n");

    const t4 = await hit("4a", "POST", "/v3/tables", { workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-useai-debug" });
    const t4Id = t4.body?.table?.id; tablesToClean.push(t4Id);
    await delay(500);
    const s4 = await hit("4b", "GET", `/v3/tables/${t4Id}`);
    const v4 = ((s4.body?.table || s4.body)?.gridViews || [])[0]?.id;
    const f4Input = await field(t4Id, "Company", "text", { dataTypeSettings: { type: "text" } }, v4);

    // Try WITHOUT maxCostInCents and with systemPrompt
    const aiCol = await hit("4c", "POST", `/v3/tables/${t4Id}/fields`, {
      name: "AI Answer", type: "action",
      typeSettings: {
        actionKey: "use-ai",
        actionPackageId: "67ba01e9-1898-4e7d-afe7-7ebe24819a57",
        inputsBinding: [
          { name: "systemPrompt", formulaText: `"You are a helpful assistant. Reply in one sentence."` },
          { name: "prompt", formulaText: `"What does " + {{${f4Input}}} + " do?"` },
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: v4
    });
    const aiFid = aiCol.body?.field?.id;
    console.log(`  use-ai column (no model, no maxCost): ${aiCol.status} → ${aiFid || "FAILED"}`);

    // Insert row (NO autoRun — manual trigger)
    await delay(200);
    const aiRow = await hit("4d", "POST", `/v3/tables/${t4Id}/records`, {
      records: [{ cells: { [f4Input]: "Anthropic" } }]
    });
    const aiRowId = aiRow.body?.records?.[0]?.id;

    // Explicit trigger
    if (aiFid && aiRowId) {
      await delay(500);
      const trigger = await hit("4e", "PATCH", `/v3/tables/${t4Id}/run`, {
        runRecords: { recordIds: [aiRowId] }, fieldIds: [aiFid], forceRun: true
      });
      console.log(`  PATCH /run: ${JSON.stringify(trigger.body)}`);

      // Poll
      console.log("  Polling for AI result (6 polls, 5s each)...");
      for (let i = 1; i <= 6; i++) {
        await delay(5000);
        const poll = await hit(`4f-poll-${i}`, "GET", `/v3/tables/${t4Id}/records/${aiRowId}`);
        const aiCell = poll.body?.cells?.[aiFid];
        const status = aiCell?.metadata?.status || aiCell?.metadata?.staleReason || "no-metadata";
        console.log(`  [Poll ${i}] status=${status}, value=${JSON.stringify(aiCell?.value)?.substring(0, 100)}`);
        if (aiCell?.metadata?.status === "SUCCESS" || aiCell?.metadata?.status?.startsWith("ERROR")) {
          console.log(`  DONE! Full metadata: ${JSON.stringify(aiCell?.metadata)}`);
          break;
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 5: PATCH Enrichment to Change Action (FREE to create)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 5: PATCH Enrichment Column to Swap Action\n");

    // Create a normalize column, then try PATCHing it to scrape-website
    const swapCol = await field(t4Id, "Swappable Action", "action", {
      actionKey: "normalize-company-name",
      actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
      inputsBinding: [{ name: "companyName", formulaText: `{{${f4Input}}}` }],
      dataTypeSettings: { type: "json" }
    }, v4);
    console.log(`  Original action: normalize-company-name (${swapCol})`);

    if (swapCol) {
      await delay(200);
      const swap = await hit("5a", "PATCH", `/v3/tables/${t4Id}/fields/${swapCol}`, {
        typeSettings: {
          actionKey: "search-google",
          actionPackageId: "3282a1c7-6bb0-497e-a34b-32268e104e55",
          inputsBinding: [{ name: "query", formulaText: `{{${f4Input}}}` }],
          dataTypeSettings: { type: "json" }
        }
      });
      console.log(`  PATCH to search-google: ${swap.status}`);
      if (swap.status === 200) {
        console.log(`  New actionKey: ${swap.body?.typeSettings?.actionKey || swap.body?.field?.typeSettings?.actionKey || "unknown"}`);
        console.log(`  ✅ ACTION SWAP WORKS!`);
      } else {
        console.log(`  Error: ${JSON.stringify(swap.body).substring(0, 200)}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 6: Cross-Table Lookup Fix (FREE — fix DOMAIN issue)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 6: Cross-Table Lookup — Fixed Input\n");

    // Create ref table
    const tRef = await hit("6a", "POST", "/v3/tables", { workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-lookup-ref" });
    const tRefId = tRef.body?.table?.id; tablesToClean.push(tRefId);
    await delay(500);
    const sRef = await hit("6b", "GET", `/v3/tables/${tRefId}`);
    const vRef = ((sRef.body?.table || sRef.body)?.gridViews || [])[0]?.id;
    const refNameFid = await field(tRefId, "Company", "text", { dataTypeSettings: { type: "text" } }, vRef);
    const refInfoFid = await field(tRefId, "Industry", "text", { dataTypeSettings: { type: "text" } }, vRef);

    await delay(200);
    await hit("6c", "POST", `/v3/tables/${tRefId}/records`, {
      records: [
        { cells: { [refNameFid]: "Anthropic", [refInfoFid]: "AI Safety" } },
        { cells: { [refNameFid]: "Stripe", [refInfoFid]: "Payments" } },
      ]
    });

    // Create lookup on main table — use exact text match, not DOMAIN()
    await delay(200);
    const lookupCol = await hit("6d", "POST", `/v3/tables/${t4Id}/fields`, {
      name: "Industry Lookup", type: "action",
      typeSettings: {
        actionKey: "lookup-field-in-other-table-new-ui",
        actionPackageId: "4299091f-3cd3-4d68-b198-0143575f471d",
        inputsBinding: [
          { name: "tableId", formulaText: `"${tRefId}"` },
          { name: "targetColumn", formulaText: `"${refNameFid}"` },
          { name: "filterOperator", formulaText: `"equals"` },
          { name: "recordValue", formulaText: `{{${f4Input}}}` },
        ],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: v4
    });
    const lookupFid = lookupCol.body?.field?.id;
    console.log(`  lookup column: ${lookupCol.status} → ${lookupFid || "FAILED"}`);

    // Trigger lookup
    if (lookupFid && aiRowId) {
      await delay(500);
      await hit("6e", "PATCH", `/v3/tables/${t4Id}/run`, {
        runRecords: { recordIds: [aiRowId] }, fieldIds: [lookupFid], forceRun: true
      });
      await delay(5000);
      const lookupResult = await hit("6f", "GET", `/v3/tables/${t4Id}/records/${aiRowId}`);
      const lookupCell = lookupResult.body?.cells?.[lookupFid];
      console.log(`  Lookup result: status=${lookupCell?.metadata?.status}, value=${JSON.stringify(lookupCell?.value)?.substring(0, 200)}`);
    }

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-14-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
