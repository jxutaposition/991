/**
 * INV-021 — CSV Upload Origin Discovery
 *
 * Phase 1 (HTTP probe):
 *   - Probe non-/v3 paths on api.clay.com (POST + GET)
 *   - Probe alternate hosts (uploads/files/cdn/storage/s3/static.clay.com)
 *   - Distinguish 404 (no route) from 401/403/405 (route exists)
 *   - Fetch app.clay.com HTML, extract <script src=> bundles
 *   - Grep bundles for upload-related symbols and capture context
 *
 * Saves raw results to harness/results/inv-021-csv-upload-*.json.
 */
import * as fs from "fs";
import * as path from "path";

const RESULTS_DIR = path.join(__dirname, "..", "results");
const COOKIE_FILE = path.join(RESULTS_DIR, ".session-cookies.json");

function loadCookies(): string {
  const c = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return c.map((x: any) => `${x.name}=${x.value}`).join("; ");
}

type ProbeResult = {
  label: string;
  method: string;
  url: string;
  status: number;
  bodySnippet: string | null;
  headers: Record<string, string>;
  hit: boolean;
  error?: string;
};

async function probe(method: string, url: string, cookieHeader: string, withCookie = true, body?: any): Promise<ProbeResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (withCookie) headers.Cookie = cookieHeader;
  let finalBody: string | undefined;
  if (body && method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    finalBody = JSON.stringify(body);
  }
  try {
    const r = await fetch(url, { method, headers, body: finalBody, redirect: "manual" });
    const text = await r.text().catch(() => "");
    const respHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => { respHeaders[k] = v; });
    return {
      label: `${method} ${url}`,
      method,
      url,
      status: r.status,
      bodySnippet: text.substring(0, 400),
      headers: respHeaders,
      hit: r.status !== 404 && r.status !== 0,
    };
  } catch (e: any) {
    return {
      label: `${method} ${url}`,
      method,
      url,
      status: 0,
      bodySnippet: null,
      headers: {},
      hit: false,
      error: e.message,
    };
  }
}

