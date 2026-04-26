// Merge enriched_*.json into web/lib/investors.json
// Run: node data/_merge_enriched.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, "data");
const OUT = path.join(ROOT, "web", "lib", "investors.json");

const baseline = JSON.parse(fs.readFileSync(OUT, "utf8"));

function normalizeName(s) {
  return (s || "").trim().toLowerCase().replace(/[.,]+$/, "").replace(/\s+/g, " ");
}

function loadEnriched(name) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.partners)) return raw.partners;
    if (Array.isArray(raw.profiles)) return raw.profiles;
    if (Array.isArray(raw.investors)) return raw.investors;
  }
  return [];
}

const enrichedFiles = [
  "enriched_warm.json",
  "enriched_angels_a.json",
  "enriched_angels_b.json",
  "enriched_partners_a.json",
  "enriched_partners_b.json",
];

const enrichedByName = new Map();
for (const f of enrichedFiles) {
  const list = loadEnriched(f);
  for (const e of list) {
    const key = normalizeName(e.name);
    if (!key) continue;
    enrichedByName.set(key, e);
  }
  console.log(`  ${f}: ${list.length} profiles`);
}
console.log(`Total unique enriched: ${enrichedByName.size}`);

let matched = 0, unmatched = [];
const merged = baseline.map(p => {
  const key = normalizeName(p.name);
  const e = enrichedByName.get(key);
  if (!e) return p;
  matched++;
  return {
    ...p,
    portfolio: Array.isArray(e.portfolio) ? e.portfolio : p.portfolio,
    writings: Array.isArray(e.writings) ? e.writings : p.writings,
    network_signals: Array.isArray(e.network_signals) ? e.network_signals : p.network_signals,
    testimonials: Array.isArray(e.testimonials) ? e.testimonials : p.testimonials,
    sector_focus: Array.isArray(e.sector_focus) ? e.sector_focus : p.sector_focus,
    stage_focus: Array.isArray(e.stage_focus) ? e.stage_focus : p.stage_focus,
    check_size: e.check_size || p.check_size,
    thesis_blurb: e.thesis_blurb || p.thesis_blurb,
    confidence: e.confidence || p.confidence,
    enriched: true,
  };
});

// Find which enriched profiles didn't match a baseline name
const baselineNames = new Set(baseline.map(p => normalizeName(p.name)));
for (const k of enrichedByName.keys()) {
  if (!baselineNames.has(k)) unmatched.push(k);
}

fs.writeFileSync(OUT, JSON.stringify(merged, null, 2));
console.log(`\nMatched ${matched}/${baseline.length} baseline profiles to enrichment.`);
if (unmatched.length) console.log(`Unmatched enriched names (${unmatched.length}):`, unmatched);
console.log(`Wrote ${OUT}`);
