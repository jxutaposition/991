/**
 * INV-022: Source Scheduling Investigation
 *
 * Goal: Determine whether scheduling fields (cron, schedule, scheduleEnabled,
 * nextRunAt) actually persist on tables and sources, and whether any v3
 * endpoint exists to manage scheduled runs.
 *
 * MUST NOT cost credits: only schemaless PATCH/GET on a scratch table and a
 * scratch webhook source. No enrichment columns, no /run, no auto-run on
 * inserted rows.
 */
import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE_ID = 1080480;
const RESULTS_DIR = path.join(__dirname, "..", "results");
const COOKIE_FILE = path.join(RESULTS_DIR, ".session-cookies.json");

function loadCookies(): string {
  const c = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return c.map((x: any) => `${x.name}=${x.value}`).join("; ");
}

async function call(
  method: string,
  url: string,
  body: any,
  cookieHeader: string,
  label: string,
) {
  const start = Date.now();
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "application/json",
  };
  let finalBody: any;
  if (body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    finalBody = JSON.stringify(body);
  }
  let status = 0;
  let responseBody: any = null;
  try {
    const r = await fetch(url, { method, headers, body: finalBody });
    status = r.status;
    try {
      responseBody = await r.json();
    } catch {
      responseBody = await r.text().catch(() => null);
    }
  } catch (e: any) {
    responseBody = { error: e.message };
  }
  return {
    label,
    method,
    url,
    status,
    requestBody: body,
    responseBody,
    latencyMs: Date.now() - start,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findKeysDeep(obj: any, needles: string[]): Record<string, any> {
  const found: Record<string, any> = {};
  const seen = new WeakSet();
  function walk(o: any, p: string) {
    if (!o || typeof o !== "object") return;
    if (seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      const path = p ? `${p}.${k}` : k;
      if (needles.some((n) => k.toLowerCase().includes(n.toLowerCase()))) {
        found[path] = v;
      }
      if (v && typeof v === "object") walk(v, path);
    }
  }
  walk(obj, "");
  return found;
}

async function main() {
  const cookie = loadCookies();
  const out: any[] = [];
  const SCHEDULE_KEYS = [
    "schedule",
    "cron",
    "nextRun",
    "lastRun",
    "frequency",
    "interval",
    "trigger",
    "recur",
  ];

  // ── 1. Create scratch table ──────────────────────────────────────────────
  const mk = await call(
    "POST",
    `${API_BASE}/v3/tables`,
    { workspaceId: WORKSPACE_ID, type: "spreadsheet", name: "INV-022 scheduling" },
    cookie,
    "create-table",
  );
  out.push(mk);
  if (mk.status === 401 || mk.status === 403) {
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-022-source-scheduling-AUTHFAIL-${Date.now()}.json`),
      JSON.stringify(out, null, 2),
    );
    console.error("AUTH FAILURE — aborting");
    process.exit(2);
  }
  const tableId = mk.responseBody?.id || mk.responseBody?.table?.id;
  console.log("tableId", tableId);
  await sleep(150);

  // Pre-existing tableSettings
  const initialGet = await call("GET", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "initial-get-table");
  out.push(initialGet);
  const initialSettings =
    initialGet.responseBody?.table?.tableSettings ||
    initialGet.responseBody?.tableSettings;
  console.log("initial tableSettings:", JSON.stringify(initialSettings));
  await sleep(150);

  // ── 2. Try various tableSettings.schedule shapes ─────────────────────────
  const tableScheduleShapes = [
    {
      label: "tableSettings.cronExpression-5field",
      body: { tableSettings: { cronExpression: "0 * * * *" } },
    },
    {
      label: "tableSettings.cronExpression-6field",
      body: { tableSettings: { cronExpression: "0 0 * * * *" } },
    },
    {
      label: "tableSettings.cronExpression-hourly-alias",
      body: { tableSettings: { cronExpression: "@hourly" } },
    },
    {
      label: "tableSettings.cronExpression-daily-alias",
      body: { tableSettings: { cronExpression: "@daily" } },
    },
    {
      label: "tableSettings.schedule-string",
      body: { tableSettings: { schedule: "0 12 * * *" } },
    },
    {
      label: "tableSettings.schedule-object",
      body: {
        tableSettings: {
          schedule: {
            cron: "0 12 * * *",
            timezone: "America/Los_Angeles",
            enabled: true,
          },
        },
      },
    },
    {
      label: "tableSettings.scheduleEnabled-bool",
      body: { tableSettings: { scheduleEnabled: true } },
    },
    {
      label: "tableSettings.HAS_SCHEDULED_RUNS-true",
      body: { tableSettings: { HAS_SCHEDULED_RUNS: true } },
    },
    {
      label: "tableSettings.nextRunAt",
      body: {
        tableSettings: {
          nextRunAt: "2030-01-01T00:00:00.000Z",
          lastRunAt: "2026-04-07T00:00:00.000Z",
        },
      },
    },
    {
      label: "tableSettings.scheduleStatus",
      body: { tableSettings: { scheduleStatus: "ACTIVE" } },
    },
    {
      label: "tableSettings.runFrequency",
      body: {
        tableSettings: {
          runFrequency: "DAILY",
          runFrequencyConfig: { hour: 9, timezone: "UTC" },
        },
      },
    },
    {
      label: "top-level-cronExpression",
      body: { cronExpression: "0 * * * *" },
    },
    {
      label: "top-level-schedule-object",
      body: { schedule: { cron: "0 * * * *", enabled: true } },
    },
  ];

  for (const s of tableScheduleShapes) {
    const r = await call("PATCH", `${API_BASE}/v3/tables/${tableId}`, s.body, cookie, `patch-table-${s.label}`);
    out.push(r);
    console.log(`PATCH ${s.label} → ${r.status}`);
    await sleep(150);
  }

  // Read back final tableSettings
  const finalGetTable = await call("GET", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "final-get-table");
  out.push(finalGetTable);
  const finalSettings =
    finalGetTable.responseBody?.table?.tableSettings ||
    finalGetTable.responseBody?.tableSettings;
  console.log("\nFINAL tableSettings:", JSON.stringify(finalSettings, null, 2));
  const tableScheduleHits = findKeysDeep(finalGetTable.responseBody, SCHEDULE_KEYS);
  console.log("Schedule-ish keys found in table response:", JSON.stringify(tableScheduleHits, null, 2));
  await sleep(150);

  // ── 3. Create scratch webhook source ─────────────────────────────────────
  const mkSource = await call(
    "POST",
    `${API_BASE}/v3/sources`,
    {
      workspaceId: WORKSPACE_ID,
      tableId,
      name: "INV-022 source",
      type: "manual",
      typeSettings: {},
    },
    cookie,
    "create-source",
  );
  out.push(mkSource);
  const sourceId =
    mkSource.responseBody?.id || mkSource.responseBody?.source?.id;
  console.log("sourceId", sourceId);
  await sleep(150);

  // Initial source state
  const initialSource = await call("GET", `${API_BASE}/v3/sources/${sourceId}`, null, cookie, "initial-get-source");
  out.push(initialSource);
  const initialSourceHits = findKeysDeep(initialSource.responseBody, SCHEDULE_KEYS);
  console.log("initial source schedule-ish keys:", JSON.stringify(initialSourceHits));
  await sleep(150);

  // ── 4. Try various source schedule shapes ────────────────────────────────
  const sourceScheduleShapes = [
    {
      label: "typeSettings.cronExpression",
      body: { typeSettings: { cronExpression: "0 * * * *" } },
    },
    {
      label: "typeSettings.schedule-object",
      body: {
        typeSettings: {
          schedule: {
            cron: "0 12 * * *",
            timezone: "UTC",
            enabled: true,
          },
        },
      },
    },
    {
      label: "typeSettings.scheduleEnabled",
      body: { typeSettings: { scheduleEnabled: true, schedule: "@daily" } },
    },
    {
      label: "typeSettings.runFrequency",
      body: {
        typeSettings: {
          runFrequency: "DAILY",
          runFrequencyConfig: { hour: 9, minute: 0, timezone: "UTC" },
        },
      },
    },
    {
      label: "typeSettings.nextRunAt",
      body: {
        typeSettings: {
          nextRunAt: "2030-01-01T00:00:00.000Z",
        },
      },
    },
    {
      label: "top-level-schedule",
      body: { schedule: { cron: "0 12 * * *", enabled: true } },
    },
    {
      label: "top-level-cronExpression",
      body: { cronExpression: "0 * * * *" },
    },
    {
      label: "top-level-scheduleEnabled",
      body: { scheduleEnabled: true },
    },
    {
      label: "isScheduled-flag",
      body: { isScheduled: true, scheduleConfig: { cron: "0 * * * *" } },
    },
  ];

  for (const s of sourceScheduleShapes) {
    const r = await call("PATCH", `${API_BASE}/v3/sources/${sourceId}`, s.body, cookie, `patch-source-${s.label}`);
    out.push(r);
    console.log(`PATCH source ${s.label} → ${r.status}`);
    await sleep(150);
  }

  // Read source back
  const finalSource = await call("GET", `${API_BASE}/v3/sources/${sourceId}`, null, cookie, "final-get-source");
  out.push(finalSource);
  const finalSourceHits = findKeysDeep(finalSource.responseBody, SCHEDULE_KEYS);
  console.log("\nFINAL source schedule-ish keys:", JSON.stringify(finalSourceHits, null, 2));
  console.log("FINAL source typeSettings:", JSON.stringify(finalSource.responseBody?.typeSettings || finalSource.responseBody?.source?.typeSettings, null, 2));
  await sleep(150);

  // ── 5. Probe additional endpoint candidates ──────────────────────────────
  const endpointProbes = [
    { method: "GET", path: `/v3/tables/${tableId}/schedule` },
    { method: "GET", path: `/v3/tables/${tableId}/schedules` },
    { method: "GET", path: `/v3/tables/${tableId}/scheduled-runs` },
    { method: "GET", path: `/v3/tables/${tableId}/runs` },
    { method: "GET", path: `/v3/sources/${sourceId}/schedule` },
    { method: "GET", path: `/v3/sources/${sourceId}/runs` },
    { method: "GET", path: `/v3/sources/${sourceId}/next-run` },
    { method: "GET", path: `/v3/workspaces/${WORKSPACE_ID}/scheduled-runs` },
    { method: "GET", path: `/v3/workspaces/${WORKSPACE_ID}/scheduled-tables` },
    { method: "GET", path: `/v3/scheduled-runs?workspaceId=${WORKSPACE_ID}` },
    { method: "GET", path: `/v3/scheduled-tables?workspaceId=${WORKSPACE_ID}` },
    { method: "GET", path: `/v3/triggers?workspaceId=${WORKSPACE_ID}` },
    { method: "GET", path: `/v3/jobs?workspaceId=${WORKSPACE_ID}` },
    { method: "GET", path: `/v3/recurring-jobs?workspaceId=${WORKSPACE_ID}` },
    { method: "POST", path: `/v3/tables/${tableId}/schedule`, body: { cron: "0 * * * *", enabled: true } },
    { method: "POST", path: `/v3/sources/${sourceId}/schedule`, body: { cron: "0 * * * *", enabled: true } },
  ];
  for (const p of endpointProbes) {
    const r = await call(p.method, `${API_BASE}${p.path}`, (p as any).body || null, cookie, `probe-${p.method}-${p.path}`);
    out.push(r);
    console.log(`  ${p.method} ${p.path} → ${r.status}`);
    await sleep(150);
  }

  // ── 6. Cleanup ───────────────────────────────────────────────────────────
  if (sourceId) {
    const dels = await call("DELETE", `${API_BASE}/v3/sources/${sourceId}`, null, cookie, "delete-source");
    out.push(dels);
    console.log("delete source:", dels.status);
    await sleep(150);
  }
  if (tableId) {
    const delt = await call("DELETE", `${API_BASE}/v3/tables/${tableId}`, null, cookie, "delete-table");
    out.push(delt);
    console.log("delete table:", delt.status);
  }

  // Save raw + summary
  const ts = Date.now();
  const rawFile = path.join(RESULTS_DIR, `inv-022-source-scheduling-${ts}.json`);
  fs.writeFileSync(rawFile, JSON.stringify(out, null, 2));
  console.log("\nsaved raw →", rawFile);

  const summary = {
    initialTableSettings: initialSettings,
    finalTableSettings: finalSettings,
    tableScheduleKeysFound: tableScheduleHits,
    finalSourceTypeSettings:
      finalSource.responseBody?.typeSettings ||
      finalSource.responseBody?.source?.typeSettings,
    sourceScheduleKeysFound: finalSourceHits,
    endpointProbeStatuses: endpointProbes.map((p, i) => ({
      method: p.method,
      path: p.path,
      status: out[out.length - endpointProbes.length - 2 + i]?.status,
    })),
  };
  const summaryFile = path.join(RESULTS_DIR, `inv-022-source-scheduling-summary-${ts}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log("saved summary →", summaryFile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
