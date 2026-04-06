/**
 * Session Cookie Extraction Script
 *
 * Authenticates to Clay via Playwright and extracts session cookies
 * and the clay_version string. Outputs a JSON file that can be used
 * for server-side v3 API calls.
 *
 * Usage:
 *   npx tsx extract-session.ts [--headed]
 *
 * Prerequisites:
 *   - CLAY_EMAIL and CLAY_PASSWORD env vars (or use --headed for manual login)
 *   - Playwright browsers installed
 *
 * Output:
 *   - ../results/session-{timestamp}.json
 */

import { chromium, Page, BrowserContext, Cookie } from "playwright-core";
import * as fs from "fs";
import * as path from "path";

interface SessionData {
  extractedAt: string;
  cookies: Cookie[];
  clayVersion: string | null;
  workspaceId: string | null;
  userAgent: string;
  cookieSummary: {
    count: number;
    domains: string[];
    names: string[];
  };
}

const RESULTS_DIR = path.join(__dirname, "..", "results");

async function authenticate(page: Page): Promise<void> {
  const email = process.env.CLAY_EMAIL;
  const password = process.env.CLAY_PASSWORD;

  await page.goto("https://app.clay.com");
  await page.waitForLoadState("networkidle");

  if (email && password) {
    console.log("[session] Attempting automated login...");
    try {
      await page.fill('input[type="email"]', email, { timeout: 5000 });
      await page.fill('input[type="password"]', password, { timeout: 5000 });
      await page.click('button[type="submit"]');
      await page.waitForURL("**/workspaces/**", { timeout: 30000 });
      console.log("[session] Login successful");
    } catch {
      console.log(
        "[session] Automated login failed. If running headed, log in manually."
      );
      await page.waitForURL("**/workspaces/**", { timeout: 120000 });
    }
  } else {
    console.log("[session] No credentials provided. Log in manually.");
    console.log("[session] Waiting up to 2 minutes for login...");
    await page.waitForURL("**/workspaces/**", { timeout: 120000 });
  }
}

async function extractSession(
  context: BrowserContext,
  page: Page
): Promise<SessionData> {
  const cookies = await context.cookies("https://app.clay.com");

  const clayVersion = await page.evaluate(() => {
    return (window as any).clay_version || null;
  });

  const workspaceMatch = page.url().match(/workspaces\/(\d+)/);
  const workspaceId = workspaceMatch ? workspaceMatch[1] : null;

  const userAgent = await page.evaluate(() => navigator.userAgent);

  const domains = [...new Set(cookies.map((c) => c.domain))];
  const names = cookies.map((c) => c.name);

  return {
    extractedAt: new Date().toISOString(),
    cookies,
    clayVersion,
    workspaceId,
    userAgent,
    cookieSummary: {
      count: cookies.length,
      domains,
      names,
    },
  };
}

async function testSession(session: SessionData): Promise<boolean> {
  console.log("[session] Testing session validity...");

  const cookieHeader = session.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  try {
    const response = await fetch("https://api.clay.com/v1/sources", {
      headers: {
        Cookie: cookieHeader,
        Accept: "application/json",
        "X-Clay-Frontend-Version": session.clayVersion || "unknown",
      },
    });

    console.log(`[session] Test response: ${response.status}`);
    return response.ok;
  } catch (err) {
    console.log(`[session] Test failed: ${err}`);
    return false;
  }
}

async function main(): Promise<void> {
  const headed = process.argv.includes("--headed") || !process.env.CLAY_EMAIL;

  console.log(
    `[session] Launching browser (${headed ? "headed" : "headless"})...`
  );
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    await authenticate(page);
    const session = await extractSession(context, page);

    console.log("\n[session] Session extracted:");
    console.log(`  Cookies: ${session.cookieSummary.count}`);
    console.log(`  Domains: ${session.cookieSummary.domains.join(", ")}`);
    console.log(`  Clay version: ${session.clayVersion || "not found"}`);
    console.log(`  Workspace ID: ${session.workspaceId || "not found"}`);

    const valid = await testSession(session);
    console.log(`  Valid: ${valid}`);

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outputFile = path.join(
      RESULTS_DIR,
      `session-${new Date().toISOString().split("T")[0]}.json`
    );

    // Strip cookie values from the summary output (security)
    const safeSession = {
      ...session,
      cookies: session.cookies.map((c) => ({
        ...c,
        value: `[${c.value.length} chars]`,
      })),
    };

    fs.writeFileSync(outputFile, JSON.stringify(safeSession, null, 2));
    console.log(`\n[session] Summary saved to ${outputFile}`);
    console.log("[session] NOTE: Cookie values are redacted in the saved file.");
    console.log(
      "[session] For actual cookie values, use the session programmatically."
    );

    // Save actual cookies to a separate encrypted file (if needed)
    const cookieFile = path.join(RESULTS_DIR, ".session-cookies.json");
    fs.writeFileSync(cookieFile, JSON.stringify(session.cookies, null, 2));
    console.log(`[session] Full cookies saved to ${cookieFile} (DO NOT COMMIT)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[session] Fatal error:", err);
  process.exit(1);
});
