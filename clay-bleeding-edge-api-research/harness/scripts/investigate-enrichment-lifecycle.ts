/**
 * Investigation: Enrichment Lifecycle
 *
 * Solves TODO-004 (completion monitoring), TODO-005 (error states),
 * TODO-011 (cell metadata), TODO-014 (trigger response).
 *
 * Approach:
 *   1. Create a test table with a text column + enrichment action column
 *   2. Seed rows with real data
 *   3. Capture the FULL trigger response
 *   4. Poll rows every 2s, logging cell metadata.status transitions
 *   5. Document the enrichment state machine
 *   6. Clean up
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-enrichment-lifecycle.ts
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

function log(r: ProbeResult) {
  const preview = r.body ? JSON.stringify(r.body).substring(0, 400) : "(empty)";
  console.log(`[${r.probe}] ${r.status} (${r.latencyMs}ms) ${preview}`);
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Investigation: Enrichment Lifecycle                            ║");
  console.log("╚═══════════════════════���══════════════════════════════════════════╝");

  // Verify session
  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  let testTableId: string | null = null;

  try {
    // ── Step 1: Find a suitable enrichment action ──────────────────────
    console.log(">>> Step 1: Finding a cheap enrichment action...");
    const actionsResp = await hit("1-actions", "GET", `/v3/actions?workspaceId=${WORKSPACE}`);
    const actions = actionsResp.body?.actions || actionsResp.body || [];

    // Look for a simple action like "find company domain" or "enrich company"
    // We want something that takes a simple text input and returns data
    const targetActions = [
      "find-company-domain",
      "claygpt-text-to-domain",
      "google-search",
      "normalize-company-name",
    ];

    let selectedAction: any = null;
    for (const key of targetActions) {
      selectedAction = actions.find((a: any) => a.key === key);
      if (selectedAction) break;
    }

    // Fallback: find any action that has simple text input
    if (!selectedAction) {
      selectedAction = actions.find((a: any) =>
        a.inputParameterSchema?.properties &&
        Object.keys(a.inputParameterSchema.properties).length <= 3 &&
        !a.auth?.providerType // no auth needed
      );
    }

    if (!selectedAction) {
      // Just use any action, we'll figure out auth
      selectedAction = actions.find((a: any) => a.key?.includes("company") || a.key?.includes("domain"));
    }

    console.log(`  Selected action: ${selectedAction?.key} (${selectedAction?.displayName})`);
    console.log(`  Input schema: ${JSON.stringify(selectedAction?.inputParameterSchema?.properties ? Object.keys(selectedAction.inputParameterSchema.properties) : "none")}`);
    console.log(`  Auth provider: ${selectedAction?.auth?.providerType || "none"}`);

    // Get authAccountId if needed
    let authAccountId: string | null = null;
    if (selectedAction?.auth?.providerType) {
      const appAccounts = await hit("1b-app-accounts", "GET", "/v3/app-accounts");
      const accounts = appAccounts.body || [];
      const match = accounts.find((a: any) => a.appAccountTypeId === selectedAction.auth.providerType);
      if (match) {
        authAccountId = match.id;
        console.log(`  Auth account: ${match.name} (${authAccountId})`);
      }
    }

    // ── Step 2: Create test table ──────────────────────────────────────
    console.log("\n>>> Step 2: Creating test table...");
    const createTable = await hit("2-create-table", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type: "spreadsheet",
      name: "INV-enrichment-lifecycle-test"
    });
    log(createTable);

    const table = createTable.body?.table || createTable.body;
    testTableId = table?.id;
    if (!testTableId) { console.error("Failed to create table"); return; }
    console.log(`  Table ID: ${testTableId}`);

    // Get full schema to find view ID
    await delay(500);
    const schema = await hit("2b-schema", "GET", `/v3/tables/${testTableId}`);
    const fields = schema.body?.fields || schema.body?.table?.fields || [];
    const views = schema.body?.gridViews || schema.body?.views || schema.body?.table?.gridViews || schema.body?.table?.views || [];
    const viewId = views[0]?.id;
    console.log(`  View ID: ${viewId}`);
    console.log(`  Default fields: ${fields.map((f: any) => `${f.name}(${f.id})`).join(", ")}`);

    // ── Step 3: Create columns ───────────────────────────────────���─────
    console.log("\n>>> Step 3: Creating columns...");

    // Create text input column
    const textCol = await hit("3a-text-col", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Company Name",
      type: "text",
      typeSettings: { dataTypeSettings: { type: "text" } },
      activeViewId: viewId
    });
    const textFieldId = textCol.body?.field?.id || textCol.body?.id;
    console.log(`  Text column: ${textFieldId}`);

    await delay(200);

    // Create enrichment column
    const actionKey = selectedAction?.key || "find-company-domain";
    const actionPackageId = selectedAction?.package?.id || selectedAction?.packageId;

    // Build inputsBinding based on action's input schema
    const inputProps = selectedAction?.inputParameterSchema?.properties || {};
    const firstInputKey = Object.keys(inputProps)[0] || "company_name";

    const enrichCol = await hit("3b-enrich-col", "POST", `/v3/tables/${testTableId}/fields`, {
      name: "Enrichment Result",
      type: "action",
      typeSettings: {
        actionKey: actionKey,
        actionPackageId: actionPackageId,
        authAccountId: authAccountId,
        inputsBinding: [
          { name: firstInputKey, formulaText: `{{${textFieldId}}}` }
        ],
        dataTypeSettings: { type: "json" },
        useStaticIP: false,
      },
      activeViewId: viewId
    });
    const enrichFieldId = enrichCol.body?.field?.id || enrichCol.body?.id;
    console.log(`  Enrichment column: ${enrichFieldId}`);
    log(enrichCol);

    await delay(200);

    // ── Step 4: Seed rows ──────────────────────────────────────────────
    console.log("\n>>> Step 4: Seeding test rows...");
    const seedRows = await hit("4-seed-rows", "POST", `/v3/tables/${testTableId}/records`, {
      records: [
        { cells: { [textFieldId]: "Google" } },
        { cells: { [textFieldId]: "Microsoft" } },
        { cells: { [textFieldId]: "xyznotarealcompany12345" } }, // likely to fail/error
      ]
    });
    const createdRecords = seedRows.body?.records || [];
    const recordIds = createdRecords.map((r: any) => r.id);
    console.log(`  Created ${recordIds.length} rows: ${recordIds.join(", ")}`);

    // ── Step 5: Read rows BEFORE trigger (baseline) ────────────────────
    console.log("\n>>> Step 5: Baseline row read (before trigger)...");
    await delay(500);
    const baseline = await hit("5-baseline", "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=10`);
    const baselineRows = baseline.body?.results || [];
    for (const row of baselineRows) {
      const enrichCell = row.cells?.[enrichFieldId];
      console.log(`  Row ${row.id}: enrichment cell = ${JSON.stringify(enrichCell)}`);
      console.log(`    recordMetadata = ${JSON.stringify(row.recordMetadata)}`);
    }

    // ── Step 6: Trigger enrichment ─────────────────────────────────────
    console.log("\n>>> Step 6: Triggering enrichment...");
    if (enrichFieldId && recordIds.length > 0) {
      const triggerResp = await hit("6-trigger", "PATCH", `/v3/tables/${testTableId}/run`, {
        runRecords: { recordIds: recordIds },
        fieldIds: [enrichFieldId],
        forceRun: true
      });
      console.log(`  FULL TRIGGER RESPONSE:`);
      console.log(`  ${JSON.stringify(triggerResp.body, null, 2)}`);
      console.log(`  Status: ${triggerResp.status}`);
      console.log(`  Headers: ${JSON.stringify(triggerResp.headers)}`);

      // Also try with callerName
      await delay(100);
      const triggerResp2 = await hit("6b-trigger-caller", "PATCH", `/v3/tables/${testTableId}/run`, {
        runRecords: { recordIds: recordIds },
        fieldIds: [enrichFieldId],
        forceRun: true,
        callerName: "99percent-agent"
      });
      console.log(`  Trigger with callerName: ${JSON.stringify(triggerResp2.body)}`);
    } else {
      console.log("  SKIPPED — no enrichment field or records to trigger on");
    }

    // ── Step 7: Poll rows for status transitions ───────────────────────
    console.log("\n>>> Step 7: Polling for status transitions (every 2s, max 60s)...");
    const pollStart = Date.now();
    const maxPollMs = 60000;
    let pollRound = 0;
    const statusHistory: Record<string, string[]> = {};

    while (Date.now() - pollStart < maxPollMs) {
      pollRound++;
      await delay(2000);

      const pollResp = await hit(`7-poll-${pollRound}`, "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=10`);
      const rows = pollResp.body?.results || [];

      let allDone = true;
      for (const row of rows) {
        const enrichCell = row.cells?.[enrichFieldId];
        const status = enrichCell?.metadata?.status || enrichCell?.metadata?.state || "no-metadata";
        const value = enrichCell?.value;
        const hasValue = value !== null && value !== undefined;

        if (!statusHistory[row.id]) statusHistory[row.id] = [];
        const lastStatus = statusHistory[row.id][statusHistory[row.id].length - 1];
        if (status !== lastStatus) {
          statusHistory[row.id].push(status);
          console.log(`  [${pollRound}] Row ${row.id}: STATUS CHANGED → ${status} (value: ${hasValue ? "present" : "null"})`);
        }

        // Check if enrichment is still running
        if (!hasValue && status !== "SUCCESS" && status !== "ERROR" && status !== "FAILED") {
          allDone = false;
        }

        // On first poll, dump full cell structure
        if (pollRound === 1) {
          console.log(`  [${pollRound}] Row ${row.id} FULL enrichment cell: ${JSON.stringify(enrichCell)}`);
          console.log(`  [${pollRound}] Row ${row.id} FULL recordMetadata: ${JSON.stringify(row.recordMetadata)}`);
        }
      }

      if (allDone && pollRound >= 3) {
        console.log(`  All rows completed after ${pollRound} polls (${((Date.now() - pollStart) / 1000).toFixed(1)}s)`);
        break;
      }
    }

    // ── Step 8: Final read with full detail ────────────────────────────
    console.log("\n>>> Step 8: Final read — full row detail...");
    await delay(1000);
    const finalRead = await hit("8-final-read", "GET", `/v3/tables/${testTableId}/views/${viewId}/records?limit=10`);
    const finalRows = finalRead.body?.results || [];
    for (const row of finalRows) {
      console.log(`\n  Row ${row.id}:`);
      console.log(`    All cells: ${JSON.stringify(row.cells, null, 2)}`);
      console.log(`    recordMetadata: ${JSON.stringify(row.recordMetadata, null, 2)}`);
    }

    // Also read individual records for potentially richer data
    for (const rid of recordIds.slice(0, 2)) {
      await delay(100);
      const single = await hit(`8b-single-${rid}`, "GET", `/v3/tables/${testTableId}/records/${rid}`);
      console.log(`\n  Single record ${rid}: ${JSON.stringify(single.body, null, 2)}`);
    }

    // ── Summary ────────────────────────────────────────────────────────
    console.log("\n\n>>> SUMMARY: Status transitions per row:");
    for (const [rowId, history] of Object.entries(statusHistory)) {
      console.log(`  ${rowId}: ${history.join(" → ")}`);
    }

  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────
    if (testTableId) {
      console.log(`\n>>> Cleanup: Deleting test table ${testTableId}...`);
      await delay(500);
      const del = await hit("cleanup-delete", "DELETE", `/v3/tables/${testTableId}`);
      console.log(`  Delete status: ${del.status}`);
    }

    // Save results
    const outputFile = path.join(__dirname, "..", "results", `investigate-enrichment-lifecycle-${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${outputFile}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
