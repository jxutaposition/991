import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "lib", "investors.json");
const TEMP = path.join(ROOT, "tmp", "realistic_final.json");

function isValid(value) {
  return /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?(\?.*)?$/i.test((value || "").trim());
}

function normName(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

const hosted = JSON.parse(fs.readFileSync(OUT, "utf8"));
const temp = JSON.parse(fs.readFileSync(TEMP, "utf8"));

const merged = [];
const seen = new Set();

for (const p of hosted) {
  if (p.israeli) continue;
  if (!isValid(p.linkedin)) continue;
  const key = normName(p.name);
  if (seen.has(key)) continue;
  seen.add(key);
  merged.push(p);
}

for (const p of temp) {
  if (!isValid(p.linkedin)) continue;
  const key = normName(p.name);
  if (seen.has(key)) continue;
  seen.add(key);
  merged.push({
    id: p.id || key.replace(/[^a-z0-9]+/g, "-"),
    name: p.name,
    firm: p.firm || "",
    role: p.role || "",
    linkedin: p.linkedin,
    bucket: p.bucket || "cold_angel",
    priority_tier: p.priority_tier || 2,
    sf_based: p.sf_based !== false,
    notes: p.notes || "",
    score: p.score || 0,
    portfolio: p.portfolio || [],
    writings: p.writings || [],
    network_signals: p.network_signals || [],
    testimonials: p.testimonials || [],
    sector_focus: p.sector_focus || [],
    stage_focus: p.stage_focus || [],
    check_size: p.check_size,
    thesis_blurb: p.thesis_blurb,
    co_investors: p.co_investors || [],
    leads_rounds: p.leads_rounds,
    enriched: p.enriched ?? true,
    confidence: p.confidence,
    israeli: false,
  });
}

fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + "\n");
console.log(`Wrote ${merged.length} valid records to ${OUT}`);
