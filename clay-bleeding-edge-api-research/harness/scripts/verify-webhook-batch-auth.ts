/**
 * INV-028: API-key auth for postWebhookBatch + productized inbound webhook channel
 *
 * Bundle resolved 2026-04-07: index-BS8vlUPJ.js
 *
 * Router discovered: TRe (apiKeys:TRe in client router map @838019).
 * All routes mount under https://api.clay.com/v3/ (global base).
 *
 *   getApiKeys     GET    /api-keys?resourceType&resourceId
 *   createApiKey   POST   /api-keys
 *     body: { resourceType:'user', resourceId:<userId str>, name, scope:{routes:Kb[], workspaceId?:number} }
 *     200:  { ...keyRecord, apiKey: '<plaintext key, shown once>' }
 *   updateApiKey   PATCH  /api-keys/:apiKeyId  body:{ name?, workspaceId? }
 *   deleteApiKey   DELETE /api-keys/:apiKeyId  body:{}
 *
 * Scope enum (Kb): 'all' | 'endpoints:run-enrichment' | 'endpoints:prospect-search-api' |
 *                  'terracotta:cli' | 'terracotta:code-node' | 'terracotta:mcp' |
 *                  'public-endpoints:all'
 * Resource enum (Gb): 'user' (only)
 *
 * UI defaults (from CreateApiKeyModal form @8143500): scopeOptions with
 * public-endpoints:all = true. Form submission collects only the three
 * UI-exposed scopes: ['all','endpoints:prospect-search-api','public-endpoints:all'].
 *
 * Strategy:
 *   1. Mint a scratch API key via POST /v3/api-keys. Persist to .api-keys.json (gitignored).
 *   2. Build an inert tc-workflow + webhook stream (INV-027 pattern).
 *   3. Probe postWebhookBatch + non-/v3 webhook URL under multiple auth schemes.
 *   4. Iterate body shapes if 400.
 *   5. Poll stream runs to verify batch ingestion produces N runs.
 *   6. Cleanup: stream, workflow, scratch API key.
 */
import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE_ID = 1080480;
const RESULTS_DIR = path.join(__dirname, "..", "results");
const COOKIE_FILE = path.join(RESULTS_DIR, ".session-cookies.json");
const API_KEYS_FILE = path.join(RESULTS_DIR, ".api-keys.json");

function loadCookies(): string {
  const c = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return c.map((x: any) => `${x.name}=${x.value}`).join("; ");
}

type Result = { label: string; method: string; url: string; status: number; response: any };
const out: Result[] = [];

async function call(
  method: string,
  url: string,
  body: any,
  headers: Record<string, string>,
  label: string,
): Promise<Result> {
  const h: Record<string, string> = { Accept: "application/json", ...headers };
  let finalBody: any;
  if (body !== null && body !== undefined && method !== "GET") {
    h["Content-Type"] = "application/json";
    finalBody = JSON.stringify(body);
  }
  const r = await fetch(url, { method, headers: h, body: finalBody });
  const text = await r.text().catch(() => "");
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.substring(0, 800);
  }
  // Redact any apiKey field before logging/saving
  const safeResp = redact(parsed);
  const res = { label, method, url, status: r.status, response: safeResp };
  console.log(`[${label}] ${method} ${url.replace(API_BASE, "")} -> ${r.status}`);
  out.push(res);
  await new Promise((r) => setTimeout(r, 200));
  return { ...res, response: parsed }; // return raw for internal use
}

function redact(v: any): any {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redact);
  const copy: any = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === "apiKey" && typeof val === "string") copy[k] = "[REDACTED]";
    else copy[k] = redact(val);
  }
  return copy;
}

