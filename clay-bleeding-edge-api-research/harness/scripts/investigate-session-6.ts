/**
 * Session 6: Attack New TODOs
 *
 * Covers: TODO-026 (signals write), TODO-027 (tags write), TODO-028 (auto-run),
 * TODO-029 (dedup), TODO-030 (export download), TODO-031 (enrichment column)
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-6.ts
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
  console.error("ERROR: No cookie found."); process.exit(1);
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
    const r = { probe, method, url, status: resp.status, latencyMs: ms, body: b };
    results.push(r);
    return r;
  } catch (err: any) {
    const r = { probe, method, url, status: 0, latencyMs: Date.now() - start, body: null, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (tag: string, r: any) => {
  const mark = r.status === 200 || r.status === 201 ? "✅" : r.status === 400 ? "⚠️" : r.status === 404 ? "❌" : `[${r.status}]`;
  console.log(`  ${mark} ${tag}: ${JSON.stringify(r.body).substring(0, 300)}`);
};

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 6: Attack New TODOs                                   ║");
  console.log("╚════��═════════════════════════════════════════════════════════���═══╝");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // TODO-026: Signal CRUD Write
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> TODO-026: Signal CRUD Write Operations");

    // Read existing signals to get structure
    const signals = await hit("26a", "GET", `/v3/workspaces/${WORKSPACE}/signals`);
    const sigList = signals.body?.signals || [];
    console.log(`  ${sigList.length} existing signals`);
    if (sigList[0]) {
      console.log(`  Sample signal: ${JSON.stringify(sigList[0]).substring(0, 400)}`);
    }

    // Try single signal read
    if (sigList[0]) {
      const sigId = sigList[0].id;
      await delay(50);
      log("GET single signal", await hit("26b", "GET", `/v3/workspaces/${WORKSPACE}/signals/${sigId}`));
      await delay(50);
      log("GET /v3/signals/{id}", await hit("26c", "GET", `/v3/signals/${sigId}`));
    }

    // Try creating a signal
    await delay(50);
    log("POST workspace signals", await hit("26d", "POST", `/v3/workspaces/${WORKSPACE}/signals`, {
      type: "Custom", name: "Test Signal", settings: { version: 1, signalType: "Custom" }
    }));
    await delay(50);
    log("POST /v3/signals", await hit("26e", "POST", "/v3/signals", {
      workspaceId: parseInt(WORKSPACE), type: "Custom", name: "Test Signal"
    }));

    // ═══���═════════════════════════════════════════════════════════��════
    // TODO-027: Resource Tags Write
    // ══════════��═══════════════════════════════════════════════════════
    console.log("\n>>> TODO-027: Resource Tags Write Operations");

    log("POST workspace tags", await hit("27a", "POST", `/v3/workspaces/${WORKSPACE}/resource-tags`, {
      name: "test-tag", color: "blue"
    }));
    await delay(50);
    log("POST /v3/resource-tags", await hit("27b", "POST", "/v3/resource-tags", {
      workspaceId: parseInt(WORKSPACE), name: "test-tag-2"
    }));
    // Re-read to see if anything was created
    await delay(50);
    const tagsAfter = await hit("27c", "GET", `/v3/workspaces/${WORKSPACE}/resource-tags`);
    console.log(`  Tags after write attempts: ${JSON.stringify(tagsAfter.body)}`);

    // ═══════��═══════════════════════════════���══════════════════════════
    // TODO-030: Export File Download
    // ═══════════���══════════════════════════════���═══════════════════════
    console.log("\n>>> TODO-030: Export File Download Mechanism");

    // Create a quick table, export it, try all download paths
    const expTable = await hit("30a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-export-download-test"
    });
    const expTableId = expTable.body?.table?.id || expTable.body?.id;
    if (expTableId) {
      tablesToClean.push(expTableId);
      await delay(500);

      const job = await hit("30b", "POST", `/v3/tables/${expTableId}/export`, {});
      const jobId = job.body?.id;
      console.log(`  Export job: ${jobId}`);

      if (jobId) {
        // Wait for completion
        await delay(3000);
        const poll = await hit("30c", "GET", `/v3/exports/${jobId}`);
        const filePath = poll.body?.uploadedFilePath;
        console.log(`  Status: ${poll.body?.status}, path: ${filePath}`);

        // Try every download variant
        const downloadPaths = [
          `/v3/exports/${jobId}/download`,
          `/v3/exports/${jobId}?download=true`,
          `/v3/files/${filePath}`,
          `/v3/workspaces/${WORKSPACE}/files/${filePath}`,
          `/v3/download/${filePath}`,
          `/v3/storage/${filePath}`,
        ];
        for (const p of downloadPaths) {
          await delay(50);
          log(`download ${p.substring(0, 50)}`, await hit("30d", "GET", p));
        }

        // Try with different Accept header
        const url = `${API_BASE}/v3/exports/${jobId}`;
        const csvResp = await fetch(url, { headers: { Cookie: COOKIE, Accept: "text/csv" } });
        const csvStatus = csvResp.status;
        const csvBody = await csvResp.text();
        console.log(`  Accept:text/csv → ${csvStatus}: ${csvBody.substring(0, 200)}`);
      }
    }

    // ══════════��════════════════════════════════���══════════════════════
    // TODO-031: Enrichment Column Creation
    // ��════════════════════��════════════════════════════════════════════
    console.log("\n>>> TODO-031: Enrichment Column from Scratch");

    const actionsResp = await hit("31a", "GET", `/v3/actions?workspaceId=${WORKSPACE}`);
    const allActions = actionsResp.body?.actions || actionsResp.body || [];

    // Find normalize-company-name specifically
    const normAction = allActions.find((a: any) => a.key === "normalize-company-name");
    if (normAction) {
      console.log(`  Action: ${normAction.key}`);
      console.log(`  Package ID: ${normAction.package?.id}`);
      console.log(`  Version: ${normAction.version}`);
      console.log(`  Input schema: ${JSON.stringify(normAction.inputParameterSchema)?.substring(0, 300)}`);
      console.log(`  Auth: ${JSON.stringify(normAction.auth)}`);
    }

    // Also find a simple lookup action
    const lookupAction = allActions.find((a: any) => a.key === "lookup-multiple-rows-in-other-table");
    if (lookupAction) {
      console.log(`\n  Lookup action: ${lookupAction.key}, pkg: ${lookupAction.package?.id}`);
    }

    // Create test table
    const enrichTable = await hit("31b", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-enrichment-create-test"
    });
    const enrichTableId = enrichTable.body?.table?.id || enrichTable.body?.id;
    if (enrichTableId) {
      tablesToClean.push(enrichTableId);
      await delay(500);
      const schema = await hit("31c", "GET", `/v3/tables/${enrichTableId}`);
      const viewId = ((schema.body?.table || schema.body)?.gridViews || [])[0]?.id;

      // Create input column
      const inputCol = await hit("31d", "POST", `/v3/tables/${enrichTableId}/fields`, {
        name: "Company", type: "text",
        typeSettings: { dataTypeSettings: { type: "text" } },
        activeViewId: viewId
      });
      const inputFieldId = inputCol.body?.field?.id || inputCol.body?.id;
      console.log(`  Input field: ${inputFieldId}`);

      if (normAction && inputFieldId) {
        const inputProps = normAction.inputParameterSchema?.properties || {};
        const inputKeys = Object.keys(inputProps);
        console.log(`  Action input keys: ${inputKeys.join(", ")}`);

        // Try creating enrichment column with various payload shapes
        const enrichPayloads = [
          // Shape 1: Minimal — actionKey + actionPackageId + inputsBinding
          {
            name: "shape1-minimal",
            payload: {
              name: "Normalized Name",
              type: "action",
              typeSettings: {
                actionKey: normAction.key,
                actionPackageId: normAction.package?.id,
                inputsBinding: inputKeys.map((k: string) => ({ name: k, formulaText: `{{${inputFieldId}}}` })),
                dataTypeSettings: { type: "json" }
              },
              activeViewId: viewId
            }
          },
          // Shape 2: With version
          {
            name: "shape2-with-version",
            payload: {
              name: "Normalized Name v2",
              type: "action",
              typeSettings: {
                actionKey: normAction.key,
                actionVersion: normAction.version,
                actionPackageId: normAction.package?.id,
                inputsBinding: inputKeys.map((k: string) => ({ name: k, formulaText: `{{${inputFieldId}}}` })),
                dataTypeSettings: { type: "json" },
                useStaticIP: false
              },
              activeViewId: viewId
            }
          },
          // Shape 3: With only first input key
          {
            name: "shape3-first-input-only",
            payload: {
              name: "Normalized Name v3",
              type: "action",
              typeSettings: {
                actionKey: normAction.key,
                actionVersion: normAction.version,
                actionPackageId: normAction.package?.id,
                inputsBinding: [{ name: inputKeys[0], formulaText: `{{${inputFieldId}}}` }],
                dataTypeSettings: { type: "json" },
                useStaticIP: false,
                runAsButton: false
              },
              activeViewId: viewId
            }
          },
          // Shape 4: Completely flat inputsBinding (not array)
          {
            name: "shape4-inputs-object",
            payload: {
              name: "Normalized Name v4",
              type: "action",
              typeSettings: {
                actionKey: normAction.key,
                actionVersion: normAction.version,
                actionPackageId: normAction.package?.id,
                inputsBinding: { [inputKeys[0]]: { formulaText: `{{${inputFieldId}}}` } },
                dataTypeSettings: { type: "json" }
              },
              activeViewId: viewId
            }
          },
        ];

        for (const ep of enrichPayloads) {
          await delay(200);
          const resp = await hit(`31e-${ep.name}`, "POST", `/v3/tables/${enrichTableId}/fields`, ep.payload);
          const fid = resp.body?.field?.id || resp.body?.id;
          console.log(`  ${ep.name}: ${resp.status} ${fid ? `→ ${fid}` : ""}`);
          if (resp.status !== 200 && resp.status !== 201) {
            console.log(`    Error: ${JSON.stringify(resp.body).substring(0, 300)}`);
          } else {
            console.log(`    SUCCESS! Field created: ${JSON.stringify(resp.body).substring(0, 300)}`);
            break; // found working format
          }
        }
      }
    }

    // ═══════════���═════════════════════════���════════════════════════════
    // TODO-028 + TODO-029: Auto-Run + Deduplication
    // ═════════════════════════════════════════��════════════════════════
    console.log("\n>>> TODO-028/029: Auto-Run + Deduplication");

    const dedupTable = await hit("28a", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-dedup-autorun-test"
    });
    const dedupTableId = dedupTable.body?.table?.id || dedupTable.body?.id;
    if (dedupTableId) {
      tablesToClean.push(dedupTableId);
      await delay(500);
      const schema = await hit("28b", "GET", `/v3/tables/${dedupTableId}`);
      const viewId = ((schema.body?.table || schema.body)?.gridViews || [])[0]?.id;

      // Create text column for dedup key
      const keyCol = await hit("28c", "POST", `/v3/tables/${dedupTableId}/fields`, {
        name: "Email", type: "text",
        typeSettings: { dataTypeSettings: { type: "email" } },
        activeViewId: viewId
      });
      const keyFieldId = keyCol.body?.field?.id || keyCol.body?.id;

      // Enable autoRun + set dedupeFieldId
      await delay(200);
      const settings = await hit("28d", "PATCH", `/v3/tables/${dedupTableId}`, {
        tableSettings: { autoRun: true, dedupeFieldId: keyFieldId }
      });
      console.log(`  tableSettings after: ${JSON.stringify(settings.body?.tableSettings || settings.body?.table?.tableSettings)}`);

      // Insert rows — including duplicates
      await delay(300);
      const rows1 = await hit("29a", "POST", `/v3/tables/${dedupTableId}/records`, {
        records: [
          { cells: { [keyFieldId]: "alice@example.com" } },
          { cells: { [keyFieldId]: "bob@example.com" } },
          { cells: { [keyFieldId]: "alice@example.com" } },  // duplicate!
        ]
      });
      const created1 = rows1.body?.records || [];
      console.log(`  Inserted ${created1.length} rows (3 attempted, 1 is duplicate)`);
      for (const r of created1) {
        console.log(`    ${r.id}: ${r.cells?.[keyFieldId]?.value || r.cells?.[keyFieldId]} dedupeValue=${r.dedupeValue}`);
      }

      // Read back all rows
      await delay(500);
      const readback = await hit("29b", "GET", `/v3/tables/${dedupTableId}/views/${viewId}/records?limit=100`);
      const allRows = readback.body?.results || [];
      console.log(`  Total rows in table: ${allRows.length} (expect 2 if dedup worked, 3 if not)`);
      for (const r of allRows) {
        console.log(`    ${r.id}: ${r.cells?.[keyFieldId]?.value} dedupeValue=${r.dedupeValue}`);
      }

      // Try more tableSettings variations
      console.log("\n  Testing more tableSettings keys...");
      const settingsVariants = [
        { runOnNewRows: true },
        { schedule: { enabled: true, interval: "daily" } },
        { cronExpression: "0 0 * * *" },
        { autoRunOnNewRows: true },
      ];
      for (const s of settingsVariants) {
        await delay(100);
        const resp = await hit("28e", "PATCH", `/v3/tables/${dedupTableId}`, { tableSettings: s });
        console.log(`  PATCH ${JSON.stringify(s)}: ${resp.status} → settings=${JSON.stringify(resp.body?.tableSettings || resp.body?.table?.tableSettings)}`);
      }
    }

  } finally {
    console.log(`\n>>> Cleanup: Deleting ${tablesToClean.length} tables...`);
    for (const tid of tablesToClean) {
      await delay(200);
      await hit("cleanup", "DELETE", `/v3/tables/${tid}`);
    }

    const outputFile = path.join(__dirname, "..", "results", `investigate-session-6-${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${outputFile}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
