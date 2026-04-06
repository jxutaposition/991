/**
 * Deep Investigation 1: Hidden Entity APIs
 *
 * Probes endpoint families hinted at by feature flags and workspace abilities:
 *   - Folders (parentFolderId on tables/workbooks)
 *   - Signals (enableSignals: true)
 *   - Recipes/Presets (canReadRecipe, canReadPreset)
 *   - Tags (canManageResourceTags)
 *   - Audiences/Segments (audienceAbilities)
 *   - Scheduled sources/tables
 *   - CRM integrations
 *   - Website tracking
 *   - Notifications
 *   - Export job completion polling
 *   - Import creation
 *   - Table deduplication settings
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-deep-scan-1.ts
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

function report(probe: string, r: ProbeResult) {
  const exists = r.status === 200 || r.status === 201;
  const auth = r.status === 401;
  const forbidden = r.status === 403;
  const notFound = r.status === 404;
  const badReq = r.status === 400;
  const marker = exists ? "✅" : auth ? "🔒" : forbidden ? "🚫" : badReq ? "⚠️" : notFound ? "❌" : "??";
  const preview = r.body ? JSON.stringify(r.body).substring(0, 250) : "";
  console.log(`  ${marker} [${r.status}] ${r.method} ${r.url.replace(API_BASE, "")} — ${preview}`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Deep Investigation 1: Hidden Entity APIs                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  const userId = me.body?.id;
  console.log(`Session OK: ${me.body?.email} (userId: ${userId})\n`);

  // ── 1. Folders ──────────────────────────────────────────────────────
  console.log(">>> 1. Folders (parentFolderId exists on tables/workbooks)");
  const folderProbes = [
    ["GET", `/v3/folders`],
    ["GET", `/v3/folders?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/folders`],
    ["POST", `/v3/folders`, { workspaceId: parseInt(WORKSPACE), name: "Test Folder" }],
  ];
  for (const [method, path, body] of folderProbes) {
    await delay(50);
    report("folders", await hit(`1-folders`, method as string, path as string, body));
  }

  // ── 2. Signals ──────────────────────────────────────────────────────
  console.log("\n>>> 2. Signals (enableSignals: true)");
  const signalProbes = [
    ["GET", `/v3/signals`],
    ["GET", `/v3/signals?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/signals`],
  ];
  for (const [method, path] of signalProbes) {
    await delay(50);
    report("signals", await hit(`2-signals`, method as string, path as string));
  }

  // ── 3. Recipes ──────────────────────────────────────────────────────
  console.log("\n>>> 3. Recipes (canReadRecipe: true, canManageRecipe: true)");
  const recipeProbes = [
    ["GET", `/v3/recipes`],
    ["GET", `/v3/recipes?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/recipes`],
  ];
  for (const [method, path] of recipeProbes) {
    await delay(50);
    report("recipes", await hit(`3-recipes`, method as string, path as string));
  }

  // ── 4. Presets ──────────────────────────────────────────────────────
  console.log("\n>>> 4. Presets (canReadPreset: true, canManagePreset: true)");
  const presetProbes = [
    ["GET", `/v3/presets`],
    ["GET", `/v3/presets?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/presets`],
  ];
  for (const [method, path] of presetProbes) {
    await delay(50);
    report("presets", await hit(`4-presets`, method as string, path as string));
  }

  // ── 5. Tags ─────────────────────────────────────────────────────────
  console.log("\n>>> 5. Tags (canManageResourceTags: true)");
  const tagProbes = [
    ["GET", `/v3/tags`],
    ["GET", `/v3/tags?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/tags`],
    ["GET", `/v3/resource-tags`],
    ["GET", `/v3/resource-tags?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/resource-tags`],
  ];
  for (const [method, path] of tagProbes) {
    await delay(50);
    report("tags", await hit(`5-tags`, method as string, path as string));
  }

  // ── 6. Audiences/Segments ───────────────────────────────────────────
  console.log("\n>>> 6. Audiences/Segments (audienceAbilities on workspace)");
  const audienceProbes = [
    ["GET", `/v3/audiences`],
    ["GET", `/v3/audiences?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/audiences`],
    ["GET", `/v3/segments`],
    ["GET", `/v3/workspaces/${WORKSPACE}/segments`],
  ];
  for (const [method, path] of audienceProbes) {
    await delay(50);
    report("audiences", await hit(`6-audiences`, method as string, path as string));
  }

  // ── 7. Scheduled Sources ────────────────────────────────────────────
  console.log("\n>>> 7. Scheduled Sources (scheduledSourcesLimit: 100)");
  const schedProbes = [
    ["GET", `/v3/schedules`],
    ["GET", `/v3/schedules?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/schedules`],
    ["GET", `/v3/scheduled-sources`],
    ["GET", `/v3/workspaces/${WORKSPACE}/scheduled-sources`],
    ["GET", `/v3/cron`],
    ["GET", `/v3/workspaces/${WORKSPACE}/cron-jobs`],
  ];
  for (const [method, path] of schedProbes) {
    await delay(50);
    report("schedules", await hit(`7-sched`, method as string, path as string));
  }

  // ── 8. CRM Integration ─────────────────────────────────────────────
  console.log("\n>>> 8. CRM Integration (canManageCRMImports, canExportToCRM)");
  const crmProbes = [
    ["GET", `/v3/crm`],
    ["GET", `/v3/crm?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/crm`],
    ["GET", `/v3/integrations`],
    ["GET", `/v3/integrations?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/integrations`],
    ["GET", `/v3/crm-imports`],
    ["GET", `/v3/workspaces/${WORKSPACE}/crm-imports`],
  ];
  for (const [method, path] of crmProbes) {
    await delay(50);
    report("crm", await hit(`8-crm`, method as string, path as string));
  }

  // ── 9. Website Tracking ─────────────────────────────────────────────
  console.log("\n>>> 9. Website Tracking (canManageWebsiteTracking)");
  const wtProbes = [
    ["GET", `/v3/website-tracking`],
    ["GET", `/v3/website-tracking?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/website-tracking`],
    ["GET", `/v3/website-intent`],
    ["GET", `/v3/workspaces/${WORKSPACE}/website-intent`],
  ];
  for (const [method, path] of wtProbes) {
    await delay(50);
    report("website", await hit(`9-website`, method as string, path as string));
  }

  // ── 10. Notifications ───────────────────────────────────────────────
  console.log("\n>>> 10. Notifications");
  const notifProbes = [
    ["GET", `/v3/notifications`],
    ["GET", `/v3/notifications?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/notifications`],
  ];
  for (const [method, path] of notifProbes) {
    await delay(50);
    report("notifications", await hit(`10-notif`, method as string, path as string));
  }

  // ── 11. Export Job Polling ──────────────────────────────────────────
  console.log("\n>>> 11. Export Job Polling (create job then poll)");
  // Create a test table, export it, then poll
  const testTable = await hit("11-create-table", "POST", "/v3/tables", {
    workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-export-poll-test"
  });
  const testTableId = testTable.body?.table?.id || testTable.body?.id;
  if (testTableId) {
    await delay(500);
    const exportJob = await hit("11-create-export", "POST", `/v3/tables/${testTableId}/export`, { format: "csv" });
    const jobId = exportJob.body?.id;
    console.log(`  Export job created: ${jobId} (status: ${exportJob.body?.status})`);
    report("export-create", exportJob);

    if (jobId) {
      // Poll the job
      for (let i = 1; i <= 5; i++) {
        await delay(2000);
        const poll = await hit(`11-poll-${i}`, "GET", `/v3/exports/${jobId}`);
        console.log(`  Poll ${i}: status=${poll.body?.status}, uploadedFilePath=${poll.body?.uploadedFilePath}`);
        report(`export-poll-${i}`, poll);
        if (poll.body?.uploadedFilePath || poll.body?.status === "COMPLETED") break;
      }

      // Try download
      await delay(500);
      const download = await hit("11-download", "GET", `/v3/exports/download/${jobId}`);
      console.log(`  Download: status=${download.status}`);
      report("export-download", download);
    }

    // Cleanup
    await delay(200);
    await hit("11-cleanup", "DELETE", `/v3/tables/${testTableId}`);
  }

  // ── 12. Import Creation ─────────────────────────────────────────────
  console.log("\n>>> 12. Import Creation (POST /v3/imports)");
  const importProbes = [
    ["POST", `/v3/imports`, { workspaceId: parseInt(WORKSPACE) }],
    ["POST", `/v3/imports/csv`, { workspaceId: parseInt(WORKSPACE) }],
  ];
  for (const [method, path, body] of importProbes) {
    await delay(50);
    report("imports", await hit(`12-imports`, method as string, path as string, body));
  }

  // ── 13. Users / Teams ──────────────────────────────────────────────
  console.log("\n>>> 13. Users / Teams");
  const userProbes = [
    ["GET", `/v3/users`],
    ["GET", `/v3/workspaces/${WORKSPACE}/users`],
    ["GET", `/v3/workspaces/${WORKSPACE}/members`],
    ["GET", `/v3/teams`],
    ["GET", `/v3/workspaces/${WORKSPACE}/teams`],
    ["GET", `/v3/user-groups`],
    ["GET", `/v3/workspaces/${WORKSPACE}/user-groups`],
  ];
  for (const [method, path] of userProbes) {
    await delay(50);
    report("users", await hit(`13-users`, method as string, path as string));
  }

  // ── 14. Table-level Settings & Deduplication ────────────────────────
  console.log("\n>>> 14. Table Settings & Deduplication");
  // Get an existing table and examine its settings
  const tables = await hit("14-tables", "GET", `/v3/workspaces/${WORKSPACE}/tables`);
  const firstTable = (tables.body?.results || [])[0];
  if (firstTable) {
    const schema = await hit("14-schema", "GET", `/v3/tables/${firstTable.id}`);
    const tableObj = schema.body?.table || schema.body;
    console.log(`  tableSettings: ${JSON.stringify(tableObj?.tableSettings)}`);
    console.log(`  extraData: ${JSON.stringify(tableObj?.extraData)?.substring(0, 300)}`);
    console.log(`  abilities: ${JSON.stringify(tableObj?.abilities)}`);
    console.log(`  defaultAccess: ${tableObj?.defaultAccess}`);
    console.log(`  fieldGroupMap: ${JSON.stringify(tableObj?.fieldGroupMap)}`);

    // Try dedupe endpoints
    const dedupeProbes = [
      ["GET", `/v3/tables/${firstTable.id}/dedupe`],
      ["GET", `/v3/tables/${firstTable.id}/dedupe-settings`],
      ["GET", `/v3/tables/${firstTable.id}/settings`],
      ["PATCH", `/v3/tables/${firstTable.id}/settings`, { autoRun: true }],
    ];
    for (const [method, path, body] of dedupeProbes) {
      await delay(50);
      report("dedupe", await hit("14-dedupe", method as string, path as string, body));
    }
  }

  // ── 15. Attributes ─────────────────────────────────────────────────
  console.log("\n>>> 15. Attributes (enableAttributes: true)");
  const attrProbes = [
    ["GET", `/v3/attributes`],
    ["GET", `/v3/attributes?workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/attributes`],
    ["GET", `/v3/company-attributes`],
    ["GET", `/v3/workspaces/${WORKSPACE}/company-attributes`],
  ];
  for (const [method, path] of attrProbes) {
    await delay(50);
    report("attributes", await hit("15-attrs", method as string, path as string));
  }

  // ── 16. API Keys (with correct params) ─────────────────────────────
  console.log("\n>>> 16. API Keys (resourceType variations)");
  const apiKeyProbes = [
    ["GET", `/v3/api-keys?resourceType=user&resourceId=${userId}`],
    ["GET", `/v3/api-keys?resourceType=workspace&resourceId=${WORKSPACE}`],
    ["GET", `/v3/api-keys?resourceType=table&resourceId=t_dummy`],
  ];
  for (const [method, path] of apiKeyProbes) {
    await delay(50);
    report("api-keys", await hit("16-apikeys", method as string, path as string));
  }

  // ── 17. Misc Probes ────────────────────────────────────────────────
  console.log("\n>>> 17. Misc endpoint probes");
  const miscProbes = [
    ["GET", `/v3/workspaces/${WORKSPACE}/activity`],
    ["GET", `/v3/activity`],
    ["GET", `/v3/workspaces/${WORKSPACE}/audit-log`],
    ["GET", `/v3/workspaces/${WORKSPACE}/usage`],
    ["GET", `/v3/workspaces/${WORKSPACE}/billing`],
    ["GET", `/v3/workspaces/${WORKSPACE}/quotas`],
    ["GET", `/v3/workspaces/${WORKSPACE}/limits`],
    ["GET", `/v3/workspaces/${WORKSPACE}/access`],
    ["GET", `/v3/workspaces/${WORKSPACE}/permissions`],
    ["GET", `/v3/search?q=test&workspaceId=${WORKSPACE}`],
    ["GET", `/v3/workspaces/${WORKSPACE}/search?q=test`],
    ["GET", `/v3/claygent`],
    ["GET", `/v3/workflows`],
    ["GET", `/v3/workspaces/${WORKSPACE}/workflows`],
    ["GET", `/v3/message-drafts`],
    ["GET", `/v3/workspaces/${WORKSPACE}/message-drafts`],
  ];
  for (const [method, path] of miscProbes) {
    await delay(50);
    report("misc", await hit("17-misc", method as string, path as string));
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\n\n>>> SUMMARY: Endpoints that returned 200:");
  const hits200 = results.filter(r => r.status === 200 && r.probe !== "0-session");
  for (const r of hits200) {
    console.log(`  ${r.method} ${r.url.replace(API_BASE, "")} — ${JSON.stringify(r.body).substring(0, 150)}`);
  }

  console.log("\n>>> Endpoints that returned 400 (exist but need params):");
  const hits400 = results.filter(r => r.status === 400);
  for (const r of hits400) {
    console.log(`  ${r.method} ${r.url.replace(API_BASE, "")} — ${JSON.stringify(r.body).substring(0, 150)}`);
  }

  console.log("\n>>> Endpoints that returned 403 (exist but forbidden):");
  const hits403 = results.filter(r => r.status === 403);
  for (const r of hits403) {
    console.log(`  ${r.method} ${r.url.replace(API_BASE, "")} — ${JSON.stringify(r.body).substring(0, 150)}`);
  }

  const outputFile = path.join(__dirname, "..", "results", `investigate-deep-scan-1-${Date.now()}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outputFile}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
