/**
 * Investigation: View CRUD
 *
 * Solves TODO-010 (view create/update/delete), column reorder,
 * and potentially provides pagination workaround via filtered views.
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-view-crud.ts
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
  console.log("║  Investigation: View CRUD                                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  let testTableId: string | null = null;

  try {
    // ── Step 1: Create test table ──────────────────────────────────────
    console.log(">>> Step 1: Creating test table...");
    const createTable = await hit("1-create-table", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "INV-view-crud-test"
    });
    const table = createTable.body?.table || createTable.body;
    testTableId = table?.id;
    if (!testTableId) { console.error("Failed to create table"); return; }

    await delay(500);
    const schema = await hit("1b-schema", "GET", `/v3/tables/${testTableId}`);
    const tableObj = schema.body?.table || schema.body;
    const views = tableObj?.gridViews || tableObj?.views || [];
    console.log(`  Table: ${testTableId}`);
    console.log(`  Default views (${views.length}):`);
    for (const v of views) {
      console.log(`    ${v.id}: "${v.name}" (filter: ${JSON.stringify(v.filter)}, sort: ${JSON.stringify(v.sort)})`);
    }

    const defaultViewId = views[0]?.id;

    // ── Step 2: Probe view creation endpoints ─────────────────────────
    console.log("\n>>> Step 2: Probing view creation endpoints...");

    // 2a: POST /v3/tables/{id}/views
    const create2a = await hit("2a-post-table-views", "POST", `/v3/tables/${testTableId}/views`, {
      name: "Custom View A"
    });
    console.log(`  POST /v3/tables/{id}/views: ${create2a.status} — ${JSON.stringify(create2a.body).substring(0, 300)}`);

    await delay(200);

    // 2b: POST /v3/views
    const create2b = await hit("2b-post-views", "POST", "/v3/views", {
      tableId: testTableId,
      name: "Custom View B"
    });
    console.log(`  POST /v3/views: ${create2b.status} — ${JSON.stringify(create2b.body).substring(0, 300)}`);

    await delay(200);

    // 2c: POST /v3/tables/{id}/grid-views
    const create2c = await hit("2c-post-grid-views", "POST", `/v3/tables/${testTableId}/grid-views`, {
      name: "Custom View C"
    });
    console.log(`  POST /v3/tables/{id}/grid-views: ${create2c.status} — ${JSON.stringify(create2c.body).substring(0, 300)}`);

    await delay(200);

    // 2d: POST /v3/grid-views
    const create2d = await hit("2d-post-grid-views-root", "POST", "/v3/grid-views", {
      tableId: testTableId,
      name: "Custom View D"
    });
    console.log(`  POST /v3/grid-views: ${create2d.status} — ${JSON.stringify(create2d.body).substring(0, 300)}`);

    // Check if any view was created
    await delay(500);
    const schemaAfterCreate = await hit("2e-schema-after-create", "GET", `/v3/tables/${testTableId}`);
    const viewsAfterCreate = (schemaAfterCreate.body?.table || schemaAfterCreate.body)?.gridViews || [];
    console.log(`  Views after creation attempts: ${viewsAfterCreate.length} (was ${views.length})`);
    for (const v of viewsAfterCreate) {
      if (!views.find((ov: any) => ov.id === v.id)) {
        console.log(`    NEW VIEW: ${v.id} "${v.name}"`);
      }
    }

    // ── Step 3: Probe view update endpoints ──────────────────────────
    console.log("\n>>> Step 3: Probing view update endpoints...");

    // 3a: PATCH /v3/tables/{id}/views/{viewId}
    const update3a = await hit("3a-patch-table-view", "PATCH", `/v3/tables/${testTableId}/views/${defaultViewId}`, {
      name: "Renamed View"
    });
    console.log(`  PATCH /v3/tables/{id}/views/{viewId}: ${update3a.status} — ${JSON.stringify(update3a.body).substring(0, 300)}`);

    await delay(200);

    // 3b: PATCH /v3/views/{viewId}
    const update3b = await hit("3b-patch-view", "PATCH", `/v3/views/${defaultViewId}`, {
      name: "Renamed View 2"
    });
    console.log(`  PATCH /v3/views/{viewId}: ${update3b.status} — ${JSON.stringify(update3b.body).substring(0, 300)}`);

    await delay(200);

    // 3c: PATCH /v3/grid-views/{viewId}
    const update3c = await hit("3c-patch-grid-view", "PATCH", `/v3/grid-views/${defaultViewId}`, {
      name: "Renamed View 3"
    });
    console.log(`  PATCH /v3/grid-views/{viewId}: ${update3c.status} — ${JSON.stringify(update3c.body).substring(0, 300)}`);

    await delay(200);

    // 3d: PUT /v3/tables/{id}/views/{viewId}
    const update3d = await hit("3d-put-table-view", "PUT", `/v3/tables/${testTableId}/views/${defaultViewId}`, {
      name: "Renamed View 4"
    });
    console.log(`  PUT /v3/tables/{id}/views/{viewId}: ${update3d.status} — ${JSON.stringify(update3d.body).substring(0, 300)}`);

    // ── Step 4: Probe view filter modification ───────────────────────
    console.log("\n>>> Step 4: Probing filter modification...");

    // Try setting a filter on a view
    const filterPayload = {
      filter: {
        items: [{ type: "NOT_EMPTY", fieldId: "f_created_at" }],
        combinationMode: "AND"
      }
    };

    // 4a: Via table view endpoint
    const filter4a = await hit("4a-filter-table-view", "PATCH", `/v3/tables/${testTableId}/views/${defaultViewId}`, filterPayload);
    console.log(`  PATCH view with filter: ${filter4a.status} — ${JSON.stringify(filter4a.body).substring(0, 300)}`);

    await delay(200);

    // 4b: Via grid-views endpoint
    const filter4b = await hit("4b-filter-grid-view", "PATCH", `/v3/grid-views/${defaultViewId}`, filterPayload);
    console.log(`  PATCH grid-view with filter: ${filter4b.status} — ${JSON.stringify(filter4b.body).substring(0, 300)}`);

    // ── Step 5: Probe sort modification ──────────────────────────────
    console.log("\n>>> Step 5: Probing sort modification...");
    const fields = (schemaAfterCreate.body?.table || schemaAfterCreate.body)?.fields || [];
    const createdAtField = fields.find((f: any) => f.name === "Created At" || f.id === "f_created_at");

    if (createdAtField) {
      const sortPayload = {
        sort: { items: [{ fieldId: createdAtField.id, direction: "DESC" }] }
      };

      const sort5a = await hit("5a-sort-table-view", "PATCH", `/v3/tables/${testTableId}/views/${defaultViewId}`, sortPayload);
      console.log(`  PATCH view with sort: ${sort5a.status} — ${JSON.stringify(sort5a.body).substring(0, 300)}`);

      await delay(200);

      const sort5b = await hit("5b-sort-grid-view", "PATCH", `/v3/grid-views/${defaultViewId}`, sortPayload);
      console.log(`  PATCH grid-view with sort: ${sort5b.status} — ${JSON.stringify(sort5b.body).substring(0, 300)}`);
    }

    // ── Step 6: Probe view deletion ─────────────────────────────────
    console.log("\n>>> Step 6: Probing view deletion...");

    // Pick a non-default view to try deleting
    const viewToDelete = viewsAfterCreate.find((v: any) => v.id !== defaultViewId) || viewsAfterCreate[1];
    if (viewToDelete) {
      const del6a = await hit("6a-delete-table-view", "DELETE", `/v3/tables/${testTableId}/views/${viewToDelete.id}`);
      console.log(`  DELETE /v3/tables/{id}/views/{viewId}: ${del6a.status} — ${JSON.stringify(del6a.body).substring(0, 200)}`);

      await delay(200);

      // Try another view with root endpoint
      const viewToDelete2 = viewsAfterCreate.find((v: any) => v.id !== defaultViewId && v.id !== viewToDelete.id);
      if (viewToDelete2) {
        const del6b = await hit("6b-delete-view", "DELETE", `/v3/views/${viewToDelete2.id}`);
        console.log(`  DELETE /v3/views/{viewId}: ${del6b.status} — ${JSON.stringify(del6b.body).substring(0, 200)}`);

        await delay(200);

        const del6c = await hit("6c-delete-grid-view", "DELETE", `/v3/grid-views/${viewToDelete2.id}`);
        console.log(`  DELETE /v3/grid-views/{viewId}: ${del6c.status} — ${JSON.stringify(del6c.body).substring(0, 200)}`);
      }
    }

    // ── Step 7: GET specific view ───────────────────────────────────
    console.log("\n>>> Step 7: Probing GET view endpoints...");
    const get7a = await hit("7a-get-table-views", "GET", `/v3/tables/${testTableId}/views`);
    console.log(`  GET /v3/tables/{id}/views: ${get7a.status}`);

    const get7b = await hit("7b-get-view", "GET", `/v3/views/${defaultViewId}`);
    console.log(`  GET /v3/views/{viewId}: ${get7b.status}`);

    const get7c = await hit("7c-get-grid-view", "GET", `/v3/grid-views/${defaultViewId}`);
    console.log(`  GET /v3/grid-views/{viewId}: ${get7c.status} — ${JSON.stringify(get7c.body).substring(0, 300)}`);

    // ── Final schema check ──────────────────────────────────────────
    console.log("\n>>> Final: Schema after all probes...");
    const finalSchema = await hit("final-schema", "GET", `/v3/tables/${testTableId}`);
    const finalViews = (finalSchema.body?.table || finalSchema.body)?.gridViews || [];
    console.log(`  Final view count: ${finalViews.length}`);
    for (const v of finalViews) {
      console.log(`    ${v.id}: "${v.name}" filter=${JSON.stringify(v.filter)} sort=${JSON.stringify(v.sort)}`);
    }

  } finally {
    if (testTableId) {
      console.log(`\n>>> Cleanup: Deleting test table ${testTableId}...`);
      await delay(500);
      await hit("cleanup-delete", "DELETE", `/v3/tables/${testTableId}`);
    }

    const outputFile = path.join(__dirname, "..", "results", `investigate-view-crud-${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${outputFile}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
