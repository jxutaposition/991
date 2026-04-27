import type { Decision, DecisionMap } from "./types";
import { normalizeLinkedInProfileUrl } from "./linkedin";

export type RemoteState = {
  decisions: DecisionMap;
  lgmQueue: string[];
  lgmMissingLinkedInQueue: string[];
  moreQueue: string[];
  lgmSynced: Record<string, string>;
};

const EMPTY_STATE: RemoteState = {
  decisions: {},
  lgmQueue: [],
  lgmMissingLinkedInQueue: [],
  moreQueue: [],
  lgmSynced: {},
};

async function stateRequest<T>(body?: unknown): Promise<T> {
  const res = await fetch("/api/state", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`state request failed: ${res.status}`);
  return res.json();
}

export async function loadRemoteState(): Promise<RemoteState> {
  try {
    return await stateRequest<RemoteState>();
  } catch (err) {
    console.warn("Failed to load remote state", err);
    return EMPTY_STATE;
  }
}

export async function saveDecision(id: string, decision: Decision) {
  await stateRequest({ op: "saveDecision", id, decision });
}

export async function clearDecisions() {
  await stateRequest({ op: "clear" });
}

export async function queueForLGM(id: string) {
  await stateRequest({ op: "queue", queue: "lgm", id });
}

export async function dequeueFromLGM(id: string) {
  await stateRequest({ op: "dequeue", queue: "lgm", id });
}

export async function queueForLGMMissingLinkedIn(id: string) {
  await stateRequest({ op: "queue", queue: "lgmMissingLinkedIn", id });
}

export async function dequeueFromLGMMissingLinkedIn(id: string) {
  await stateRequest({ op: "dequeue", queue: "lgmMissingLinkedIn", id });
}

export async function queueForMore(id: string) {
  await stateRequest({ op: "queue", queue: "more", id });
}

export async function dequeueFromMore(id: string) {
  await stateRequest({ op: "dequeue", queue: "more", id });
}

export async function markLGMSynced(id: string) {
  await stateRequest({ op: "markSynced", id });
}

export function exportCSV(decisions: DecisionMap, profiles: { id: string; name: string; firm: string; bucket: string; linkedin?: string }[]) {
  const rows = [["decision", "name", "firm", "bucket", "linkedin", "source_url"]];
  for (const p of profiles) {
    const d = decisions[p.id];
    if (!d) continue;
    const linkedin = normalizeLinkedInProfileUrl(p.linkedin);
    rows.push([d, p.name, p.firm, p.bucket, linkedin ?? "", linkedin ? "" : p.linkedin ?? ""]);
  }
  downloadCSV(rows, `lele-decisions-${new Date().toISOString().slice(0, 10)}.csv`);
}

export function exportLGMQueue(profiles: { id: string; name: string; firm: string; linkedin?: string }[], queue: string[]): number {
  const queued = profiles.filter(p => queue.includes(p.id) && normalizeLinkedInProfileUrl(p.linkedin));
  const rows = [["name", "firm", "linkedin_url"]];
  for (const p of queued) rows.push([p.name, p.firm, normalizeLinkedInProfileUrl(p.linkedin) ?? ""]);
  downloadCSV(rows, `lgm-investors-queue-${new Date().toISOString().slice(0, 10)}.csv`);
  return queued.length;
}

export function exportLGMMissingLinkedInQueue(profiles: { id: string; name: string; firm: string; bucket: string; linkedin?: string }[], queue: string[]): number {
  const queued = profiles.filter(p => queue.includes(p.id));
  const rows = [["name", "firm", "bucket", "source_url"]];
  for (const p of queued) rows.push([p.name, p.firm, p.bucket, p.linkedin ?? ""]);
  downloadCSV(rows, `lgm-missing-linkedin-${new Date().toISOString().slice(0, 10)}.csv`);
  return queued.length;
}

function downloadCSV(rows: string[][], filename: string) {
  const csv = rows.map(r => r.map(v => `"${(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
