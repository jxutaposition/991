// Merge AUM from vc_top_targets.csv into lib/investors.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CSV = path.join(ROOT, "data", "vc_top_targets.csv");
const JSON_OUT = path.join(ROOT, "lib", "investors.json");

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "") // strip parenthetical aliases
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(capital|ventures|partners|venture|vc|management|group)\b/g, "")
    .trim();
}

// Manual aliases for known mismatches
const ALIASES = {
  "andreessen horowitz": "a16z",
  "a16z": "andreessen horowitz",
  "kleiner perkins": "kleiner",
  "founders fund": "founders fund",
  "lightspeed venture partners": "lightspeed",
  "lightspeed": "lightspeed venture partners",
  "bessemer venture partners": "bessemer",
  "bessemer": "bessemer venture partners",
  "first round capital": "first round",
  "first round": "first round capital",
  "general catalyst": "general catalyst",
  "khosla ventures": "khosla",
  "khosla": "khosla ventures",
  "true ventures": "true",
  "menlo ventures": "menlo",
  "spark capital": "spark",
  "index ventures": "index",
  "felicis ventures": "felicis",
  "felicis": "felicis ventures",
  "redpoint ventures": "redpoint",
  "redpoint": "redpoint ventures",
  "notable capital ggv us": "notable",
  "ggv us": "notable",
  "amplify partners": "amplify",
  "founders fund growth": "founders fund",
  "accel leaders": "accel",
  "altimeter growth partners": "altimeter",
  "andreessen horowitz a16z": "a16z",
  "y combinator": "yc",
};

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map(line => {
    // simple CSV (no embedded commas in our data)
    const parts = line.split(",");
    const obj = {};
    header.forEach((h, i) => obj[h.trim()] = (parts[i] || "").trim());
    return obj;
  });
}

const csvText = fs.readFileSync(CSV, "utf8");
const vcRows = parseCSV(csvText);

// Build firm -> AUM map (normalized)
const aumMap = new Map();
for (const row of vcRows) {
  const aum = parseInt(row.aum_usd, 10);
  if (!aum || !row.firm) continue;
  const key = normalize(row.firm);
  if (!aumMap.has(key) || aumMap.get(key).aum < aum) {
    aumMap.set(key, { aum, firm: row.firm, stages: row.stages, website: row.website });
  }
  // Also register alias if any
  const al = ALIASES[key];
  if (al && !aumMap.has(al)) {
    aumMap.set(al, { aum, firm: row.firm, stages: row.stages, website: row.website });
  }
}

console.log(`Loaded ${aumMap.size} firm AUM entries`);

const investors = JSON.parse(fs.readFileSync(JSON_OUT, "utf8"));
let matched = 0, unmatched = new Set();
for (const p of investors) {
  if (!p.firm) continue;
  // Try direct firm match
  const key = normalize(p.firm);
  let hit = aumMap.get(key) || aumMap.get(ALIASES[key] || "");
  if (!hit) {
    // Try matching by firm word in role_or_company text
    for (const [k, v] of aumMap) {
      if (key.includes(k) || k.includes(key)) {
        hit = v;
        break;
      }
    }
  }
  if (hit) {
    p.aum_usd = hit.aum;
    p.firm_stages = hit.stages || p.firm_stages;
    p.firm_website = hit.website || p.firm_website;
    matched++;
  } else {
    unmatched.add(p.firm);
  }
}

fs.writeFileSync(JSON_OUT, JSON.stringify(investors, null, 2));
console.log(`Matched ${matched}/${investors.length} investors with firm AUM.`);
console.log(`Wrote ${JSON_OUT}`);
if (unmatched.size > 0) {
  console.log(`Sample unmatched firms (${unmatched.size}):`, [...unmatched].slice(0, 10));
}
