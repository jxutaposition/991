import csv, re, sys
from pathlib import Path

DATA = Path(__file__).parent
parts = ["cold_angels_part1.csv", "cold_angels_part2.csv", "cold_angels_part3.csv"]

rows = []
seen = {}
for p in parts:
    with open(DATA / p, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            key = re.sub(r"\s+", " ", (row.get("name") or "").strip().lower())
            if not key:
                continue
            if key in seen:
                # merge: prefer row with stronger signal / non-empty fields
                existing = seen[key]
                for col in ("role_or_company", "angel_activity_signal", "linkedin_or_source_url", "notes"):
                    if not (existing.get(col) or "").strip() and (row.get(col) or "").strip():
                        existing[col] = row[col]
                # upgrade sf_based: Y > ? > N
                rank = {"Y": 2, "?": 1, "N": 0}
                if rank.get(row.get("sf_based", "?"), 1) > rank.get(existing.get("sf_based", "?"), 1):
                    existing["sf_based"] = row["sf_based"]
                continue
            seen[key] = row
            rows.append(row)

def sf_rank(r):
    return {"Y": 0, "?": 1, "N": 2}.get((r.get("sf_based") or "?").strip(), 1)

def signal_rank(r):
    s = (r.get("angel_activity_signal") or "").lower()
    # strongest: explicit deal count or syndicate lead
    if re.search(r"\d{2,}", s):  # 2+ digit number suggests deal count
        return 0
    if any(k in s for k in ["syndicate", "prolific", "most active", "top "]):
        return 1
    if any(k in s for k in ["unverified", "unknown", "high-profile target"]):
        return 3
    return 2

rows.sort(key=lambda r: (sf_rank(r), signal_rank(r), (r.get("name") or "").lower()))

out = DATA / "cold_angels.csv"
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["name", "role_or_company", "sf_based", "angel_activity_signal", "linkedin_or_source_url", "notes"])
    w.writeheader()
    for r in rows:
        w.writerow({k: (r.get(k) or "") for k in w.fieldnames})

# Stats
sf_y = sum(1 for r in rows if (r.get("sf_based") or "").strip() == "Y")
sf_q = sum(1 for r in rows if (r.get("sf_based") or "").strip() == "?")
sf_n = sum(1 for r in rows if (r.get("sf_based") or "").strip() == "N")
print(f"Total unique: {len(rows)} | SF: {sf_y} | ?: {sf_q} | N: {sf_n}")
print(f"Wrote {out}")
