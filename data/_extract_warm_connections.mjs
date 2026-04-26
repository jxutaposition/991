// Extract 2nd-degree warm-intro candidates: your connections whose occupation matches a firm
// where one of your investor targets works. Outputs a CSV of unique connections.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const investors = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "investors.json"), "utf8"));

// Build map of connection name -> { firms: set of firms they're linked to as warm path, occupation }
const byConn = new Map();
for (const inv of investors) {
  if (inv.connection_degree !== "2nd" || !Array.isArray(inv.connection_via)) continue;
  for (const c of inv.connection_via) {
    const k = c.name.trim();
    if (!byConn.has(k)) byConn.set(k, { name: k, occupation: c.occupation, firms_via: new Set(), investors_via: new Set() });
    const entry = byConn.get(k);
    if (inv.firm) entry.firms_via.add(inv.firm);
    entry.investors_via.add(inv.name);
  }
}

const rows = [...byConn.values()].map(e => {
  const parts = e.name.split(/\s+/);
  const first = parts[0] || "";
  const last = parts.slice(1).join(" ");
  // Pick the first matching firm (most relevant)
  const firmFromOcc = [...e.firms_via][0] || "";
  return {
    full_name: e.name,
    first_name: first,
    last_name: last,
    firm: firmFromOcc,
    occupation: e.occupation,
    linkedin_url: "",  // to be filled by Playwright script
    connects_you_to: [...e.investors_via].slice(0, 5).join("; "),
  };
});

rows.sort((a, b) => a.last_name.localeCompare(b.last_name));

const header = ["full_name", "first_name", "last_name", "firm", "occupation", "linkedin_url", "connects_you_to"];
const csv = [
  header.join(","),
  ...rows.map(r => header.map(h => `"${(r[h] ?? "").toString().replace(/"/g, '""')}"`).join(",")),
].join("\n");

const out = path.join(ROOT, "data", "warm_intro_connections.csv");
fs.writeFileSync(out, csv);
console.log(`Wrote ${rows.length} unique warm-intro connections to ${out}`);
console.log(`First 10:`);
for (const r of rows.slice(0, 10)) {
  console.log(`  ${r.full_name} | ${r.firm} | -> connects you to ${r.connects_you_to.split(';')[0]}`);
}
