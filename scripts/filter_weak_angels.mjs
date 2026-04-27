import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IN = path.join(ROOT, "lib", "investors.json");
const OUT = path.join(ROOT, "lib", "investors.json");

function validLinkedIn(value) {
  return /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?(\?.*)?$/i.test((value || "").trim());
}

function norm(s) {
  return (s || "").toLowerCase();
}

function isRealAngel(investor) {
  const notes = norm(investor.notes);
  const evidence = [
    investor.leads_rounds && investor.leads_rounds !== "unknown",
    /angel|invest|checks|portfolio|fund|syndicate|scout|advisor/i.test(notes),
  ].some(Boolean);
  if (!evidence) return false;
  if (/(unclear if invests|unverified angel|limited public angel signal|flagged|exclude|deprioritize|not a fit|long shot)/i.test(notes)) return false;
  return true;
}

const investors = JSON.parse(fs.readFileSync(IN, "utf8"));
const kept = investors.filter(i => {
  if (!validLinkedIn(i.linkedin)) return false;
  if (i.israeli) return false;
  if (i.bucket === "cold_angel" || i.bucket === "warm") return isRealAngel(i);
  return true;
});

fs.writeFileSync(OUT, JSON.stringify(kept, null, 2) + "\n");
console.log(`Kept ${kept.length} records in ${OUT}`);
