/**
 * Backfill missing LinkedIn profile URLs using an Apify LinkedIn people search actor.
 *
 * Cheapest actor found in current search that this token can access:
 *   powerai/linkedin-peoples-search-scraper
 *
 * Input:
 *   - reads lib/investors.json
 *   - targets investors with invalid/non-profile LinkedIn URLs
 * Output:
 *   - writes tmp/apify_linkedin_backfill.json with reviewable matches
 *
 * Usage:
 *   APIFY_TOKEN=... node scripts/backfill_linkedin_urls_apify.mjs
 *   APIFY_TOKEN=... node scripts/backfill_linkedin_urls_apify.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INVESTORS_PATH = path.join(ROOT, "lib", "investors.json");
const SOURCE_PATH = path.join(ROOT, "tmp", "existing_dedup.json");
const OUT_PATH = path.join(ROOT, "tmp", "apify_linkedin_backfill.json");
const APPLY = process.argv.includes("--apply");
const ACTOR_ID = process.env.APIFY_ACTOR_ID || "powerai/linkedin-peoples-search-scraper";
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;

function isValidLinkedInProfileUrl(value) {
  return /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?(\?.*)?$/i.test((value || "").trim());
}

function normalizeLinkedInProfileUrl(value) {
  if (!isValidLinkedInProfileUrl(value)) return "";
  return value.trim().split("?")[0].replace(/\/$/, "");
}

function normName(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function backfillKey(target) {
  return normName(target.name);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

if (APPLY) {
  const investors = loadJson(INVESTORS_PATH);
  const backfill = fs.existsSync(OUT_PATH) ? loadJson(OUT_PATH) : {};
  let updated = 0;
  for (const investor of investors) {
    const url = normalizeLinkedInProfileUrl(backfill[investor.id]?.linkedin || backfill[backfillKey(investor)]?.linkedin);
    if (!url) continue;
    investor.linkedin = url;
    updated++;
  }
  saveJson(INVESTORS_PATH, investors);
  console.log(`Applied ${updated} URLs to ${INVESTORS_PATH}`);
  process.exit(0);
}

if (!APIFY_TOKEN) {
  console.error("Missing APIFY_TOKEN or APIFY_API_TOKEN");
  process.exit(1);
}

const investors = loadJson(INVESTORS_PATH);
const source = loadJson(SOURCE_PATH);
const targets = source.filter(p => !isValidLinkedInProfileUrl(p.linkedin));
const backfill = fs.existsSync(OUT_PATH) ? loadJson(OUT_PATH) : {};

console.log(`Targets: ${targets.length}`);
console.log(`Source: ${SOURCE_PATH}`);
console.log(`Actor: ${ACTOR_ID}`);

const indexedTargets = targets.map(p => ({
  id: p.id,
  name: p.name,
  firm: p.firm || "",
  query: `${p.name} ${p.firm || ""}`.trim(),
}));

const byName = new Map();
for (let i = 0; i < indexedTargets.length; i++) {
  const target = indexedTargets[i];
  const key = backfillKey(target);
  if (backfill[key]?.linkedin) {
    byName.set(key, [backfill[key].linkedin]);
    continue;
  }
  const response = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/runs?token=${encodeURIComponent(APIFY_TOKEN)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: target.name,
      company: target.firm,
      maxResults: 5,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(`[${i + 1}/${indexedTargets.length}] ${target.name}: Apify error ${response.status}`);
    continue;
  }

  const run = await response.json();
  const runId = run.data?.id;
  let status = "";
  while (runId && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(APIFY_TOKEN)}`);
    const body = await poll.json();
    status = body.data?.status || "";
    if (status === "SUCCEEDED") {
      const datasetId = body.data?.defaultDatasetId;
      if (!datasetId) break;
      const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true&format=json`);
      const items = await itemsRes.json();
      const candidates = Array.isArray(items) ? items : [];
      const urls = [];
      for (const item of candidates) {
        const url = normalizeLinkedInProfileUrl(item.url || item.linkedin_url || item.linkedinUrl || item.profile_url);
        if (url) urls.push(url);
      }
      if (urls.length) {
        byName.set(key, [...new Set(urls)]);
        backfill[key] = { name: target.name, firm: target.firm, linkedin: urls[0], source: ACTOR_ID, searchedAt: new Date().toISOString() };
      }
      if (!backfill[key]) {
        backfill[key] = { name: target.name, firm: target.firm, linkedin: "", source: ACTOR_ID, searchedAt: new Date().toISOString() };
      }
      saveJson(OUT_PATH, backfill);
      console.log(`[${i + 1}/${indexedTargets.length}] ${target.name}: ${urls[0] || "(not found)"}`);
      break;
    }
  }
}
