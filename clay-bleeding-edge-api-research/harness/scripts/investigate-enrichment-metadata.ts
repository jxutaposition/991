/**
 * Investigation: Enrichment Cell Metadata (Retry)
 *
 * Instead of creating enrichments from scratch, find existing tables
 * with completed enrichments and inspect their cell metadata states.
 * Then attempt a real enrichment trigger + poll cycle.
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-enrichment-metadata.ts
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
  console.log("║  Investigation: Enrichment Cell Metadata (via existing tables)  ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  // ── Part 1: Scan existing tables for enrichment columns ────────────
  console.log(">>> Part 1: Scanning workspace tables for enrichment data...\n");

  const tables = await hit("1-tables", "GET", `/v3/workspaces/${WORKSPACE}/tables`);
  const tableList = tables.body?.results || [];
  console.log(`  ${tableList.length} tables in workspace`);

  const enrichmentTables: { tableId: string; tableName: string; viewId: string; actionFields: any[] }[] = [];

  for (const t of tableList.slice(0, 15)) { // scan up to 15 tables
    await delay(50);
    const schema = await hit(`1-schema-${t.id}`, "GET", `/v3/tables/${t.id}`);
    if (schema.status !== 200) continue;

    const tableObj = schema.body?.table || schema.body;
    const fields = tableObj?.fields || [];
    const views = tableObj?.gridViews || tableObj?.views || [];
    const actionFields = fields.filter((f: any) => f.type === "action");

    if (actionFields.length > 0 && views.length > 0) {
      enrichmentTables.push({
        tableId: t.id,
        tableName: t.name,
        viewId: views.find((v: any) => v.name === "All rows")?.id || views[0]?.id,
        actionFields
      });
      console.log(`  ✓ ${t.name} (${t.id}): ${actionFields.length} action columns`);
      for (const af of actionFields) {
        console.log(`    - ${af.name} (${af.id}): actionKey=${af.typeSettings?.actionKey}, authAccountId=${af.typeSettings?.authAccountId}`);
      }
    }
  }

  if (enrichmentTables.length === 0) {
    console.log("  No tables with enrichment columns found. Cannot inspect metadata.");
    return;
  }

  // ── Part 2: Read rows from enrichment tables, inspect metadata ─────
  console.log("\n>>> Part 2: Reading rows from tables with enrichments...\n");

  const allStatuses = new Set<string>();

  for (const et of enrichmentTables.slice(0, 3)) {
    console.log(`\n  ── Table: ${et.tableName} (${et.tableId}) ──`);

    const rows = await hit(`2-rows-${et.tableId}`, "GET",
      `/v3/tables/${et.tableId}/views/${et.viewId}/records?limit=20`);
    const records = rows.body?.results || [];
    console.log(`  ${records.length} rows loaded`);

    for (const row of records.slice(0, 5)) {
      console.log(`\n  Row ${row.id}:`);
      console.log(`    recordMetadata: ${JSON.stringify(row.recordMetadata)}`);

      for (const af of et.actionFields) {
        const cell = row.cells?.[af.id];
        if (cell) {
          const status = cell.metadata?.status;
          const hasValue = cell.value !== null && cell.value !== undefined;
          const valuePreview = hasValue ? JSON.stringify(cell.value).substring(0, 100) : "null";
          console.log(`    [${af.name}] status=${status || "none"}, hasValue=${hasValue}, value=${valuePreview}`);
          console.log(`      FULL metadata: ${JSON.stringify(cell.metadata)}`);
          if (status) allStatuses.add(status);
        } else {
          console.log(`    [${af.name}] cell=undefined (not in response)`);
        }
      }
    }

    // Also check non-"All rows" views for different metadata
    const errorViewId = enrichmentTables[0]?.viewId; // just use the same for now
    // Try the "Errored rows" view if it exists
    const schema = await hit(`2-schema-${et.tableId}`, "GET", `/v3/tables/${et.tableId}`);
    const tableObj = schema.body?.table || schema.body;
    const views = tableObj?.gridViews || tableObj?.views || [];
    const errorView = views.find((v: any) => v.name === "Errored rows");
    if (errorView) {
      console.log(`\n  ── Errored rows view (${errorView.id}) ──`);
      const errorRows = await hit(`2-error-rows-${et.tableId}`, "GET",
        `/v3/tables/${et.tableId}/views/${errorView.id}/records?limit=5`);
      const errorRecords = errorRows.body?.results || [];
      console.log(`  ${errorRecords.length} errored rows`);
      for (const row of errorRecords.slice(0, 3)) {
        console.log(`\n  Error Row ${row.id}:`);
        console.log(`    recordMetadata: ${JSON.stringify(row.recordMetadata)}`);
        for (const af of et.actionFields) {
          const cell = row.cells?.[af.id];
          if (cell) {
            console.log(`    [${af.name}] status=${cell.metadata?.status}, FULL metadata: ${JSON.stringify(cell.metadata)}`);
            console.log(`      value: ${JSON.stringify(cell.value)?.substring(0, 200)}`);
            if (cell.metadata?.status) allStatuses.add(cell.metadata.status);
          }
        }
      }
    }
  }

  // ── Part 3: Now try creating an enrichment column with correct format ──
  console.log("\n\n>>> Part 3: Creating enrichment column with correct payload...\n");

  // Find the exact format from an existing enrichment column
  let templateField: any = null;
  for (const et of enrichmentTables) {
    for (const af of et.actionFields) {
      if (af.typeSettings?.actionKey && af.typeSettings?.actionPackageId) {
        templateField = af;
        break;
      }
    }
    if (templateField) break;
  }

  if (templateField) {
    console.log(`  Template field found: ${templateField.name}`);
    console.log(`  Full typeSettings: ${JSON.stringify(templateField.typeSettings, null, 2)}`);
  } else {
    console.log("  No template field found with actionPackageId");
  }

  // Create a test table and enrichment column using exact format from existing
  let testTableId: string | null = null;
  try {
    const createTable = await hit("3-create-table", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "INV-enrichment-metadata-test"
    });
    const table = createTable.body?.table || createTable.body;
    testTableId = table?.id;
    if (!testTableId) { console.log("Failed to create test table"); return; }

    await delay(500);
    const schema = await hit("3b-schema", "GET", `/v3/tables/${testTableId}`);
    const tableObj = schema.body?.table || schema.body;
    const viewId = (tableObj?.gridViews || tableObj?.views || [])[0]?.id;

    // Create text column
    const textCol = await hit("3c-text-col", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Company Name",
      type: "text",
      typeSettings: { dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const textFieldId = textCol.body?.field?.id || textCol.body?.id;

    await delay(200);

    // Find a good action to use — get the full actions list and pick one with known working format
    const actionsResp = await hit("3d-actions", "GET", `/v3/actions?workspaceId=${WORKSPACE}`);
    const actions = actionsResp.body?.actions || actionsResp.body || [];

    // Find "claygpt-text-to-domain" or similar simple action
    const simpleActions = actions.filter((a: any) =>
      ["claygpt-text-to-domain", "find-company-domain", "normalize-company-name", "google-search-companies"].includes(a.key)
    );
    console.log(`  Simple actions found: ${simpleActions.map((a: any) => `${a.key}(pkg:${a.package?.id})`).join(", ")}`);

    // Also list all actions that don't need auth
    const noAuthActions = actions.filter((a: any) => !a.auth?.providerType).slice(0, 10);
    console.log(`  No-auth actions (first 10): ${noAuthActions.map((a: any) => a.key).join(", ")}`);

    // Try creating with each candidate until one works
    for (const action of simpleActions.concat(noAuthActions.slice(0, 3))) {
      const inputProps = action.inputParameterSchema?.properties || {};
      const firstInput = Object.keys(inputProps)[0];
      if (!firstInput) continue;

      // Get authAccountId if needed
      let authAccountId: string | undefined;
      if (action.auth?.providerType) {
        const accounts = (await hit(`3e-accounts-${action.key}`, "GET", "/v3/app-accounts")).body || [];
        const match = accounts.find((a: any) => a.appAccountTypeId === action.auth.providerType);
        authAccountId = match?.id;
        if (!authAccountId) continue; // skip if no auth available
      }

      console.log(`\n  Trying action: ${action.key} (package: ${action.package?.id})`);
      console.log(`    Input: ${firstInput}, Auth: ${authAccountId || "none"}`);

      const enrichResp = await hit(`3f-enrich-${action.key}`, "POST", `/v3/tables/${testTableId}/fields`, {
        name: `Enrich: ${action.displayName || action.key}`,
        type: "action",
        typeSettings: {
          actionKey: action.key,
          actionVersion: action.version || undefined,
          actionPackageId: action.package?.id,
          authAccountId: authAccountId || undefined,
          inputsBinding: [
            { name: firstInput, formulaText: `{{${textFieldId}}}` }
          ],
          dataTypeSettings: { type: "json" },
          useStaticIP: false,
        },
        activeViewId: viewId
      });

      const enrichFieldId = enrichResp.body?.field?.id || enrichResp.body?.id;
      console.log(`    Result: ${enrichResp.status} — ${JSON.stringify(enrichResp.body).substring(0, 300)}`);

      if (enrichFieldId) {
        console.log(`    SUCCESS! Enrichment column created: ${enrichFieldId}`);

        // Seed rows and trigger
        await delay(300);
        const seedResp = await hit("3g-seed", "POST", `/v3/tables/${testTableId}/records`, {
          records: [
            { cells: { [textFieldId]: "Google" } },
            { cells: { [textFieldId]: "Microsoft" } },
          ]
        });
        const recordIds = (seedResp.body?.records || []).map((r: any) => r.id);
        console.log(`    Seeded ${recordIds.length} rows`);

        // Trigger enrichment
        await delay(500);
        const triggerResp = await hit("3h-trigger", "PATCH", `/v3/tables/${testTableId}/run`, {
          runRecords: { recordIds },
          fieldIds: [enrichFieldId],
          forceRun: true
        });
        console.log(`    TRIGGER RESPONSE: ${JSON.stringify(triggerResp.body)}`);

        // Poll for status
        console.log("    Polling for status changes (10 polls, 2s each)...");
        for (let i = 1; i <= 10; i++) {
          await delay(2000);
          const pollResp = await hit(`3i-poll-${i}`, "GET",
            `/v3/tables/${testTableId}/views/${viewId}/records?limit=10`);
          const pollRows = pollResp.body?.results || [];

          for (const row of pollRows) {
            const cell = row.cells?.[enrichFieldId];
            const status = cell?.metadata?.status || "no-status";
            const hasValue = cell?.value !== null && cell?.value !== undefined;
            console.log(`    [Poll ${i}] Row ${row.id}: status=${status}, hasValue=${hasValue}`);
            if (cell?.metadata) {
              console.log(`      metadata: ${JSON.stringify(cell.metadata)}`);
              allStatuses.add(status);
            }
            console.log(`      recordMetadata: ${JSON.stringify(row.recordMetadata)}`);
          }

          // Check if all done
          const allDone = pollRows.every((r: any) => {
            const cell = r.cells?.[enrichFieldId];
            return cell?.metadata?.status === "SUCCESS" || cell?.metadata?.status === "ERROR";
          });
          if (allDone && i >= 2) {
            console.log(`    All rows completed after poll ${i}`);
            break;
          }
        }

        break; // success, stop trying other actions
      }
    }

  } finally {
    if (testTableId) {
      console.log(`\n>>> Cleanup: Deleting test table ${testTableId}...`);
      await delay(500);
      await hit("cleanup", "DELETE", `/v3/tables/${testTableId}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\n\n>>> SUMMARY: All metadata.status values observed:");
  console.log(`  ${Array.from(allStatuses).join(", ") || "none found"}`);

  const outputFile = path.join(__dirname, "..", "results", `investigate-enrichment-metadata-${Date.now()}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outputFile}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
