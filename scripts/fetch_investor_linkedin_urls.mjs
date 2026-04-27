/**
 * Fill missing/invalid LinkedIn profile URLs in lib/investors.json.
 *
 * This is adapted from scripts/fetch_linkedin_urls.mjs. It opens a real browser,
 * lets you sign in to LinkedIn, then searches LinkedIn People results by
 * "<name> <firm>" and writes incremental progress to tmp/linkedin_url_backfill.json.
 *
 * By default it does not mutate lib/investors.json. Review the backfill JSON, then
 * rerun with --apply to update matched records.
 *
 * Run from this app directory:
 *   node scripts/fetch_investor_linkedin_urls.mjs
 *   node scripts/fetch_investor_linkedin_urls.mjs --apply
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INVESTORS_PATH = path.join(ROOT, "lib", "investors.json");
const OUT_PATH = path.join(ROOT, "tmp", "linkedin_url_backfill.json");
const APPLY = process.argv.includes("--apply");

function isLinkedInProfileUrl(value) {
  return /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?(\?.*)?$/i.test((value || "").trim());
}

function normalizeLinkedInProfileUrl(value) {
  if (!isLinkedInProfileUrl(value)) return "";
  return value.trim().split("?")[0].replace(/\/$/, "");
}

function loadExistingBackfill() {
  if (!fs.existsSync(OUT_PATH)) return {};
  return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
}

function saveBackfill(backfill) {
  fs.writeFileSync(OUT_PATH, JSON.stringify(backfill, null, 2) + "\n");
}

const investors = JSON.parse(fs.readFileSync(INVESTORS_PATH, "utf8"));
const backfill = loadExistingBackfill();

if (APPLY) {
  let updated = 0;
  for (const investor of investors) {
    const url = normalizeLinkedInProfileUrl(backfill[investor.id]?.linkedin);
    if (!url) continue;
    investor.linkedin = url;
    updated++;
  }
  fs.writeFileSync(INVESTORS_PATH, JSON.stringify(investors, null, 2) + "\n");
  console.log(`Applied ${updated} LinkedIn URL backfills to ${INVESTORS_PATH}`);
  process.exit(0);
}

const targets = investors.filter(
  investor =>
    !isLinkedInProfileUrl(investor.linkedin) &&
    !normalizeLinkedInProfileUrl(backfill[investor.id]?.linkedin)
);

console.log(`Loaded ${investors.length} investors.`);
console.log(`${targets.length} still need valid LinkedIn profile URLs.`);
console.log(`Progress file: ${OUT_PATH}`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
});
const page = await ctx.newPage();

console.log("\nA browser window has opened.");
console.log("Sign in to LinkedIn there. The script will continue once LinkedIn is logged in.");
await page.goto("https://www.linkedin.com/login");

await page.waitForFunction(
  () => location.hostname.includes("linkedin.com") && !location.pathname.includes("/login"),
  { timeout: 10 * 60 * 1000 }
);

for (let i = 0; i < targets.length; i++) {
  const investor = targets[i];
  const query = encodeURIComponent(`${investor.name} ${investor.firm}`);
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${query}`;

  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const url = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/in/"]')];
      const href = links.map(a => a.href).find(Boolean);
      return href ? href.split("?")[0].replace(/\/$/, "") : "";
    });

    backfill[investor.id] = {
      name: investor.name,
      firm: investor.firm,
      oldUrl: investor.linkedin || "",
      linkedin: normalizeLinkedInProfileUrl(url),
      searchedAt: new Date().toISOString(),
    };
    console.log(`[${i + 1}/${targets.length}] ${investor.name}: ${backfill[investor.id].linkedin || "(not found)"}`);
  } catch (error) {
    backfill[investor.id] = {
      name: investor.name,
      firm: investor.firm,
      oldUrl: investor.linkedin || "",
      linkedin: "",
      error: error.message,
      searchedAt: new Date().toISOString(),
    };
    console.log(`[${i + 1}/${targets.length}] ${investor.name}: ERROR ${error.message}`);
  }

  saveBackfill(backfill);
  await page.waitForTimeout(1500);
}

await browser.close();
console.log(`\nWrote ${OUT_PATH}. Review it, then run with --apply.`);