async function main() {
  const cookie = loadCookies();
  const cookieHeader = { Cookie: cookie };
  const startedAt = Date.now();

  // Auth check
  const me = await call("GET", `${API_BASE}/v3/me`, null, cookieHeader, "auth-check");
  if (me.status !== 200) {
    console.error("session expired - STOP");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `inv-028-key-auth-${startedAt}.json`),
      JSON.stringify(out, null, 2),
    );
    process.exit(2);
  }
  const userId: number | string | undefined = me.response?.user?.id ?? me.response?.id;
  console.log("userId=", userId);

  // Credits before
  const wsBefore = await call(
    "GET",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}`,
    null,
    cookieHeader,
    "credits-before",
  );
  const creditsBefore = wsBefore.response?.credits;

  // ======================================================================
  // STEP 1: Discover existing API keys for the user
  // ======================================================================
  await call(
    "GET",
    `${API_BASE}/v3/api-keys?resourceType=user&resourceId=${userId}`,
    null,
    cookieHeader,
    "list-api-keys-existing",
  );

  // Also probe workspace-scoped list (in case resourceType expanded)
  await call(
    "GET",
    `${API_BASE}/v3/api-keys?resourceType=workspace&resourceId=${WORKSPACE_ID}`,
    null,
    cookieHeader,
    "list-api-keys-workspace-probe",
  );

  // ======================================================================
  // STEP 2: Mint a scratch API key
  // ======================================================================
  // Form from bundle: scope.routes include 'public-endpoints:all'; scope.workspaceId is the numeric ws id
  let apiKey: string | undefined;
  let apiKeyId: string | undefined;
  const createdAt = new Date().toISOString();

  const createKey = await call(
    "POST",
    `${API_BASE}/v3/api-keys`,
    {
      name: `INV-028 scratch ${Date.now()}`,
      resourceType: "user",
      resourceId: String(userId),
      scope: {
        routes: ["all", "public-endpoints:all", "endpoints:run-enrichment"],
        workspaceId: WORKSPACE_ID,
      },
    },
    cookieHeader,
    "create-api-key",
  );
  if (createKey.status === 200) {
    apiKey = createKey.response?.apiKey;
    apiKeyId = createKey.response?.id;
    console.log("mintedKeyId=", apiKeyId, " keyPrefix=", apiKey?.slice(0, 6));
    // Persist (gitignored)
    fs.writeFileSync(
      API_KEYS_FILE,
      JSON.stringify({ id: apiKeyId, apiKey, createdAt, scopes: ["all", "public-endpoints:all", "endpoints:run-enrichment"] }, null, 2),
    );
  } else {
    console.log("createApiKey failed, will proceed with no-key probes only");
  }

  // ======================================================================
  // STEP 3: Build inert tc-workflow + webhook stream (INV-027 pattern)
  // ======================================================================
  const wfR = await call(
    "POST",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
    { name: `INV-028 webhook-batch scratch ${Date.now()}` },
    cookieHeader,
    "create-wf",
  );
  const wfId: string | undefined = wfR.response?.workflow?.id;
  console.log("wfId=", wfId);

  let nodeId1: string | undefined;
  let nodeId2: string | undefined;
  let edgeId: string | undefined;
  let streamId: string | undefined;
  let webhookUrl: string | undefined;

  try {
    if (!wfId) throw new Error("failed to create workflow");

    const n1 = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`,
      { name: "initial (inert)", nodeType: "regular", position: { x: 100, y: 100 }, isInitial: true },
      cookieHeader,
      "create-node-initial",
    );
    nodeId1 = n1.response?.node?.id;

    const n2 = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`,
      { name: "terminal (inert)", nodeType: "regular", position: { x: 300, y: 100 }, isTerminal: true },
      cookieHeader,
      "create-node-terminal",
    );
    nodeId2 = n2.response?.node?.id;

    if (nodeId1 && nodeId2) {
      const e = await call(
        "POST",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/edges`,
        { sourceNodeId: nodeId1, targetNodeId: nodeId2 },
        cookieHeader,
        "create-edge",
      );
      edgeId = e.response?.edge?.id;
    }

    // Seed direct run -> snapshot
    const seedRun = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`,
      { inputs: {} },
      cookieHeader,
      "seed-run-for-snapshot",
    );
    const snapshotId: string | undefined = seedRun.response?.workflowRun?.workflowSnapshotId;
    console.log("snapshotId=", snapshotId);

    // Create webhook stream
    const stream = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams`,
      {
        workflowSnapshotId: snapshotId,
        streamType: "webhook",
        name: "INV-028 webhook stream",
        config: {},
      },
      cookieHeader,
      "create-stream",
    );
    streamId = stream.response?.stream?.id;
    webhookUrl = stream.response?.stream?.webhookUrl;
    console.log("streamId=", streamId, " webhookUrl=", webhookUrl);
    if (!streamId) throw new Error("no streamId");

    // ==================================================================
    // STEP 4: Probe postWebhookBatch under multiple auth schemes
    // ==================================================================
    const batchBody = {
      items: [
        { requestData: { email: "batch1@example.com", company: "Alpha" } },
        { requestData: { email: "batch2@example.com", company: "Beta" }, entityId: 42 },
      ],
    };

    const batchUrl = `${API_BASE}/v3/tc-workflows/streams/${streamId}/webhook/batch`;
    const nonV3BatchUrl = `${API_BASE}/tc-workflows/streams/${streamId}/webhook/batch`;
    const nonV3SingleUrl = `${API_BASE}/tc-workflows/streams/${streamId}/webhook`;

    // Schemes (only if we have a key)
    const authSchemes: Array<{ label: string; headers: Record<string, string> }> = [];
    if (apiKey) {
      authSchemes.push(
        { label: "bearer", headers: { Authorization: `Bearer ${apiKey}` } },
        { label: "x-api-key", headers: { "x-api-key": apiKey } },
        { label: "x-clay-api-key", headers: { "x-clay-api-key": apiKey } },
        { label: "apikey", headers: { apikey: apiKey } },
      );
    }
    authSchemes.push({ label: "no-auth", headers: {} });
    authSchemes.push({ label: "cookie-only", headers: cookieHeader });

    // (a) postWebhookBatch (/v3 path) — every scheme
    for (const scheme of authSchemes) {
      await call("POST", batchUrl, batchBody, scheme.headers, `batch-v3-${scheme.label}`);
    }
    // (b) postWebhookBatch (non-/v3 path) — every scheme
    for (const scheme of authSchemes) {
      await call("POST", nonV3BatchUrl, batchBody, scheme.headers, `batch-no-v3-${scheme.label}`);
    }
    // (c) single postWebhook non-/v3 — every scheme
    for (const scheme of authSchemes) {
      await call(
        "POST",
        nonV3SingleUrl,
        { email: "single@example.com" },
        scheme.headers,
        `single-no-v3-${scheme.label}`,
      );
    }

    // ==================================================================
    // STEP 5: Iterate body shapes on whichever scheme accepted (or cookie 400)
    // ==================================================================
    // The bundle schema is { items: [{entityId?, backfillId?, requestData}] } — but let's also probe alts
    const altBodies: Array<{ label: string; body: any }> = [
      { label: "events-array", body: { events: [{ email: "a@x.com" }, { email: "b@x.com" }] } },
      { label: "records", body: { records: [{ email: "a@x.com" }, { email: "b@x.com" }] } },
      { label: "bare-array", body: [{ email: "a@x.com" }, { email: "b@x.com" }] },
      { label: "items-requestData-only", body: { items: [{ requestData: { email: "c@x.com" } }] } },
    ];

    // Try each alt under Bearer (if have key) AND cookie
    const probeHeaders: Array<{ label: string; headers: Record<string, string> }> = [
      { label: "cookie", headers: cookieHeader },
    ];
    if (apiKey) probeHeaders.push({ label: "bearer", headers: { Authorization: `Bearer ${apiKey}` } });

    for (const ph of probeHeaders) {
      for (const ab of altBodies) {
        await call("POST", batchUrl, ab.body, ph.headers, `shape-${ph.label}-${ab.label}`);
      }
    }

    // ==================================================================
    // STEP 6: Poll stream runs to see how many runs were created
    // ==================================================================
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const sr = await call(
        "GET",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${streamId}/runs`,
        null,
        cookieHeader,
        `stream-runs-poll-${i}`,
      );
      const total = sr.response?.total ?? sr.response?.runs?.length;
      console.log(`  stream-runs poll ${i}: total=${total}`);
    }
  } catch (e: any) {
    console.error("error:", e?.message || e);
    out.push({
      label: "main-error",
      method: "-",
      url: "-",
      status: -1,
      response: String(e?.message || e),
    });
  } finally {
    // Cleanup stream
    if (streamId && wfId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${streamId}`,
        {},
        cookieHeader,
        "cleanup-stream",
      );
    }
    if (edgeId && wfId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/edges/${edgeId}`,
        {},
        cookieHeader,
        "cleanup-edge",
      );
    }
    const nodeIds = [nodeId1, nodeId2].filter(Boolean) as string[];
    if (wfId && nodeIds.length) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`,
        { nodeIds },
        cookieHeader,
        "cleanup-nodes",
      );
    }
    if (wfId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}`,
        {},
        cookieHeader,
        "cleanup-wf",
      );
    }
    // Cleanup scratch API key
    if (apiKeyId) {
      await call(
        "DELETE",
        `${API_BASE}/v3/api-keys/${apiKeyId}`,
        {},
        cookieHeader,
        "cleanup-api-key",
      );
      // Wipe the plaintext file
      try {
        fs.unlinkSync(API_KEYS_FILE);
      } catch {}
    }

    const wsAfter = await call(
      "GET",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}`,
      null,
      cookieHeader,
      "credits-after",
    );
    const creditsAfter = wsAfter.response?.credits;
    out.push({
      label: "credit-delta",
      method: "-",
      url: "-",
      status: 0,
      response: { before: creditsBefore, after: creditsAfter },
    });

    const f = path.join(RESULTS_DIR, `inv-028-key-auth-${startedAt}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log("\nsaved", f);
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(RESULTS_DIR, `inv-028-key-auth-error-${Date.now()}.json`),
    JSON.stringify({ error: String(e), out }, null, 2),
  );
  process.exit(1);
});
