// Parse LinkedIn connections paste into CSV + merge as 1st/2nd-degree signal into investors.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = "C:\\Users\\annie\\Documents\\apps\\2026experiment1\\scripts\\linkedin connections.txt";
const CSV_OUT = path.join(ROOT, "data", "linkedin_connections.csv");
const JSON_TARGET = path.join(ROOT, "lib", "investors.json");

const raw = fs.readFileSync(SRC, "utf8");
const lines = raw.split(/\r?\n/);

// Parse: blocks of 6-7 lines starting with the display name, followed by "Member's name" / name / "Member's occupation" / occupation / blank / "Message" / blank.
const conns = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Look for "Member's name" marker to find the next block
  if (line.trim() === "Member’s name" || line.trim() === "Member's name") {
    const name = (lines[i + 1] || "").trim();
    // Next labeled "Member's occupation" -> occupation on i+3
    const occLabel = (lines[i + 2] || "").trim();
    if (occLabel === "Member’s occupation" || occLabel === "Member's occupation") {
      const occupation = (lines[i + 3] || "").trim();
      if (name) conns.push({ name, occupation });
    }
  }
}

// Dedupe by lowercase name
const byName = new Map();
for (const c of conns) {
  const key = c.name.toLowerCase().trim();
  if (!byName.has(key)) byName.set(key, c);
}
const conn = [...byName.values()];
console.log(`Parsed ${conn.length} unique connections`);

// Write CSV
const csvRows = [["name", "occupation"]];
for (const c of conn) csvRows.push([c.name, c.occupation]);
const csv = csvRows.map(r => r.map(v => `"${(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
fs.writeFileSync(CSV_OUT, csv);
console.log(`Wrote ${CSV_OUT} (${conn.length} rows)`);

// Build lookup sets
function normalizeName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

const connByNormName = new Map();
for (const c of conn) connByNormName.set(normalizeName(c.name), c);

// Now merge into investors.json
const investors = JSON.parse(fs.readFileSync(JSON_TARGET, "utf8"));
let firstDegreeMatches = 0, secondDegreeMatches = 0;

// Pre-build firm-to-connection map for 2nd-degree lookup
// Match firm names that appear in connection occupations
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

for (const p of investors) {
  // Reset previous degree
  delete p.connection_degree;
  delete p.connection_via;

  // 1st degree: direct name match
  const normName = normalizeName(p.name);
  if (connByNormName.has(normName)) {
    p.connection_degree = "1st";
    firstDegreeMatches++;
    continue;
  }

  // 2nd degree: firm name appears in some connection's occupation text
  const firm = (p.firm || "").trim();
  if (firm.length < 4) continue;
  // Skip generic single-word firms that would over-match
  const generic = ["capital", "ventures", "partners", "investments", "fund", "advisors"];
  if (generic.includes(firm.toLowerCase())) continue;

  const firmRegex = new RegExp(`\\b${escapeRegex(firm)}\\b`, "i");
  const matches = [];
  for (const c of conn) {
    if (firmRegex.test(c.occupation)) {
      matches.push({ name: c.name, occupation: c.occupation });
      if (matches.length >= 5) break;
    }
  }
  if (matches.length > 0) {
    p.connection_degree = "2nd";
    p.connection_via = matches;
    secondDegreeMatches++;
  }
}

fs.writeFileSync(JSON_TARGET, JSON.stringify(investors, null, 2));
console.log(`1st-degree matches: ${firstDegreeMatches} / ${investors.length}`);
console.log(`2nd-degree matches (via shared firm): ${secondDegreeMatches} / ${investors.length}`);
console.log(`Wrote ${JSON_TARGET}`);