async function main() {
  const cookie = loadCookies();
  const out: any = {
    startedAt: new Date().toISOString(),
    baseline: null as any,
    apiClayProbes: [] as ProbeResult[],
    altHostProbes: [] as ProbeResult[],
    htmlScan: null as any,
    bundleHits: [] as any[],
  };

  // 0) Baseline auth check
  const baseline = await probe("GET", "https://api.clay.com/v3/me", cookie);
  out.baseline = baseline;
  console.log("[baseline /v3/me]", baseline.status);
  if (baseline.status === 401 || baseline.status === 403) {
    console.error("SESSION EXPIRED — aborting");
    fs.writeFileSync(path.join(RESULTS_DIR, `inv-021-csv-upload-${Date.now()}.json`), JSON.stringify(out, null, 2));
    process.exit(2);
  }

  // 1) Non-/v3 path probing on api.clay.com
  const apiPaths = [
    "/api/uploads", "/api/upload", "/api/files", "/api/file", "/api/presign",
    "/api/upload-url", "/api/uploads/presign", "/api/files/presign",
    "/api/v1/uploads", "/api/v1/files", "/api/v1/presign",
    "/api/internal/uploads", "/api/internal/files",
    "/uploads", "/upload", "/files", "/presign", "/upload-url",
    "/storage/presign", "/storage/upload", "/storage",
    "/v2/uploads", "/v2/files", "/v2/imports", "/v2/presign",
    "/v3/files", "/v3/uploads", "/v3/presign", // re-confirm
    "/csv-upload", "/csv/upload", "/import-upload",
    "/api/csv", "/api/csv/upload", "/api/imports/upload",
    "/api/imports/presign",
  ];

  for (const p of apiPaths) {
    const url = `https://api.clay.com${p}`;
    const get = await probe("GET", url, cookie);
    out.apiClayProbes.push(get);
    if (get.hit) console.log(`  HIT GET  ${p} → ${get.status} ${get.bodySnippet?.substring(0, 100)}`);
    const post = await probe("POST", url, cookie, true, {});
    out.apiClayProbes.push(post);
    if (post.hit) console.log(`  HIT POST ${p} → ${post.status} ${post.bodySnippet?.substring(0, 100)}`);
  }

  // 2) Alternate hosts
  const hosts = [
    "uploads.clay.com", "files.clay.com", "cdn.clay.com",
    "storage.clay.com", "s3.clay.com", "static.clay.com",
    "upload.clay.com", "media.clay.com", "assets.clay.com",
  ];
  for (const h of hosts) {
    for (const p of ["/", "/uploads", "/presign", "/api/uploads", "/api/presign"]) {
      const url = `https://${h}${p}`;
      const get = await probe("GET", url, cookie);
      out.altHostProbes.push(get);
      if (get.hit) console.log(`  HIT GET  ${url} → ${get.status}`);
      const post = await probe("POST", url, cookie, true, {});
      out.altHostProbes.push(post);
      if (post.hit) console.log(`  HIT POST ${url} → ${post.status}`);
    }
  }

  // 3) Fetch app.clay.com HTML, extract <script src=>
  console.log("\n[fetch app.clay.com]");
  const htmlResp = await fetch("https://app.clay.com/", {
    headers: { Cookie: cookie, Accept: "text/html" },
    redirect: "follow",
  });
  const html = await htmlResp.text();
  const scriptSrcs = Array.from(html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)).map(m => m[1]);
  console.log(`  found ${scriptSrcs.length} <script src=> tags`);
  out.htmlScan = { status: htmlResp.status, scriptCount: scriptSrcs.length, scripts: scriptSrcs };

  // Resolve relative URLs
  const resolved = scriptSrcs.map(s => {
    if (s.startsWith("http")) return s;
    if (s.startsWith("//")) return "https:" + s;
    if (s.startsWith("/")) return "https://app.clay.com" + s;
    return "https://app.clay.com/" + s;
  });

  // Fetch bundles and grep for upload-related symbols
  const patterns: Array<{ name: string; rx: RegExp }> = [
    { name: "presign", rx: /presign/gi },
    { name: "signedUrl", rx: /signedUrl/gi },
    { name: "uploadUrl", rx: /uploadUrl/gi },
    { name: "getUploadUrl", rx: /getUploadUrl/gi },
    { name: "createUpload", rx: /createUpload/gi },
    { name: "putObject", rx: /putObject/gi },
    { name: "s3.amazonaws", rx: /s3[.-][a-z0-9-]*\.amazonaws/gi },
    { name: "x-amz", rx: /x-amz-/gi },
    { name: "S3_CSV", rx: /S3_CSV/g },
    { name: "multipart", rx: /multipart\/form-data/g },
    { name: "uploads.clay", rx: /uploads\.clay/gi },
    { name: "/api/upload", rx: /\/api\/upload[a-z-]*/gi },
    { name: "/api/files", rx: /\/api\/files[a-z-]*/gi },
    { name: "/api/presign", rx: /\/api\/presign[a-z-]*/gi },
    { name: "csvUpload", rx: /csvUpload[A-Za-z]*/g },
    { name: "importUpload", rx: /importUpload[A-Za-z]*/g },
  ];

  // Limit to a reasonable number of bundles to avoid burning forever
  const maxBundles = Math.min(resolved.length, 25);
  for (let i = 0; i < maxBundles; i++) {
    const url = resolved[i];
    try {
      const r = await fetch(url, { headers: { Cookie: cookie } });
      if (r.status !== 200) {
        console.log(`  bundle ${i} ${url} → ${r.status}, skip`);
        continue;
      }
      const body = await r.text();
      const hits: any[] = [];
      for (const p of patterns) {
        const matches = Array.from(body.matchAll(p.rx));
        if (matches.length === 0) continue;
        // Capture context around the first 3 matches
        const snippets = matches.slice(0, 3).map(m => {
          const idx = m.index ?? 0;
          const start = Math.max(0, idx - 120);
          const end = Math.min(body.length, idx + 200);
          return body.substring(start, end);
        });
        hits.push({ pattern: p.name, count: matches.length, snippets });
      }
      if (hits.length > 0) {
        console.log(`  BUNDLE ${url} → ${hits.length} pattern hits`);
        out.bundleHits.push({ url, size: body.length, hits });
      }
    } catch (e: any) {
      console.log(`  bundle err ${url}: ${e.message}`);
    }
  }

  out.endedAt = new Date().toISOString();
  const f = path.join(RESULTS_DIR, `inv-021-csv-upload-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`\nsaved ${f}`);

  // Brief summary
  const apiHits = out.apiClayProbes.filter((p: ProbeResult) => p.hit);
  const altHits = out.altHostProbes.filter((p: ProbeResult) => p.hit);
  console.log(`\n=== SUMMARY ===`);
  console.log(`api.clay.com hits (non-404): ${apiHits.length}`);
  for (const h of apiHits) console.log(`  ${h.method} ${h.url} → ${h.status}`);
  console.log(`alt host hits: ${altHits.length}`);
  for (const h of altHits) console.log(`  ${h.method} ${h.url} → ${h.status}`);
  console.log(`bundles with upload-related hits: ${out.bundleHits.length}`);
  for (const b of out.bundleHits) {
    console.log(`  ${b.url}`);
    for (const h of b.hits) console.log(`    ${h.pattern} ×${h.count}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
