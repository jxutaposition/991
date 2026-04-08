/**
 * INV-028 pass 2: exhaust remaining auth schemes for postWebhookBatch.
 *
 * Pass 1 proved:
 *  - Canonical body {items:[{requestData}]} passes Zod (wrong shapes 400).
 *  - Cookies: 403 Forbidden
 *  - Bearer/no-auth/various headers with scope=['all','public-endpoints:all','endpoints:run-enrichment']: 401
 *  - Non-/v3 form: 404 (route is only registered under /v3)
 *
 * Pass 2: try every remaining scope combination and every additional header form.
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
    parsed = text.substring(0, 400);
  }
  const safeResp = redact(parsed);
  const res = { label, method, url, status: r.status, response: safeResp };
  console.log(`[${label}] -> ${r.status}`);
  out.push(res);
  await new Promise((r) => setTimeout(r, 150));
  return { ...res, response: parsed };
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

async function mintKey(cookie: Record<string, string>, userId: string, scopes: string[], label: string) {
  const r = await call(
    "POST",
    `${API_BASE}/v3/api-keys`,
    {
      name: `INV-028p2 ${label} ${Date.now()}`,
      resourceType: "user",
      resourceId: userId,
      scope: { routes: scopes, workspaceId: WORKSPACE_ID },
    },
    cookie,
    `mint-${label}`,
  );
  return { key: r.response?.apiKey as string | undefined, id: r.response?.id as string | undefined };
}

async function main() {
  const cookie = loadCookies();
  const cookieHeader = { Cookie: cookie };
  const startedAt = Date.now();

  const me = await call("GET", `${API_BASE}/v3/me`, null, cookieHeader, "auth-check");
  if (me.status !== 200) process.exit(2);
  const userId = String(me.response?.user?.id ?? me.response?.id);

  // Build scratch workflow + stream
  const wf = await call(
    "POST",
    `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows`,
    { name: `INV-028p2 ${Date.now()}` },
    cookieHeader,
    "create-wf",
  );
  const wfId: string = wf.response?.workflow?.id;

  let nodeId1: string | undefined, nodeId2: string | undefined, edgeId: string | undefined, streamId: string | undefined;
  const mintedIds: string[] = [];

  try {
    nodeId1 = (await call("POST", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`, { name:"i", nodeType:"regular", position:{x:0,y:0}, isInitial:true }, cookieHeader, "n1")).response?.node?.id;
    nodeId2 = (await call("POST", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`, { name:"t", nodeType:"regular", position:{x:200,y:0}, isTerminal:true }, cookieHeader, "n2")).response?.node?.id;
    edgeId = (await call("POST", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/edges`, { sourceNodeId:nodeId1, targetNodeId:nodeId2 }, cookieHeader, "edge")).response?.edge?.id;
    const seed = await call("POST", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/runs`, { inputs:{} }, cookieHeader, "seed");
    const snapshotId = seed.response?.workflowRun?.workflowSnapshotId;
    const stream = await call(
      "POST",
      `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams`,
      { workflowSnapshotId: snapshotId, streamType: "webhook", name: "p2", config: {} },
      cookieHeader,
      "create-stream",
    );
    streamId = stream.response?.stream?.id;
    if (!streamId) throw new Error("no stream");

    // Mint keys with different scope sets
    const scopeSets: Array<{ label: string; scopes: string[] }> = [
      { label: "terracotta-cli", scopes: ["terracotta:cli"] },
      { label: "terracotta-all", scopes: ["terracotta:cli", "terracotta:code-node", "terracotta:mcp"] },
      { label: "all-only", scopes: ["all"] },
      { label: "everything", scopes: ["all", "endpoints:run-enrichment", "endpoints:prospect-search-api", "terracotta:cli", "terracotta:code-node", "terracotta:mcp", "public-endpoints:all"] },
    ];

    const keys: Array<{ label: string; key: string }> = [];
    for (const s of scopeSets) {
      const { key, id } = await mintKey(cookieHeader, userId, s.scopes, s.label);
      if (id) mintedIds.push(id);
      if (key) keys.push({ label: s.label, key });
    }

    const canonical = {
      items: [
        { requestData: { email: "p2-1@example.com" } },
        { requestData: { email: "p2-2@example.com" } },
      ],
    };
    const batchUrl = `${API_BASE}/v3/tc-workflows/streams/${streamId}/webhook/batch`;

    // Try each minted key under every known auth header form
    for (const k of keys) {
      const headerForms: Array<{ label: string; headers: Record<string, string> }> = [
        { label: "bearer", headers: { Authorization: `Bearer ${k.key}` } },
        { label: "basic", headers: { Authorization: `Basic ${Buffer.from(k.key + ":").toString("base64")}` } },
        { label: "Bearer-lower", headers: { Authorization: `bearer ${k.key}` } },
        { label: "X-Clay-API-Key", headers: { "X-Clay-API-Key": k.key } },
        { label: "X-Api-Key", headers: { "X-Api-Key": k.key } },
        { label: "Clay-API-Key", headers: { "Clay-API-Key": k.key } },
        { label: "clay-api-token", headers: { "clay-api-token": k.key } },
        { label: "token", headers: { Token: k.key } },
        { label: "x-auth-token", headers: { "x-auth-token": k.key } },
      ];
      for (const hf of headerForms) {
        await call("POST", batchUrl, canonical, hf.headers, `${k.label}-${hf.label}`);
      }
      // Query-param form
      await call("POST", `${batchUrl}?apiKey=${encodeURIComponent(k.key)}`, canonical, {}, `${k.label}-qs-apiKey`);
      await call("POST", `${batchUrl}?api_key=${encodeURIComponent(k.key)}`, canonical, {}, `${k.label}-qs-api_key`);
    }

    // Also verify: does the SINGLE webhook accept the key? (sanity — it accepts cookies)
    if (keys[0]) {
      await call("POST", `${API_BASE}/v3/tc-workflows/streams/${streamId}/webhook`, { email: "bearer-single@x.com" }, { Authorization: `Bearer ${keys[0].key}` }, "single-bearer");
      // No-auth single (in case it is public)
      await call("POST", `${API_BASE}/v3/tc-workflows/streams/${streamId}/webhook`, { email: "noauth-single@x.com" }, {}, "single-noauth");
    }

    // Also try hitting v1 webhook namespace — there may be a productized route there
    await call("POST", `${API_BASE}/v1/tc-workflows/streams/${streamId}/webhook/batch`, canonical, { Authorization: `Bearer ${keys[0]?.key ?? "none"}` }, "v1-batch-bearer");
    await call("POST", `${API_BASE}/v1/tc-workflows/streams/${streamId}/webhook`, { x: 1 }, { Authorization: `Bearer ${keys[0]?.key ?? "none"}` }, "v1-single-bearer");
    // Try v1/webhooks/:id (legacy webhook source style)
    await call("POST", `${API_BASE}/v1/webhooks/${streamId}`, { x: 1 }, { Authorization: `Bearer ${keys[0]?.key ?? "none"}` }, "v1-webhooks-id");
  } catch (e: any) {
    console.error("error:", e?.message || e);
  } finally {
    if (streamId)
      await call("DELETE", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/streams/${streamId}`, {}, cookieHeader, "del-stream");
    if (edgeId)
      await call("DELETE", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/edges/${edgeId}`, {}, cookieHeader, "del-edge");
    const nodeIds = [nodeId1, nodeId2].filter(Boolean) as string[];
    if (nodeIds.length)
      await call("DELETE", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}/nodes`, { nodeIds }, cookieHeader, "del-nodes");
    await call("DELETE", `${API_BASE}/v3/workspaces/${WORKSPACE_ID}/tc-workflows/${wfId}`, {}, cookieHeader, "del-wf");
    for (const id of mintedIds)
      await call("DELETE", `${API_BASE}/v3/api-keys/${id}`, {}, cookieHeader, `del-key-${id}`);

    const f = path.join(RESULTS_DIR, `inv-028-p2-${startedAt}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log("\nsaved", f);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
