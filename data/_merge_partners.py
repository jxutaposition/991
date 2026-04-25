import csv, re
from pathlib import Path

DATA = Path(__file__).parent
parts = ["sf_partners_part1.csv", "sf_partners_part2.csv", "sf_partners_part3.csv", "sf_partners_part4.csv", "sf_partners_part5.csv"]

rows, seen = [], {}
for p in parts:
    with open(DATA / p, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            key = re.sub(r"\s+", " ", (row.get("name") or "").strip().lower())
            if not key:
                continue
            if key in seen:
                # merge non-empty values; upgrade sf_based Y > Yes > yes > ? > N
                ex = seen[key]
                for col in ("firm", "title", "linkedin_or_source_url", "notes"):
                    if not (ex.get(col) or "").strip() and (row.get(col) or "").strip():
                        ex[col] = row[col]
                continue
            # normalize sf_based to Y/N/?
            sf = (row.get("sf_based") or "").strip().lower()
            if sf in ("y", "yes"): row["sf_based"] = "Y"
            elif sf in ("n", "no"): row["sf_based"] = "N"
            else: row["sf_based"] = "?"
            seen[key] = row
            rows.append(row)

def sf_rank(r):
    return {"Y": 0, "?": 1, "N": 2}.get(r.get("sf_based") or "?", 1)
def title_rank(r):
    t = (r.get("title") or "").lower()
    if "managing partner" in t or "founding partner" in t: return 0
    if "general partner" in t: return 1
    if "partner" in t: return 2
    return 3

rows.sort(key=lambda r: (sf_rank(r), title_rank(r), (r.get("firm") or "").lower(), (r.get("name") or "").lower()))

out = DATA / "sf_partners.csv"
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["name", "firm", "title", "sf_based", "linkedin_or_source_url", "notes"])
    w.writeheader()
    for r in rows: w.writerow({k: (r.get(k) or "") for k in w.fieldnames})

sf_y = sum(1 for r in rows if r["sf_based"] == "Y")
sf_q = sum(1 for r in rows if r["sf_based"] == "?")
sf_n = sum(1 for r in rows if r["sf_based"] == "N")
firms = sorted({r.get("firm") for r in rows if r.get("firm")})
print(f"Total partners: {len(rows)} | SF: {sf_y} | ?: {sf_q} | N: {sf_n}")
print(f"Firms covered ({len(firms)}): {', '.join(firms)}")
