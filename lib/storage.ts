import type { Decision, DecisionMap } from "./types";
import { normalizeLinkedInProfileUrl } from "./linkedin";

const KEY = "lele-investor-decisions-v1";
const LGM_QUEUE_KEY = "lele-lgm-sync-queue-v1";
const LGM_MISSING_LINKEDIN_KEY = "lele-lgm-missing-linkedin-v1";
const LGM_SYNCED_KEY = "lele-lgm-synced-v1";
const MORE_QUEUE_KEY = "lele-more-lookalike-queue-v1";

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
  localStorage.removeItem(LGM_QUEUE_KEY);
  localStorage.removeItem(LGM_MISSING_LINKEDIN_KEY);
  localStorage.removeItem(LGM_SYNCED_KEY);
  localStorage.removeItem(MORE_QUEUE_KEY);
}

export function exportCSV(decisions: DecisionMap, profiles: { id: string; name: string; firm: string; bucket: string; linkedin?: string }[]) {
  const rows = [["decision", "name", "firm", "bucket", "linkedin", "source_url"]];
  for (const p of profiles) {
    const d = decisions[p.id];
    if (!d) continue;
    const linkedin = normalizeLinkedInProfileUrl(p.linkedin);
    rows.push([d, p.name, p.firm, p.bucket, linkedin ?? "", linkedin ? "" : p.linkedin ?? ""]);
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

// LGM sync queue: profiles marked Keep get queued for batch sync to LGM "investors" campaign.

export function queueForLGM(id: string) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(LGM_QUEUE_KEY);
  const queue: string[] = raw ? JSON.parse(raw) : [];
  if (!queue.includes(id)) queue.push(id);
  localStorage.setItem(LGM_QUEUE_KEY, JSON.stringify(queue));
}

export function dequeueFromLGM(id: string) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(LGM_QUEUE_KEY);
  const queue: string[] = raw ? JSON.parse(raw) : [];
  const next = queue.filter(x => x !== id);
  localStorage.setItem(LGM_QUEUE_KEY, JSON.stringify(next));
}

export function queueForLGMMissingLinkedIn(id: string) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(LGM_MISSING_LINKEDIN_KEY);
  const queue: string[] = raw ? JSON.parse(raw) : [];
  if (!queue.includes(id)) queue.push(id);
  localStorage.setItem(LGM_MISSING_LINKEDIN_KEY, JSON.stringify(queue));
}

export function dequeueFromLGMMissingLinkedIn(id: string) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(LGM_MISSING_LINKEDIN_KEY);
  const queue: string[] = raw ? JSON.parse(raw) : [];
  localStorage.setItem(LGM_MISSING_LINKEDIN_KEY, JSON.stringify(queue.filter(x => x !== id)));
}

export function loadLGMMissingLinkedInQueue(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LGM_MISSING_LINKEDIN_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function loadLGMQueue(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LGM_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function queueForMore(id: string) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(MORE_QUEUE_KEY);
  const queue: string[] = raw ? JSON.parse(raw) : [];
  if (!queue.includes(id)) queue.push(id);
  localStorage.setItem(MORE_QUEUE_KEY, JSON.stringify(queue));
}

export function dequeueFromMore(id: string) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(MORE_QUEUE_KEY);
  const queue: string[] = raw ? JSON.parse(raw) : [];
  localStorage.setItem(MORE_QUEUE_KEY, JSON.stringify(queue.filter(x => x !== id)));
}

export function loadMoreQueue(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MORE_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function loadLGMSynced(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LGM_SYNCED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function markLGMSynced(id: string) {
  if (typeof window === "undefined") return;
  const synced = loadLGMSynced();
  synced[id] = new Date().toISOString();
  localStorage.setItem(LGM_SYNCED_KEY, JSON.stringify(synced));
  dequeueFromLGM(id);
}

export function exportLGMQueue(profiles: { id: string; name: string; firm: string; linkedin?: string }[]): number {
  const queue = loadLGMQueue();
  const queued = profiles.filter(p => queue.includes(p.id) && normalizeLinkedInProfileUrl(p.linkedin));
  const rows = [["name", "firm", "linkedin_url"]];
  for (const p of queued) rows.push([p.name, p.firm, normalizeLinkedInProfileUrl(p.linkedin) ?? ""]);
  const csv = rows.map(r => r.map(v => `"${(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lgm-investors-queue-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return queued.length;
}

export function exportLGMMissingLinkedInQueue(profiles: { id: string; name: string; firm: string; bucket: string; linkedin?: string }[]): number {
  const queue = loadLGMMissingLinkedInQueue();
  const queued = profiles.filter(p => queue.includes(p.id));
  const rows = [["name", "firm", "bucket", "source_url"]];
  for (const p of queued) rows.push([p.name, p.firm, p.bucket, p.linkedin ?? ""]);
  const csv = rows.map(r => r.map(v => `"${(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lgm-missing-linkedin-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return queued.length;
}
