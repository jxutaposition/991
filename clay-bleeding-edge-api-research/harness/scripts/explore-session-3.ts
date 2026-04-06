/**
 * Exploration Session #3 — Reach Goals
 *
 * Now that the baseline is solid, push into the remaining unknowns:
 *
 *   1. authAccountId extraction — read enrichment columns to harvest authAccountIds
 *   2. Enrichment trigger — figure out exact runRecords format
 *   3. Webhook source creation + URL retrieval
 *   4. Table type differences — create spreadsheet vs company, compare
 *   5. Credit monitoring — read credits before/after an enrichment
 *   6. Source delete behavior
 *   7. Table search/recent/all endpoints — what do they return?
 *   8. Import webhook endpoint — can we get webhook URLs?
 *   9. Higher rate limit ceiling — 50 rapid requests
 *  10. v1 pagination — test limit/offset on real table
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx explore-session-3.ts
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
    if (clay) {
      console.log(`Loaded cookie from ${cookieFile}`);
      return `claysession=${clay.value}`;
    }
  }
  const env = process.env.CLAY_SESSION;
  if (env) return env.startsWith("claysession=") ? env : `claysession=${env}`;
  console.error("ERROR: No cookie found.");
  process.exit(1);
}

const COOKIE = loadCookie();

// Also need API key for v1 probes
const API_KEY = process.env.CLAY_API_KEY || "";

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

async function hit(probe: string, method: string, urlPath: string, body?: any, extraHeaders?: Record<string, string>): Promise<ProbeResult> {
  const url = `${API_BASE}${urlPath}`;
  const start = Date.now();
  const headers: Record<string, string> = { Cookie: COOKIE, Accept: "application/json", "Content-Type": "application/json", ...extraHeaders };
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
  const status = r.error ? `ERROR: ${r.error}` : `${r.status}`;
  const preview = r.body ? JSON.stringify(r.body).substring(0, 400) : "(empty)";
  console.log(`\n${"=".repeat(70)}`);
  console.log(`[${r.probe}] ${r.method} ${r.url.replace(API_BASE, "")}`);
  console.log(`  Status: ${status}  (${r.latencyMs}ms)`);
  console.log(`  Body: ${preview}`);
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Clay v3 API — Exploration Session #3 (Reach Goals)            ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // Verify session
  const me = await hit("0-session", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired. Get a fresh cookie."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}`);
  await delay(100);

  // ── 1. authAccountId Extraction ────────────────────────────────────
  // Find tables with enrichment columns, extract authAccountId from typeSettings
  console.log("\n\n>>> EXPERIMENT 1: authAccountId extraction from enrichment columns");

  const tables = await hit("1a-tables", "GET", `/v3/workspaces/${WORKSPACE}/tables`);
  const tableList = tables.body?.results || [];
  console.log(`  ${tableList.length} tables to scan`);

  const authAccounts: Map<string, { provider: string; actionKey: string; tableName: string; fieldName: string }> = new Map();

  for (const t of tableList.slice(0, 5)) { // scan up to 5 tables
    await delay(50);
    const schema = await hit(`1b-schema-${t.name}`, "GET", `/v3/tables/${t.id}`);
    if (schema.status !== 200) continue;

    // Fields might be nested under table key
    const fields = schema.body?.fields || schema.body?.table?.fields || [];
    for (const f of fields) {
      if (f.type === "action" && f.typeSettings?.authAccountId) {
        const key = f.typeSettings.authAccountId;
        if (!authAccounts.has(key)) {
          authAccounts.set(key, {
            provider: f.typeSettings.actionKey || "unknown",
            actionKey: f.typeSettings.actionKey || "",
            tableName: t.name,
            fieldName: f.name,
          });
        }
      }
    }
  }

  console.log(`\n  AUTH ACCOUNTS FOUND: ${authAccounts.size}`);
  for (const [id, info] of authAccounts) {
    console.log(`    ${id} | provider: ${info.provider} | from: ${info.tableName} → ${info.fieldName}`);
  }

  // ── 2. Enrichment Trigger — runRecords format ──────────────────────
  console.log("\n\n>>> EXPERIMENT 2: enrichment trigger runRecords format");

  // Find a table with at least one field
  let triggerTable: string | null = null;
  let triggerField: string | null = null;

  for (const t of tableList) {
    const cached = results.find(r => r.probe === `1b-schema-${t.name}` && r.status === 200);
    if (cached) {
      const fields = cached.body?.fields || cached.body?.table?.fields || [];
      if (fields.length > 0) {
        triggerTable = t.id;
        triggerField = fields[0].id;
        break;
      }
    }
  }

  if (triggerTable && triggerField) {
    // Try different runRecords shapes
    const shapes = [
      { label: "empty-object", payload: { fieldIds: [triggerField], runRecords: {} } },
      { label: "all-true", payload: { fieldIds: [triggerField], runRecords: { all: true } } },
      { label: "empty-recordIds", payload: { fieldIds: [triggerField], runRecords: { recordIds: [] } } },
      { label: "allRecords-key", payload: { fieldIds: [triggerField], runRecords: { allRecords: true } } },
    ];

    for (const { label, payload } of shapes) {
      await delay(100);
      const r = await hit(`2-trigger-${label}`, "PATCH", `/v3/tables/${triggerTable}/run`, payload);
      log(r);
    }
  } else {
    console.log("  SKIPPED — no table with fields found");
  }

  // ── 3. Webhook Source Creation + URL Retrieval ─────────────────────
  console.log("\n\n>>> EXPERIMENT 3: webhook source creation + URL retrieval");

  // Use first table for webhook test
  const webhookTable = tableList[0]?.id;
  if (webhookTable) {
    // Create a webhook source
    const createSrc = await hit("3a-create-webhook", "POST", "/v3/sources", {
      workspaceId: parseInt(WORKSPACE),
      tableId: webhookTable,
      name: "probe-webhook-test",
      type: "webhook",
      typeSettings: { hasAuth: false, iconType: "Webhook" },
    });
    log(createSrc);
    await delay(100);

    if (createSrc.status >= 200 && createSrc.status < 300) {
      const srcId = createSrc.body?.id;
      if (srcId) {
        // Read it back to look for webhook URL
        const readSrc = await hit("3b-read-webhook", "GET", `/v3/sources/${srcId}`);
        log(readSrc);
        if (readSrc.body) {
          console.log(`  All keys: ${Object.keys(readSrc.body).join(", ")}`);
          console.log(`  webhookUrl: ${readSrc.body.webhookUrl ?? readSrc.body.url ?? readSrc.body.webhook_url ?? "NOT FOUND"}`);
          console.log(`  typeSettings: ${JSON.stringify(readSrc.body.typeSettings)}`);
        }
        await delay(100);

        // Clean up — delete the test source
        const delSrc = await hit("3c-delete-webhook", "DELETE", `/v3/sources/${srcId}`);
        log(delSrc);
      }
    }
  }

  // ── 4. Table Type Comparison ───────────────────────────────────────
  console.log("\n\n>>> EXPERIMENT 4: table type comparison (spreadsheet vs company)");

  const typesToTest = ["spreadsheet", "company"];
  const createdTables: { type: string; id: string }[] = [];

  for (const type of typesToTest) {
    await delay(100);
    const create = await hit(`4a-create-${type}`, "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE),
      type,
      name: `probe-type-test-${type}`,
    });
    log(create);
    if (create.status >= 200 && create.status < 300) {
      const id = create.body?.id || create.body?.table?.id;
      if (id) {
        createdTables.push({ type, id });
        // Read full schema
        await delay(100);
        const schema = await hit(`4b-schema-${type}`, "GET", `/v3/tables/${id}`);
        if (schema.status === 200) {
          const fields = schema.body?.fields || schema.body?.table?.fields || [];
          const views = schema.body?.views || schema.body?.table?.views || [];
          console.log(`  ${type}: ${fields.length} fields, ${views.length} views`);
          console.log(`  Field names: ${fields.map((f: any) => f.name).join(", ")}`);
        }
      }
    }
  }

  // Clean up test tables
  for (const t of createdTables) {
    await delay(100);
    await hit(`4c-delete-${t.type}`, "DELETE", `/v3/tables/${t.id}`);
  }

  // ── 5. Credit Monitoring ───────────────────────────────────────────
  console.log("\n\n>>> EXPERIMENT 5: credit monitoring");
  const ws = await hit("5-workspace-credits", "GET", `/v3/workspaces/${WORKSPACE}`);
  if (ws.status === 200 && ws.body) {
    console.log(`  Credits: ${JSON.stringify(ws.body.credits)}`);
    console.log(`  Credit budgets: ${JSON.stringify(ws.body.creditBudgets)}`);
    console.log(`  Current period end: ${ws.body.currentPeriodEnd}`);
    console.log(`  Cents per credit: ${ws.body.centsPerCredit}`);
  }

  // ── 6. Table Search/Recent/All ─────────────────────────────────────
  console.log("\n\n>>> EXPERIMENT 6: table listing variants");
  await delay(100);
  const recent = await hit("6a-tables-recent", "GET", "/v3/tables/recent");
  log(recent);
  await delay(100);
  const list = await hit("6b-tables-list", "GET", "/v3/tables/list");
  log(list);
  await delay(100);
  const search = await hit("6c-tables-search", "GET", `/v3/tables/search?query=test&workspaceId=${WORKSPACE}`);
  log(search);
  await delay(100);
  const all = await hit("6d-tables-all", "GET", `/v3/tables/all?workspaceId=${WORKSPACE}`);
  log(all);

  // ── 7. Import Webhook ──────────────────────────────────────────────
  console.log("\n\n>>> EXPERIMENT 7: import webhook endpoint");
  await delay(100);
  const impWebhook = await hit("7a-imports-webhook", "GET", `/v3/imports/webhook?workspaceId=${WORKSPACE}`);
  log(impWebhook);
  await delay(100);
  const impCsv = await hit("7b-imports-csv", "GET", `/v3/imports/csv?workspaceId=${WORKSPACE}`);
  log(impCsv);

  // ── 8. Higher Rate Limit Ceiling ───────────────────────────────────
  console.log("\n\n>>> EXPERIMENT 8: rate limit ceiling (50 rapid requests)");
  const rateResults: { i: number; status: number; ms: number }[] = [];
  for (let i = 0; i < 50; i++) {
    const start = Date.now();
    try {
      const r = await fetch(`${API_BASE}/v3/me`, { headers: { Cookie: COOKIE, Accept: "application/json" } });
      rateResults.push({ i, status: r.status, ms: Date.now() - start });
    } catch {
      rateResults.push({ i, status: 0, ms: Date.now() - start });
    }
  }
  const limited = rateResults.filter(r => r.status === 429);
  const avg = Math.round(rateResults.reduce((s, r) => s + r.ms, 0) / rateResults.length);
  console.log(`  50 rapid requests: ${limited.length} rate-limited, avg ${avg}ms`);
  console.log(`  Statuses: ${rateResults.map(r => r.status).join(",")}`);
  results.push({
    probe: "8-rate-limit-50",
    method: "GET",
    url: `${API_BASE}/v3/me`,
    status: limited.length > 0 ? 429 : 200,
    latencyMs: avg,
    body: { attempts: 50, rateLimited: limited.length, results: rateResults },
    headers: {},
  });

  // ── 9. v1 Pagination ──────────────────────────────────────────────
  if (API_KEY) {
    console.log("\n\n>>> EXPERIMENT 9: v1 row pagination");
    const testTable = tableList[0]?.id;
    if (testTable) {
      const page1 = await hit("9a-v1-page1", "GET", `/api/v1/tables/${testTable}/rows?limit=2&offset=0`, undefined, { Authorization: `Bearer ${API_KEY}`, Cookie: "" });
      log(page1);
      await delay(100);
      const page2 = await hit("9b-v1-page2", "GET", `/api/v1/tables/${testTable}/rows?limit=2&offset=2`, undefined, { Authorization: `Bearer ${API_KEY}`, Cookie: "" });
      log(page2);
    }
  } else {
    console.log("\n\n>>> EXPERIMENT 9: SKIPPED — set CLAY_API_KEY env var for v1 pagination test");
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(70));
  console.log("SESSION 3 SUMMARY");
  console.log("=".repeat(70));
  console.log(`Total probes: ${results.length}`);

  console.log(`\nauthAccountIds found: ${authAccounts.size}`);
  for (const [id, info] of authAccounts) {
    console.log(`  ${id} → ${info.provider}`);
  }

  const byStatus: Record<string, string[]> = {};
  for (const r of results) {
    const bucket = r.error ? "error" : `${r.status}`;
    if (!byStatus[bucket]) byStatus[bucket] = [];
    byStatus[bucket].push(r.probe);
  }
  for (const [s, probes] of Object.entries(byStatus).sort()) {
    console.log(`\n  ${s}: ${probes.join(", ")}`);
  }

  // Save results
  const outPath = path.join(__dirname, "..", "results", "explore-session-3.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to: ${outPath}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
