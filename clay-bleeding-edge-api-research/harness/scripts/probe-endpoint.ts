/**
 * Endpoint Probe Script
 *
 * Tests a specific v3 API endpoint with various payloads to document
 * its behavior, required parameters, error responses, and edge cases.
 *
 * Usage:
 *   npx tsx probe-endpoint.ts --method GET --path "/v3/tables/{tableId}" --table-id t_xxx
 *   npx tsx probe-endpoint.ts --method POST --path "/v3/tables/{tableId}/fields" --table-id t_xxx --body '{"name":"test","type":"text"}'
 *
 * Prerequisites:
 *   - Session cookies file at ../results/.session-cookies.json
 *     (generate with extract-session.ts)
 *   - A scratch Clay table for write testing
 *
 * Output:
 *   - ../results/probe-{endpoint}-{timestamp}.json
 */

import * as fs from "fs";
import * as path from "path";

interface ProbeResult {
  timestamp: string;
  method: string;
  url: string;
  requestBody: any;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: any;
  latencyMs: number;
  notes: string;
}

const API_BASE = "https://api.clay.com";
const RESULTS_DIR = path.join(__dirname, "..", "results");
const COOKIE_FILE = path.join(RESULTS_DIR, ".session-cookies.json");

function loadCookies(): string {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(
      `No session cookies found at ${COOKIE_FILE}. Run extract-session.ts first.`
    );
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

function parseArgs(): {
  method: string;
  apiPath: string;
  body: any;
  tableId: string | null;
  viewId: string | null;
} {
  const args = process.argv.slice(2);
  let method = "GET";
  let apiPath = "";
  let body: any = null;
  let tableId: string | null = null;
  let viewId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--method":
        method = args[++i];
        break;
      case "--path":
        apiPath = args[++i];
        break;
      case "--body":
        body = JSON.parse(args[++i]);
        break;
      case "--table-id":
        tableId = args[++i];
        break;
      case "--view-id":
        viewId = args[++i];
        break;
    }
  }

  if (!apiPath) {
    console.error("Usage: npx tsx probe-endpoint.ts --method GET --path /v3/tables/{tableId} --table-id t_xxx");
    process.exit(1);
  }

  // Substitute path parameters
  if (tableId) {
    apiPath = apiPath.replace("{tableId}", tableId);
  }
  if (viewId) {
    apiPath = apiPath.replace("{viewId}", viewId);
  }

  return { method, apiPath, body, tableId, viewId };
}

async function probe(
  method: string,
  apiPath: string,
  body: any,
  cookieHeader: string,
  notes: string
): Promise<ProbeResult> {
  const url = `${API_BASE}${apiPath}`;
  const start = Date.now();

  const options: RequestInit = {
    method,
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Clay-Frontend-Version": "unknown",
    },
  };

  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const latencyMs = Date.now() - start;

    let responseBody: any;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = await response.text();
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      timestamp: new Date().toISOString(),
      method,
      url,
      requestBody: body,
      responseStatus: response.status,
      responseHeaders,
      responseBody,
      latencyMs,
      notes,
    };
  } catch (err: any) {
    return {
      timestamp: new Date().toISOString(),
      method,
      url,
      requestBody: body,
      responseStatus: 0,
      responseHeaders: {},
      responseBody: { error: err.message },
      latencyMs: Date.now() - start,
      notes: `Network error: ${notes}`,
    };
  }
}

async function main(): Promise<void> {
  const { method, apiPath, body, tableId } = parseArgs();
  const cookieHeader = loadCookies();

  console.log(`[probe] Target: ${method} ${API_BASE}${apiPath}`);
  if (body) console.log(`[probe] Body: ${JSON.stringify(body)}`);

  const results: ProbeResult[] = [];

  // Probe 1: Main request
  console.log("\n[probe] === Main request ===");
  const mainResult = await probe(method, apiPath, body, cookieHeader, "main request");
  results.push(mainResult);
  console.log(`[probe] Status: ${mainResult.responseStatus} (${mainResult.latencyMs}ms)`);
  console.log(`[probe] Response: ${JSON.stringify(mainResult.responseBody).substring(0, 500)}`);

  // Probe 2: No auth (should get 401)
  console.log("\n[probe] === No auth ===");
  const noAuthResult = await probe(method, apiPath, body, "", "no authentication");
  results.push(noAuthResult);
  console.log(`[probe] Status: ${noAuthResult.responseStatus}`);

  // For POST/PATCH/PUT: probe with empty body
  if (method !== "GET" && method !== "DELETE") {
    console.log("\n[probe] === Empty body ===");
    await new Promise((r) => setTimeout(r, 200));
    const emptyResult = await probe(method, apiPath, {}, cookieHeader, "empty body");
    results.push(emptyResult);
    console.log(`[probe] Status: ${emptyResult.responseStatus}`);
    console.log(`[probe] Error: ${JSON.stringify(emptyResult.responseBody).substring(0, 300)}`);
  }

  // Save results
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const safePath = apiPath.replace(/\//g, "_").replace(/[{}]/g, "");
  const outputFile = path.join(
    RESULTS_DIR,
    `probe-${method}${safePath}-${Date.now()}.json`
  );
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\n[probe] Results saved to ${outputFile}`);
}

main().catch((err) => {
  console.error("[probe] Fatal error:", err);
  process.exit(1);
});
