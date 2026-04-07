/**
 * Exploration Session #2 — Push the boundaries
 *
 * Tests all uncharted v3 endpoints to map what's possible beyond
 * what we already have implemented.
 *
 * Usage:
 *   CLAY_SESSION="s%3A..." CLAY_WORKSPACE="1080480" npx tsx explore-session-2.ts
 *
 * Probes (in order):
 *   1. GET /v3/actions?workspaceId=       — enrichment providers + authAccountIds
 *   2. GET /v3/sources?workspaceId=       — list all sources (webhook URLs?)
 *   3. GET /v3/sources/{sourceId}         — read a single source back
 *   4. PATCH /v3/sources/{sourceId}       — can we update source config?
 *   5. PATCH /v3/tables/{tableId}         — table rename
 *   6. PATCH /v3/tables/{tableId}/run     — targeted enrichment trigger (fieldIds)
 *   7. GET /v3/tables/{tableId}/rows      — does v3 row access exist?
 *   8. GET /v3/imports?workspaceId=       — import history
 *   9. GET /v3/exports/csv?tableId=       — export shape
 *  10. GET /v3/me                         — refresh user/session info
 *  11. Rate limit probing                 — find the actual ceiling
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE = process.env.CLAY_WORKSPACE || "1080480";

// Load cookie from .session-cookies.json (same format as extract-session.ts output)
// or fall back to CLAY_SESSION env var
function loadCookie(): string {
  const cookieFile = path.join(__dirname, "..", "results", ".session-cookies.json");
  if (fs.existsSync(cookieFile)) {
    const cookies = JSON.parse(fs.readFileSync(cookieFile, "utf-8"));
    const clay = cookies.find((c: any) => c.name === "claysession");
    if (clay) {
      console.log(`Loaded cookie from ${cookieFile} (expires ${new Date(clay.expires * 1000).toISOString()})`);
      return `claysession=${clay.value}`;
    }
  }
  const env = process.env.CLAY_SESSION;
  if (env) {
    return env.startsWith("claysession=") ? env : `claysession=${env}`;
  }
  console.error("ERROR: No cookie found. Either place .session-cookies.json in results/ or set CLAY_SESSION env var.");
  process.exit(1);
}

const COOKIE = loadCookie();

// ── Helpers ──────────────────────────────────────────────────────────

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

async function hit(
  probe: string,
  method: string,
  path: string,
  body?: any
): Promise<ProbeResult> {
  const url = `${API_BASE}${path}`;
  const start = Date.now();

  const options: RequestInit = {
    method,
    headers: {
      Cookie: COOKIE,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  try {
    const resp = await fetch(url, options);
    const latencyMs = Date.now() - start;
    let respBody: any;
    try { respBody = await resp.json(); } catch { respBody = await resp.text(); }

    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });

    const result: ProbeResult = { probe, method, url, status: resp.status, latencyMs, body: respBody, headers };
    results.push(result);
    return result;
  } catch (err: any) {
    const result: ProbeResult = {
      probe, method, url, status: 0, latencyMs: Date.now() - start,
      body: null, headers: {}, error: err.message,
    };
    results.push(result);
    return result;
  }
}

function log(probe: string, r: ProbeResult) {
  const status = r.error ? `ERROR: ${r.error}` : `${r.status}`;
  const bodyPreview = r.body ? JSON.stringify(r.body).substring(0, 300) : "(empty)";
  console.log(`\n${"=".repeat(70)}`);
  console.log(`[${probe}] ${r.method} ${r.url}`);
  console.log(`  Status: ${status}  (${r.latencyMs}ms)`);
  console.log(`  Body: ${bodyPreview}`);

  // Highlight rate-limit headers if present
  const rlHeaders = Object.entries(r.headers).filter(([k]) =>
    k.toLowerCase().includes("rate") || k.toLowerCase().includes("retry") || k.toLowerCase().includes("x-ratelimit")
  );
  if (rlHeaders.length > 0) {
    console.log(`  Rate-limit headers: ${JSON.stringify(Object.fromEntries(rlHeaders))}`);
  }
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Probes ───────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Clay v3 API — Exploration Session #2                          ║");
  console.log("║  Workspace: " + WORKSPACE.padEnd(52) + "║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // ── 0. Verify session is alive ─────────────────────────────────────
  console.log("\n\n>>> PROBE 0: Session health check");
  const me = await hit("0-session", "GET", "/v3/me");
  log("0-session", me);
  if (me.status === 401) {
    console.error("\n❌ Session cookie is expired or invalid. Get a fresh one:");
    console.error("   Chrome → app.clay.com → F12 → Application → Cookies → api.clay.com → claysession");
    process.exit(1);
  }
  if (me.body?.workspaces) {
    console.log(`  Workspaces: ${JSON.stringify(me.body.workspaces)}`);
  }
  await delay(200);

  // ── 1. Enrichment actions catalog ──────────────────────────────────
  console.log("\n\n>>> PROBE 1: Enrichment actions catalog (GET /v3/actions)");
  const actions = await hit("1-actions", "GET", `/v3/actions?workspaceId=${WORKSPACE}`);
  log("1-actions", actions);
  if (actions.status === 200 && Array.isArray(actions.body)) {
    console.log(`  Total actions: ${actions.body.length}`);
    // Show first 3 action names + their authAccountId info
    for (const a of actions.body.slice(0, 5)) {
      console.log(`    - ${a.name || a.actionPackageId || "unknown"} | authAccountId: ${a.authAccountId ?? "none"} | provider: ${a.provider ?? "?"}`);
    }
  }
  await delay(200);

  // ── 2. List tables to get a real table/source to probe ─────────────
  console.log("\n\n>>> PROBE 2: List tables (to find a table + source for further probes)");
  const tables = await hit("2-list-tables", "GET", `/v3/workspaces/${WORKSPACE}/tables`);
  log("2-list-tables", tables);

  let probeTableId: string | null = null;
  let probeSourceId: string | null = null;
  let probeFieldId: string | null = null;
  let probeViewId: string | null = null;

  if (tables.status === 200) {
    const tableList = Array.isArray(tables.body) ? tables.body : (tables.body?.tables ?? []);
    console.log(`  Found ${tableList.length} tables`);
    if (tableList.length > 0) {
      // Pick the first table that looks like a scratch/test table, or just the first
      const scratch = tableList.find((t: any) => /test|scratch|probe/i.test(t.name)) || tableList[0];
      probeTableId = scratch.id || scratch._id;
      console.log(`  Using table: "${scratch.name}" (${probeTableId})`);
    }
  }
  await delay(200);

  // ── 3. Get table schema to find a source and field ─────────────────
  if (probeTableId) {
    console.log("\n\n>>> PROBE 3: Table schema (find sources + fields)");
    const schema = await hit("3-schema", "GET", `/v3/tables/${probeTableId}`);
    log("3-schema", schema);
    if (schema.status === 200 && schema.body) {
      const fields = schema.body.fields || schema.body.columns || [];
      const sources = schema.body.sources || [];
      const views = schema.body.views || [];
      console.log(`  Fields: ${fields.length}, Sources: ${sources.length}, Views: ${views.length}`);

      if (fields.length > 0) {
        probeFieldId = fields[0].id || fields[0]._id;
        console.log(`  First field: "${fields[0].name}" (${probeFieldId})`);
      }
      if (sources.length > 0) {
        probeSourceId = sources[0].id || sources[0]._id;
        console.log(`  First source: "${sources[0].name}" (${probeSourceId})`);
      }
      if (views.length > 0) {
        probeViewId = views[0].id || views[0]._id;
        console.log(`  First view: "${views[0].name}" (${probeViewId})`);
      }
    }
    await delay(200);
  }

  // ── 4. Source listing ──────────────────────────────────────────────
  console.log("\n\n>>> PROBE 4a: List sources (GET /v3/sources?workspaceId=)");
  const srcList = await hit("4a-sources-list-qs", "GET", `/v3/sources?workspaceId=${WORKSPACE}`);
  log("4a-sources-list-qs", srcList);
  await delay(200);

  console.log("\n>>> PROBE 4b: List sources alt (GET /v3/sources/list?workspaceId=)");
  const srcList2 = await hit("4b-sources-list-path", "GET", `/v3/sources/list?workspaceId=${WORKSPACE}`);
  log("4b-sources-list-path", srcList2);
  await delay(200);

  // ── 5. Read single source ──────────────────────────────────────────
  if (probeSourceId) {
    console.log("\n\n>>> PROBE 5: Read source details (GET /v3/sources/{id})");
    const src = await hit("5-source-read", "GET", `/v3/sources/${probeSourceId}`);
    log("5-source-read", src);
    if (src.status === 200) {
      // Look for webhook URL
      const body = src.body;
      const webhookUrl = body?.webhookUrl || body?.url || body?.webhook_url || body?.config?.url || body?.typeSettings?.url;
      console.log(`  Webhook URL found: ${webhookUrl ?? "NOT in response"}`);
      console.log(`  Full keys: ${Object.keys(body || {}).join(", ")}`);
    }
    await delay(200);

    // ── 6. Update source ──────────────────────────────────────────────
    console.log("\n\n>>> PROBE 6: Update source (PATCH /v3/sources/{id}) — empty body to see validation");
    const srcPatch = await hit("6-source-update", "PATCH", `/v3/sources/${probeSourceId}`, {});
    log("6-source-update", srcPatch);
    await delay(200);
  } else {
    console.log("\n\n>>> PROBE 5/6: SKIPPED — no source found on test table");
  }

  // ── 7. Table rename/update ─────────────────────────────────────────
  if (probeTableId) {
    // Probe with empty body first to see what PATCH accepts
    console.log("\n\n>>> PROBE 7a: Table update — empty body (PATCH /v3/tables/{id})");
    const tblPatchEmpty = await hit("7a-table-patch-empty", "PATCH", `/v3/tables/${probeTableId}`, {});
    log("7a-table-patch-empty", tblPatchEmpty);
    await delay(200);

    // Read current name, rename, rename back
    if (tables.status === 200) {
      const tableList = Array.isArray(tables.body) ? tables.body : (tables.body?.tables ?? []);
      const t = tableList.find((t: any) => (t.id || t._id) === probeTableId);
      if (t) {
        const origName = t.name;
        const tmpName = `${origName}_probe_test`;
        console.log(`\n>>> PROBE 7b: Rename "${origName}" → "${tmpName}"`);
        const rename1 = await hit("7b-table-rename", "PATCH", `/v3/tables/${probeTableId}`, { name: tmpName });
        log("7b-table-rename", rename1);
        await delay(200);

        if (rename1.status >= 200 && rename1.status < 300) {
          console.log(`>>> PROBE 7c: Rename back "${tmpName}" → "${origName}"`);
          const rename2 = await hit("7c-table-rename-back", "PATCH", `/v3/tables/${probeTableId}`, { name: origName });
          log("7c-table-rename-back", rename2);
          await delay(200);
        }
      }
    }
  }

  // ── 8. Enrichment trigger via v3 ───────────────────────────────────
  if (probeTableId) {
    // Empty body to see required params via Zod validation
    console.log("\n\n>>> PROBE 8a: v3 enrichment trigger — empty body (PATCH /v3/tables/{id}/run)");
    const trigEmpty = await hit("8a-trigger-empty", "PATCH", `/v3/tables/${probeTableId}/run`, {});
    log("8a-trigger-empty", trigEmpty);
    await delay(200);

    // Try with minimal known params
    if (probeFieldId) {
      console.log(`\n>>> PROBE 8b: v3 enrichment trigger — single field (fieldIds: [${probeFieldId}])`);
      const trigField = await hit("8b-trigger-field", "PATCH", `/v3/tables/${probeTableId}/run`, {
        fieldIds: [probeFieldId],
        runRecords: "all",
        forceRun: false,
        callerName: "99percent-probe",
      });
      log("8b-trigger-field", trigField);
      await delay(200);
    }
  }

  // ── 9. v3 row access ──────────────────────────────────────────────
  if (probeTableId) {
    console.log("\n\n>>> PROBE 9a: v3 rows (GET /v3/tables/{id}/rows)");
    const rows = await hit("9a-v3-rows", "GET", `/v3/tables/${probeTableId}/rows`);
    log("9a-v3-rows", rows);
    await delay(200);

    console.log("\n>>> PROBE 9b: v3 rows with query params");
    const rows2 = await hit("9b-v3-rows-params", "GET", `/v3/tables/${probeTableId}/rows?limit=5&offset=0`);
    log("9b-v3-rows-params", rows2);
    await delay(200);

    // Also try POST /v3/tables/{id}/rows for bulk write
    console.log("\n>>> PROBE 9c: v3 rows POST — empty body");
    const rowsPost = await hit("9c-v3-rows-post", "POST", `/v3/tables/${probeTableId}/rows`, {});
    log("9c-v3-rows-post", rowsPost);
    await delay(200);
  }

  // ── 10. Import/export ──────────────────────────────────────────────
  console.log("\n\n>>> PROBE 10a: Import history (GET /v3/imports?workspaceId=)");
  const imports = await hit("10a-imports", "GET", `/v3/imports?workspaceId=${WORKSPACE}`);
  log("10a-imports", imports);
  await delay(200);

  if (probeTableId) {
    console.log("\n>>> PROBE 10b: CSV export (GET /v3/exports/csv?tableId=)");
    const csvExport = await hit("10b-export-csv", "GET", `/v3/exports/csv?tableId=${probeTableId}`);
    log("10b-export-csv", csvExport);
    await delay(200);
  }

  // ── 11. Bonus probes — misc undocumented endpoints ─────────────────
  console.log("\n\n>>> PROBE 11a: Workspace detail (GET /v3/workspaces/{id})");
  const ws = await hit("11a-workspace", "GET", `/v3/workspaces/${WORKSPACE}`);
  log("11a-workspace", ws);
  await delay(200);

  console.log("\n>>> PROBE 11b: User's workspaces list (GET /v3/workspaces)");
  const wsList = await hit("11b-workspaces-list", "GET", `/v3/workspaces`);
  log("11b-workspaces-list", wsList);
  await delay(200);

  // Billing/usage — does the API expose this?
  console.log("\n>>> PROBE 11c: Billing/usage (GET /v3/billing?workspaceId=)");
  const billing = await hit("11c-billing", "GET", `/v3/billing?workspaceId=${WORKSPACE}`);
  log("11c-billing", billing);
  await delay(200);

  console.log("\n>>> PROBE 11d: Credits/usage (GET /v3/credits?workspaceId=)");
  const credits = await hit("11d-credits", "GET", `/v3/credits?workspaceId=${WORKSPACE}`);
  log("11d-credits", credits);
  await delay(200);

  // Templates
  console.log("\n>>> PROBE 11e: Templates (GET /v3/templates?workspaceId=)");
  const templates = await hit("11e-templates", "GET", `/v3/templates?workspaceId=${WORKSPACE}`);
  log("11e-templates", templates);
  await delay(200);

  // Integrations/connections
  console.log("\n>>> PROBE 11f: Integrations (GET /v3/integrations?workspaceId=)");
  const integrations = await hit("11f-integrations", "GET", `/v3/integrations?workspaceId=${WORKSPACE}`);
  log("11f-integrations", integrations);
  await delay(200);

  // Auth accounts — the big prize for enrichment automation
  console.log("\n>>> PROBE 11g: Auth accounts (GET /v3/auth-accounts?workspaceId=)");
  const authAccounts = await hit("11g-auth-accounts", "GET", `/v3/auth-accounts?workspaceId=${WORKSPACE}`);
  log("11g-auth-accounts", authAccounts);
  await delay(200);

  console.log("\n>>> PROBE 11h: Auth accounts alt (GET /v3/authAccounts?workspaceId=)");
  const authAccounts2 = await hit("11h-authAccounts-camel", "GET", `/v3/authAccounts?workspaceId=${WORKSPACE}`);
  log("11h-authAccounts-camel", authAccounts2);
  await delay(200);

  console.log("\n>>> PROBE 11i: Providers (GET /v3/providers?workspaceId=)");
  const providers = await hit("11i-providers", "GET", `/v3/providers?workspaceId=${WORKSPACE}`);
  log("11i-providers", providers);
  await delay(200);

  // ── 12. Rate limit probing ─────────────────────────────────────────
  console.log("\n\n>>> PROBE 12: Rate limit test — rapid-fire /v3/me");
  const rateResults: { i: number; status: number; latencyMs: number }[] = [];
  for (let i = 0; i < 20; i++) {
    const start = Date.now();
    try {
      const resp = await fetch(`${API_BASE}/v3/me`, {
        headers: { Cookie: COOKIE, Accept: "application/json" },
      });
      rateResults.push({ i, status: resp.status, latencyMs: Date.now() - start });
      // Check for rate-limit headers
      if (i === 0) {
        const rl: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          if (k.toLowerCase().includes("rate") || k.toLowerCase().includes("retry") || k.toLowerCase().includes("x-ratelimit")) {
            rl[k] = v;
          }
        });
        if (Object.keys(rl).length > 0) console.log(`  Rate-limit headers: ${JSON.stringify(rl)}`);
      }
      // No delay — fire as fast as possible
    } catch (err: any) {
      rateResults.push({ i, status: 0, latencyMs: Date.now() - start });
    }
  }
  const rateLimited = rateResults.filter(r => r.status === 429);
  const avgLatency = Math.round(rateResults.reduce((s, r) => s + r.latencyMs, 0) / rateResults.length);
  console.log(`  20 rapid requests: ${rateLimited.length} rate-limited (429), avg latency ${avgLatency}ms`);
  console.log(`  Statuses: ${rateResults.map(r => r.status).join(", ")}`);
  results.push({
    probe: "12-rate-limit",
    method: "GET",
    url: `${API_BASE}/v3/me`,
    status: rateLimited.length > 0 ? 429 : 200,
    latencyMs: avgLatency,
    body: { attempts: 20, rateLimited: rateLimited.length, results: rateResults },
    headers: {},
  });

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log(`\nTotal probes: ${results.length}`);
  console.log("");

  const byStatus: Record<string, string[]> = {};
  for (const r of results) {
    const bucket = r.error ? "network_error"
      : r.status === 200 ? "200_OK"
      : r.status === 401 ? "401_unauth"
      : r.status === 400 ? "400_validation"
      : r.status === 404 ? "404_not_found"
      : r.status === 429 ? "429_rate_limited"
      : `${r.status}`;
    if (!byStatus[bucket]) byStatus[bucket] = [];
    byStatus[bucket].push(r.probe);
  }
  for (const [status, probes] of Object.entries(byStatus).sort()) {
    console.log(`  ${status}: ${probes.join(", ")}`);
  }

  // Discoveries — endpoints that returned 200 or 400 (exists!)
  console.log("\n\nDISCOVERIES (new endpoints that responded):");
  const discoveries = results.filter(r => r.status === 200 || r.status === 400);
  for (const d of discoveries) {
    const bodyKeys = d.body && typeof d.body === "object" && !Array.isArray(d.body)
      ? Object.keys(d.body).join(", ")
      : Array.isArray(d.body) ? `Array[${d.body.length}]` : typeof d.body;
    console.log(`  ${d.probe}: ${d.method} ${d.url.replace(API_BASE, "")} → ${d.status} | keys: ${bodyKeys}`);
  }

  console.log("\n\nNOT FOUND (confirmed 404):");
  const notFound = results.filter(r => r.status === 404);
  for (const d of notFound) {
    console.log(`  ${d.probe}: ${d.method} ${d.url.replace(API_BASE, "")}`);
  }

  // Save full results
  const outPath = path.join(__dirname, "..", "results", "explore-session-2.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to: ${outPath}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
