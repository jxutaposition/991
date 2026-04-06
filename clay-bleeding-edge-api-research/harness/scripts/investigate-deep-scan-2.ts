/**
 * Deep Investigation 2: View Filter/Sort + Advanced Table Operations
 *
 * Focuses on:
 *   - View filter/sort payload format (TODO-010 - the last unsolved API TODO)
 *   - Table auto-run settings
 *   - Conditional enrichment run formulas
 *   - Field group operations
 *   - Record deduplication mechanics
 *   - View deletion
 *   - Workbook settings/annotations
 *   - Table creation within specific workbooks
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-deep-scan-2.ts
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
    const r: ProbeResult = { probe, method, url, status: resp.status, latencyMs: ms, body: b };
    results.push(r);
    return r;
  } catch (err: any) {
    const r: ProbeResult = { probe, method, url, status: 0, latencyMs: Date.now() - start, body: null, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Deep Investigation 2: View Filters + Advanced Table Ops       ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  let testTableId: string | null = null;

  try {
    // ── Step 1: Create test table with data ──────────────────────────
    console.log(">>> Step 1: Creating test table with data...");
    const createTable = await hit("1-create", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "INV-deep-scan-2-test"
    });
    const table = createTable.body?.table || createTable.body;
    testTableId = table?.id;
    if (!testTableId) { console.error("Failed to create table"); return; }

    await delay(500);
    const schema = await hit("1b-schema", "GET", `/v3/tables/${testTableId}`);
    const tableObj = schema.body?.table || schema.body;
    const views = tableObj?.gridViews || tableObj?.views || [];
    const defaultView = views.find((v: any) => v.name === "Default view") || views[0];
    const allRowsView = views.find((v: any) => v.name === "All rows");
    console.log(`  Table: ${testTableId}, Default view: ${defaultView?.id}`);
    console.log(`  Views: ${views.map((v: any) => `${v.id}:"${v.name}"`).join(", ")}`);

    // Dump FULL first view structure for reference
    console.log(`\n  FULL default view structure:\n${JSON.stringify(defaultView, null, 2)}`);

    // Create columns
    const textCol = await hit("1c-text", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Company", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: defaultView?.id
    });
    const textFieldId = textCol.body?.field?.id || textCol.body?.id;

    await delay(100);
    const numCol = await hit("1d-num", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Score", type: "text", typeSettings: { dataTypeSettings: { type: "number" } }, activeViewId: defaultView?.id
    });
    const numFieldId = numCol.body?.field?.id || numCol.body?.id;

    // Insert rows
    await delay(200);
    await hit("1e-rows", "POST", `/v3/tables/${testTableId}/records`, {
      records: [
        { cells: { [textFieldId]: "Alpha Corp", [numFieldId]: "90" } },
        { cells: { [textFieldId]: "Beta Inc", [numFieldId]: "45" } },
        { cells: { [textFieldId]: "", [numFieldId]: "0" } },  // empty for filter testing
        { cells: { [textFieldId]: "Delta LLC", [numFieldId]: "75" } },
      ]
    });

    // Re-read schema to get updated field IDs
    await delay(300);
    const schema2 = await hit("1f-schema2", "GET", `/v3/tables/${testTableId}`);
    const tableObj2 = schema2.body?.table || schema2.body;
    const updatedViews = tableObj2?.gridViews || tableObj2?.views || [];
    const updatedDefaultView = updatedViews.find((v: any) => v.name === "Default view") || updatedViews[0];

    // ── Step 2: View Filter Experiments ──────────────────────────────
    console.log("\n>>> Step 2: View filter experiments...");

    // First, study the existing "Errored rows" view filter format (if it exists)
    const errorView = updatedViews.find((v: any) => v.name === "Errored rows");
    if (errorView) {
      console.log(`  Errored rows view filter: ${JSON.stringify(errorView.filter)}`);
      console.log(`  Errored rows view typeSettings: ${JSON.stringify(errorView.typeSettings)}`);
    }

    // Study the "Fully enriched rows" view
    const enrichedView = updatedViews.find((v: any) => v.name === "Fully enriched rows");
    if (enrichedView) {
      console.log(`  Enriched rows view filter: ${JSON.stringify(enrichedView.filter)}`);
      console.log(`  Enriched rows view typeSettings: ${JSON.stringify(enrichedView.typeSettings)}`);
    }

    // Create a new view to experiment with
    const newView = await hit("2a-create-view", "POST", `/v3/tables/${testTableId}/views`, {
      name: "Filter Test View"
    });
    const newViewId = newView.body?.id;
    console.log(`  Created test view: ${newViewId}`);
    console.log(`  New view full: ${JSON.stringify(newView.body)}`);

    if (newViewId) {
      // Try MANY different filter payload formats
      const filterFormats = [
        // Format 1: Exact structure from existing views
        { name: "format1-exact", payload: {
          filter: { items: [{ type: "NOT_EMPTY", fieldId: textFieldId }], combinationMode: "AND" }
        }},
        // Format 2: With filterType in items
        { name: "format2-filterType", payload: {
          filter: { items: [{ filterType: "Filter", type: "NOT_EMPTY", fieldId: textFieldId }], combinationMode: "AND" }
        }},
        // Format 3: With id in items
        { name: "format3-withId", payload: {
          filter: { items: [{ id: "filter_1", type: "NOT_EMPTY", fieldId: textFieldId }], combinationMode: "AND" }
        }},
        // Format 4: Group wrapper
        { name: "format4-group", payload: {
          filter: { filterType: "Group", items: [{ type: "NOT_EMPTY", fieldId: textFieldId }], combinationMode: "AND" }
        }},
        // Format 5: Flat filter
        { name: "format5-flat", payload: {
          filter: [{ type: "NOT_EMPTY", fieldId: textFieldId }]
        }},
        // Format 6: String-value filter
        { name: "format6-string", payload: {
          filter: JSON.stringify({ items: [{ type: "NOT_EMPTY", fieldId: textFieldId }], combinationMode: "AND" })
        }},
        // Format 7: With view name (maybe filter needs to be set at creation time?)
        { name: "format7-update-name-and-filter", payload: {
          name: "Filtered View",
          filter: { items: [{ type: "NOT_EMPTY", fieldId: textFieldId }], combinationMode: "AND" }
        }},
      ];

      for (const fmt of filterFormats) {
        await delay(200);
        const resp = await hit(`2b-${fmt.name}`, "PATCH", `/v3/tables/${testTableId}/views/${newViewId}`, fmt.payload);
        console.log(`  ${fmt.name}: status=${resp.status}, filter=${JSON.stringify(resp.body?.filter)}`);
      }

      // Now try creating a NEW view WITH filter baked in
      console.log("\n  Trying view creation with filter included...");
      const viewWithFilter = await hit("2c-create-with-filter", "POST", `/v3/tables/${testTableId}/views`, {
        name: "Pre-filtered View",
        filter: { items: [{ type: "NOT_EMPTY", fieldId: textFieldId }], combinationMode: "AND" }
      });
      const filteredViewId = viewWithFilter.body?.id;
      console.log(`  Create with filter: status=${viewWithFilter.status}, filter=${JSON.stringify(viewWithFilter.body?.filter)}`);

      // Try sort payloads
      console.log("\n  Trying sort payloads...");
      const sortFormats = [
        { name: "sort1-items", payload: { sort: { items: [{ fieldId: textFieldId, direction: "ASC" }] } } },
        { name: "sort2-flat", payload: { sort: [{ fieldId: textFieldId, direction: "DESC" }] } },
        { name: "sort3-string", payload: { sort: JSON.stringify({ items: [{ fieldId: textFieldId, direction: "ASC" }] }) } },
        { name: "sort4-field-direct", payload: { sort: { fieldId: textFieldId, direction: "ASC" } } },
      ];

      for (const fmt of sortFormats) {
        await delay(200);
        const resp = await hit(`2d-${fmt.name}`, "PATCH", `/v3/tables/${testTableId}/views/${newViewId}`, fmt.payload);
        console.log(`  ${fmt.name}: status=${resp.status}, sort=${JSON.stringify(resp.body?.sort)}`);
      }

      // Try updating fields (column visibility/order)
      console.log("\n  Trying field visibility/order...");
      const fieldPayloads = [
        { name: "fields1-visibility", payload: {
          fields: { [textFieldId]: { isVisible: true, order: "a", width: 300 } }
        }},
        { name: "fields2-reorder", payload: {
          fields: {
            [numFieldId]: { order: "a", isVisible: true, width: 150 },
            [textFieldId]: { order: "b", isVisible: true, width: 250 }
          }
        }},
      ];

      for (const fmt of fieldPayloads) {
        await delay(200);
        const resp = await hit(`2e-${fmt.name}`, "PATCH", `/v3/tables/${testTableId}/views/${newViewId}`, fmt.payload);
        const respFields = resp.body?.fields;
        console.log(`  ${fmt.name}: status=${resp.status}`);
        if (respFields) {
          console.log(`    fields: ${JSON.stringify(respFields).substring(0, 300)}`);
        }
      }

      // Read rows through the (hopefully) filtered view
      if (filteredViewId) {
        await delay(300);
        const filteredRows = await hit("2f-read-filtered", "GET", `/v3/tables/${testTableId}/views/${filteredViewId}/records?limit=10`);
        const rows = filteredRows.body?.results || [];
        console.log(`  Rows via filtered view: ${rows.length} (expect 3 if filter applied, 4 if not)`);
      }

      // Try view deletion
      console.log("\n  Trying view deletion...");
      if (filteredViewId) {
        const delResp = await hit("2g-delete-view", "DELETE", `/v3/tables/${testTableId}/views/${filteredViewId}`);
        console.log(`  DELETE view: ${delResp.status} — ${JSON.stringify(delResp.body).substring(0, 200)}`);
      }
    }

    // ── Step 3: Table Settings ───────────────────────────────────────
    console.log("\n>>> Step 3: Table settings manipulation...");

    // Try PATCH table with settings
    const settingsPayloads = [
      { name: "autoRun", payload: { tableSettings: { autoRun: true } } },
      { name: "dedupe", payload: { tableSettings: { dedupeFieldId: textFieldId } } },
      { name: "description", payload: { description: "Test table for deep scan" } },
    ];

    for (const s of settingsPayloads) {
      await delay(100);
      const resp = await hit(`3-${s.name}`, "PATCH", `/v3/tables/${testTableId}`, s.payload);
      console.log(`  PATCH with ${s.name}: ${resp.status}, tableSettings=${JSON.stringify(resp.body?.tableSettings || resp.body?.table?.tableSettings)}`);
    }

    // ── Step 4: Workbook operations ──────────────────────────────────
    console.log("\n>>> Step 4: Advanced workbook operations...");
    const workbookId = tableObj?.workbookId;
    if (workbookId) {
      // Try PATCH on workbook via workspace path
      const wbProbes = [
        ["PATCH", `/v3/workspaces/${WORKSPACE}/workbooks/${workbookId}`, { name: "Renamed WB" }],
        ["GET", `/v3/workspaces/${WORKSPACE}/workbooks/${workbookId}`],
        ["DELETE", `/v3/workspaces/${WORKSPACE}/workbooks/${workbookId}`],
      ];
      for (const [method, path, body] of wbProbes) {
        await delay(100);
        const resp = await hit("4-wb", method as string, path as string, body);
        console.log(`  ${method} ${(path as string).replace(WORKSPACE, "{ws}").replace(workbookId, "{wb}")}: ${resp.status} — ${JSON.stringify(resp.body).substring(0, 200)}`);
      }
    }

    // ── Step 5: Field operations ─────────────────────────────────────
    console.log("\n>>> Step 5: Advanced field operations...");

    // Try field reorder via table PATCH
    const reorderPayloads = [
      { name: "fieldOrder", payload: { fieldOrder: [numFieldId, textFieldId] } },
      { name: "fieldGroupMap", payload: { fieldGroupMap: { "Group A": [textFieldId], "Group B": [numFieldId] } } },
    ];
    for (const p of reorderPayloads) {
      await delay(100);
      const resp = await hit(`5-${p.name}`, "PATCH", `/v3/tables/${testTableId}`, p.payload);
      console.log(`  PATCH with ${p.name}: ${resp.status}`);
    }

    // ── Final schema dump ────────────────────────────────────────────
    console.log("\n>>> Final schema dump...");
    await delay(300);
    const finalSchema = await hit("final-schema", "GET", `/v3/tables/${testTableId}`);
    const finalObj = finalSchema.body?.table || finalSchema.body;
    console.log(`  tableSettings: ${JSON.stringify(finalObj?.tableSettings)}`);
    console.log(`  description: ${finalObj?.description}`);
    console.log(`  fieldGroupMap: ${JSON.stringify(finalObj?.fieldGroupMap)}`);
    console.log(`  views (${(finalObj?.gridViews || finalObj?.views || []).length}):`);
    for (const v of (finalObj?.gridViews || finalObj?.views || [])) {
      console.log(`    ${v.id}: "${v.name}" filter=${JSON.stringify(v.filter)} sort=${JSON.stringify(v.sort)}`);
    }

  } finally {
    if (testTableId) {
      console.log(`\n>>> Cleanup: Deleting test table ${testTableId}...`);
      await delay(500);
      await hit("cleanup", "DELETE", `/v3/tables/${testTableId}`);
    }

    const outputFile = path.join(__dirname, "..", "results", `investigate-deep-scan-2-${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${outputFile}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
