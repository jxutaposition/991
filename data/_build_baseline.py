"""Build deduped SF-only baseline JSON from cold_angels, warm_investors, sf_partners."""
import csv, json, re, hashlib
from pathlib import Path

DATA = Path(__file__).parent
OUT = DATA / "investors_baseline.json"

def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or hashlib.md5(name.encode()).hexdigest()[:8]

def signal_score(angel_signal):
    s = (angel_signal or "").lower()
    m = re.search(r"(\d{2,4})\s*(angel|crunchbase|deals|investments)", s)
    if m:
        return min(int(m.group(1)), 250)
    if "syndicate" in s or "prolific" in s or "most active" in s:
        return 60
    if "unverified" in s or "high-profile target" in s:
        return 20
    if s.strip():
        return 50
    return 30

profiles = []
seen = {}

# Warm investors — priority 1
with open(DATA / "warm_investors.csv", newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        name = (row.get("name") or "").strip()
        if not name: continue
        key = name.lower()
        p = {
            "id": slug(name),
            "name": name,
            "firm": row.get("firm") or "",
            "role": row.get("role_or_headline") or "",
            "linkedin": row.get("linkedin_url") or "",
            "bucket": "warm",
            "priority_tier": 1,
            "sub_bucket": row.get("bucket") or "",
            "warm_priority": int(row.get("priority") or 3),
            "sf_based": True,
            "notes": row.get("notes") or "",
            "score": 100 - int(row.get("priority") or 3) * 5,
            "portfolio": [],
            "writings": [],
            "network_signals": [],
            "testimonials": [],
            "sector_focus": [],
            "stage_focus": [],
            "enriched": False,
        }
        seen[key] = p
        profiles.append(p)

# Cold angels — priority 2 (SF only)
with open(DATA / "cold_angels.csv", newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        if (row.get("sf_based") or "").strip().upper() != "Y":
            continue
        name = (row.get("name") or "").strip()
        if not name: continue
        key = name.lower()
        if key in seen: continue
        signal = row.get("angel_activity_signal") or ""
        p = {
            "id": slug(name),
            "name": name,
            "firm": row.get("role_or_company") or "",
            "role": "Angel",
            "linkedin": row.get("linkedin_or_source_url") or "",
            "bucket": "cold_angel",
            "priority_tier": 2,
            "sub_bucket": "",
            "sf_based": True,
            "notes": row.get("notes") or "",
            "angel_signal": signal,
            "score": signal_score(signal),
            "portfolio": [],
            "writings": [],
            "network_signals": [],
            "testimonials": [],
            "sector_focus": [],
            "stage_focus": [],
            "enriched": False,
        }
        seen[key] = p
        profiles.append(p)

# SF partners — priority 3 (SF only, including ?)
with open(DATA / "sf_partners.csv", newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        sf = (row.get("sf_based") or "").strip().upper()
        if sf == "N": continue
        name = (row.get("name") or "").strip()
        if not name: continue
        key = name.lower()
        if key in seen:
            seen[key]["firm_partner_role"] = f"{row.get('title','')} at {row.get('firm','')}"
            continue
        firm = row.get("firm") or ""
        title = row.get("title") or "Partner"
        # Higher score for top-tier firms
        top_tier = {"sequoia capital", "andreessen horowitz", "founders fund", "benchmark", "greylock",
                    "accel", "kleiner perkins", "general catalyst", "khosla ventures", "lightspeed venture partners",
                    "index ventures", "first round capital", "true ventures", "felicis"}
        firm_score = 60 if firm.lower() in top_tier else 40
        if "managing partner" in title.lower() or "founding partner" in title.lower():
            firm_score += 15
        elif "general partner" in title.lower():
            firm_score += 10
        p = {
            "id": slug(name),
            "name": name,
            "firm": firm,
            "role": title,
            "linkedin": row.get("linkedin_or_source_url") or "",
            "bucket": "cold_partner",
            "priority_tier": 3,
            "sub_bucket": "",
            "sf_based": sf == "Y",
            "sf_uncertain": sf == "?",
            "notes": row.get("notes") or "",
            "score": firm_score,
            "portfolio": [],
            "writings": [],
            "network_signals": [],
            "testimonials": [],
            "sector_focus": [],
            "stage_focus": [],
            "enriched": False,
        }
        seen[key] = p
        profiles.append(p)

# Sort: priority_tier ASC, score DESC
profiles.sort(key=lambda p: (p["priority_tier"], -p["score"], p["name"].lower()))

# Stats
warm = sum(1 for p in profiles if p["bucket"] == "warm")
cold_a = sum(1 for p in profiles if p["bucket"] == "cold_angel")
cold_p = sum(1 for p in profiles if p["bucket"] == "cold_partner")

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(profiles, f, indent=2, ensure_ascii=False)

print(f"Total profiles: {len(profiles)} | warm: {warm} | cold angels: {cold_a} | cold partners: {cold_p}")
print(f"Wrote {OUT}")
print(f"Top 5 by score:")
for p in profiles[:5]:
    print(f"  - {p['name']} ({p['bucket']}, score={p['score']})")
