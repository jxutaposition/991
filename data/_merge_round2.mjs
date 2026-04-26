// Merge round-2 enrichment into lib/investors.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = path.join(ROOT, "lib", "investors.json");

const sources = [
  path.join(ROOT, "tmp_out", "enriched_A.json"),
  path.join(ROOT, "tmp_out", "enriched_C.json"),
  "C:/Users/annie/AppData/Local/Temp/enriched_D1.json",
  "C:/Users/annie/AppData/Local/Temp/enriched_D2.json",
];

function normalize(s) {
  return (s || "").toLowerCase().replace(/[.,]+$/, "").replace(/\s+/g, " ").trim();
}

const enrichedByName = new Map();
for (const f of sources) {
  if (!fs.existsSync(f)) { console.log("SKIP missing:", f); continue; }
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const arr = Array.isArray(d) ? d : (d.profiles || d.partners || []);
  for (const e of arr) {
    const key = normalize(e.name);
    if (key) enrichedByName.set(key, e);
  }
  console.log(`  ${path.basename(f)}: ${arr.length} rows`);
}
console.log(`Total unique enriched: ${enrichedByName.size}`);

const investors = JSON.parse(fs.readFileSync(TARGET, "utf8"));
let updated = 0, lowConf = 0;
for (const p of investors) {
  const key = normalize(p.name);
  const e = enrichedByName.get(key);
  if (!e) continue;
  // Normalize confidence (some agents used 0-1 numeric, others high/med/low strings)
  let conf = e.confidence;
  if (typeof conf === "number") conf = conf < 0.34 ? "low" : conf < 0.67 ? "medium" : "high";
  if (typeof conf === "string") conf = conf.toLowerCase();
  e.confidence = conf;
  if (conf === "low" && (!e.portfolio || e.portfolio.length === 0)) {
    p.enriched = true;
    p.confidence = "low";
    if (e.thesis_blurb) p.thesis_blurb = e.thesis_blurb;
    if (e.sector_focus && e.sector_focus.length) p.sector_focus = e.sector_focus;
    lowConf++;
    updated++;
    continue;
  }
  // Otherwise merge fields
  for (const col of ["portfolio", "writings", "network_signals", "sector_focus", "stage_focus", "co_investors"]) {
    if (Array.isArray(e[col]) && e[col].length > 0) p[col] = e[col];
  }
  if (e.check_size) p.check_size = e.check_size;
  if (e.check_size_range && !p.check_size) p.check_size = e.check_size_range;
  if (e.thesis_blurb) p.thesis_blurb = e.thesis_blurb;
  if (e.leads_rounds) p.leads_rounds = e.leads_rounds;
  if (e.confidence) p.confidence = e.confidence;
  p.enriched = true;
  updated++;
}

fs.writeFileSync(TARGET, JSON.stringify(investors, null, 2));
const enrichedCount = investors.filter(p => p.enriched).length;
console.log(`Merged ${updated} profiles this round; ${lowConf} flagged low-confidence.`);
console.log(`Total enriched: ${enrichedCount}/${investors.length}`);
