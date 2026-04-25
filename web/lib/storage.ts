import type { Decision, DecisionMap } from "./types";

const KEY = "lele-investor-decisions-v1";

export function loadDecisions(): DecisionMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveDecision(id: string, decision: Decision) {
  if (typeof window === "undefined") return;
  const map = loadDecisions();
  map[id] = decision;
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function clearDecisions() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
}

export function exportCSV(decisions: DecisionMap, profiles: { id: string; name: string; firm: string; bucket: string; linkedin?: string }[]) {
  const rows = [["decision", "name", "firm", "bucket", "linkedin"]];
  for (const p of profiles) {
    const d = decisions[p.id];
    if (!d) continue;
    rows.push([d, p.name, p.firm, p.bucket, p.linkedin ?? ""]);
  }
  const csv = rows.map(r => r.map(v => `"${(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lele-decisions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
