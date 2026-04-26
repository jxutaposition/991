/**
 * Fetch LinkedIn URLs for warm-intro candidates by searching LinkedIn People search.
 * You log in interactively in the launched browser; the script then walks the CSV
 * and fills in linkedin_url for each row.
 *
 * Run from repo root:
 *   node scripts/fetch_linkedin_urls.mjs
 *
 * Pre-req: playwright is already in package.json. If chromium isn't installed yet:
 *   npx playwright install chromium
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CSV_IN = path.join(ROOT, "data", "warm_intro_connections.csv");
const CSV_OUT = path.join(ROOT, "data", "warm_intro_connections_with_urls.csv");

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map(s => s.replace(/^"|"$/g, ""));
  return { header, rows: lines.slice(1).map(line => {
    const cols = line.match(/"([^"]|"")*"|[^,]+/g) || [];
    const out = {};
    header.forEach((h, i) => { out[h] = (cols[i] || "").replace(/^"|"$/g, "").replace(/""/g, '"'); });
    return out;
  })};
}

function toCSV(header, rows) {
  return [
    header.join(","),
    ...rows.map(r => header.map(h => `"${(r[h] ?? "").toString().replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
}

const { header, rows } = parseCSV(fs.readFileSync(CSV_IN, "utf8"));
console.log(`Loaded ${rows.length} rows from ${CSV_IN}`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
});
const page = await ctx.newPage();

console.log("\n→ A browser window has opened.");
console.log("→ Sign in to LinkedIn, then press Enter in this terminal to continue...");
await page.goto("https://www.linkedin.com/login");

// Wait for user to press Enter
await new Promise(resolve => {
  process.stdin.once("data", resolve);
});

console.log("\n→ Searching LinkedIn for each connection...");
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r.linkedin_url) {
    console.log(`  [${i + 1}/${rows.length}] ${r.full_name}: already has URL, skipping`);
    continue;
  }
  const query = encodeURIComponent(`${r.full_name} ${r.firm}`);
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${query}`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    // Find the first profile link in the results
    const url = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/in/"]');
      return a ? a.href.split("?")[0] : "";
    });
    r.linkedin_url = url || "";
    console.log(`  [${i + 1}/${rows.length}] ${r.full_name}: ${url || "(not found)"}`);
  } catch (e) {
    console.log(`  [${i + 1}/${rows.length}] ${r.full_name}: ERROR ${e.message}`);
    r.linkedin_url = "";
  }
  // Save after each row
  fs.writeFileSync(CSV_OUT, toCSV(header, rows));
  // small delay to avoid rate-limit
  await page.waitForTimeout(1500);
}

console.log(`\n✓ Wrote ${rows.length} rows to ${CSV_OUT}`);
await browser.close();
process.exit(0);
