/**
 * CDP API Interception Script
 *
 * Launches a Playwright browser with CDP enabled, authenticates to Clay,
 * and intercepts all requests to api.clay.com. Logs method, path, request
 * body, response status, and abbreviated response body.
 *
 * Usage:
 *   npx playwright test --config=../../e2e/playwright.config.ts intercept-clay-api.ts
 *   -- or run directly with ts-node / tsx --
 *   npx tsx intercept-clay-api.ts
 *
 * Prerequisites:
 *   - CLAY_EMAIL and CLAY_PASSWORD env vars (or use --headed for manual login)
 *   - Playwright browsers installed
 *
 * Output:
 *   - ../results/cdp-intercept-{timestamp}.jsonl
 */

import { chromium, CDPSession, Page, BrowserContext } from "playwright-core";
import * as fs from "fs";
import * as path from "path";

interface InterceptedRequest {
  timestamp: string;
  method: string;
  url: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBodyPreview: string | null;
  triggeredBy: string;
}

const RESULTS_DIR = path.join(__dirname, "..", "results");
const OUTPUT_FILE = path.join(
  RESULTS_DIR,
  `cdp-intercept-${new Date().toISOString().split("T")[0]}.jsonl`
);

const pendingRequests = new Map<string, InterceptedRequest>();
const completedRequests: InterceptedRequest[] = [];

async function authenticate(page: Page): Promise<void> {
  const email = process.env.CLAY_EMAIL;
  const password = process.env.CLAY_PASSWORD;

  await page.goto("https://app.clay.com");
  await page.waitForLoadState("networkidle");

  if (email && password) {
    console.log("[intercept] Attempting automated login...");
    try {
      await page.fill('input[type="email"]', email, { timeout: 5000 });
      await page.fill('input[type="password"]', password, { timeout: 5000 });
      await page.click('button[type="submit"]');
      await page.waitForURL("**/workspaces/**", { timeout: 30000 });
      console.log("[intercept] Login successful");
    } catch {
      console.log(
        "[intercept] Automated login failed. If running headed, log in manually."
      );
      await page.waitForURL("**/workspaces/**", { timeout: 120000 });
    }
  } else {
    console.log(
      "[intercept] No credentials provided. Log in manually in the browser window."
    );
    console.log("[intercept] Waiting up to 2 minutes for login...");
    await page.waitForURL("**/workspaces/**", { timeout: 120000 });
  }

  console.log("[intercept] Authenticated. Starting interception.");
}

async function setupInterception(
  client: CDPSession,
  page: Page
): Promise<void> {
  await client.send("Network.enable");

  client.on("Network.requestWillBeSent", (params: any) => {
    const url = params.request.url;
    if (!url.includes("api.clay.com")) return;

    const urlObj = new URL(url);
    const entry: InterceptedRequest = {
      timestamp: new Date().toISOString(),
      method: params.request.method,
      url,
      path: urlObj.pathname + urlObj.search,
      requestHeaders: params.request.headers || {},
      requestBody: params.request.postData || null,
      responseStatus: null,
      responseHeaders: {},
      responseBodyPreview: null,
      triggeredBy: "unknown",
    };

    pendingRequests.set(params.requestId, entry);
    console.log(`[intercept] → ${entry.method} ${entry.path}`);
  });

  client.on("Network.responseReceived", async (params: any) => {
    const entry = pendingRequests.get(params.requestId);
    if (!entry) return;

    entry.responseStatus = params.response.status;
    entry.responseHeaders = params.response.headers || {};

    try {
      const body = await client.send("Network.getResponseBody", {
        requestId: params.requestId,
      });
      const bodyStr = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf-8")
        : body.body;

      entry.responseBodyPreview =
        bodyStr.length > 2000 ? bodyStr.substring(0, 2000) + "..." : bodyStr;
    } catch {
      entry.responseBodyPreview = "[could not read body]";
    }

    pendingRequests.delete(params.requestId);
    completedRequests.push(entry);
    console.log(
      `[intercept] ← ${entry.responseStatus} ${entry.method} ${entry.path}`
    );
  });
}

function saveResults(): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const lines = completedRequests.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(OUTPUT_FILE, lines + "\n");
  console.log(
    `\n[intercept] Saved ${completedRequests.length} requests to ${OUTPUT_FILE}`
  );
}

async function main(): Promise<void> {
  const headed = process.argv.includes("--headed");

  console.log("[intercept] Launching browser...");
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  await setupInterception(client, page);
  await authenticate(page);

  console.log("\n[intercept] Interception active. Navigate Clay to capture API calls.");
  console.log("[intercept] Press Ctrl+C to stop and save results.\n");

  process.on("SIGINT", () => {
    console.log("\n[intercept] Stopping...");
    saveResults();
    browser.close().then(() => process.exit(0));
  });

  // Keep alive until interrupted
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[intercept] Fatal error:", err);
  saveResults();
  process.exit(1);
});
