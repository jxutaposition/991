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

const LEGACY_DECISIONS_KEY = "lele-investor-decisions-v1";
const LEGACY_LGM_QUEUE_KEY = "lele-lgm-sync-queue-v1";
const LEGACY_LGM_MISSING_LINKEDIN_KEY = "lele-lgm-missing-linkedin-v1";
const LEGACY_MORE_QUEUE_KEY = "lele-more-lookalike-queue-v1";
const LEGACY_LGM_SYNCED_KEY = "lele-lgm-synced-v1";
const LEGACY_MIGRATED_KEY = "lele-supabase-state-migrated-v1";

async function stateRequest<T>(body?: unknown): Promise<T> {
  const payload = body ? JSON.stringify(body) : undefined;
  const res = await fetch("/api/state", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: payload,
    keepalive: Boolean(body),
  });
  if (!res.ok) throw new Error(`state request failed: ${res.status}`);
  return res.json();
}

export async function loadRemoteState(): Promise<RemoteState> {
  const legacy = loadLegacyState();
  try {
    const remote = await stateRequest<RemoteState>();
    const merged = mergeState(legacy, remote);
    if (hasLegacyState(legacy) && shouldMigrateLegacy()) {
      migrateLegacyState(legacy).catch(err => console.warn("Failed to migrate legacy local state", err));
    }
    return merged;
  } catch (err) {
    console.warn("Failed to load remote state", err);
    return hasLegacyState(legacy) ? legacy : EMPTY_STATE;
  }
}

export async function saveDecision(id: string, decision: Decision) {
  saveLegacyDecision(id, decision);
  await stateRequest({ op: "saveDecision", id, decision });
}

export async function saveSwipeDecision(id: string, decision: Decision, queue: "lgm" | "lgmMissingLinkedIn" | "more" | "none") {
  saveLegacyDecision(id, decision);
  saveLegacyQueueState(id, queue);
  await stateRequest({ op: "saveSwipe", id, decision, queue });
}

export async function clearDecisions() {
  clearLegacyState();
  await stateRequest({ op: "clear" });
}

export async function queueForLGM(id: string) {
  saveLegacyQueueItem(LEGACY_LGM_QUEUE_KEY, id);
  await stateRequest({ op: "queue", queue: "lgm", id });
}

export async function dequeueFromLGM(id: string) {
  removeLegacyQueueItem(LEGACY_LGM_QUEUE_KEY, id);
  await stateRequest({ op: "dequeue", queue: "lgm", id });
}

export async function queueForLGMMissingLinkedIn(id: string) {
  saveLegacyQueueItem(LEGACY_LGM_MISSING_LINKEDIN_KEY, id);
  await stateRequest({ op: "queue", queue: "lgmMissingLinkedIn", id });
}

export async function dequeueFromLGMMissingLinkedIn(id: string) {
  removeLegacyQueueItem(LEGACY_LGM_MISSING_LINKEDIN_KEY, id);
  await stateRequest({ op: "dequeue", queue: "lgmMissingLinkedIn", id });
}

export async function queueForMore(id: string) {
  saveLegacyQueueItem(LEGACY_MORE_QUEUE_KEY, id);
  await stateRequest({ op: "queue", queue: "more", id });
}

export async function dequeueFromMore(id: string) {
  removeLegacyQueueItem(LEGACY_MORE_QUEUE_KEY, id);
  await stateRequest({ op: "dequeue", queue: "more", id });
}

export async function markLGMSynced(id: string) {
  await stateRequest({ op: "markSynced", id });
}

function loadLegacyState(): RemoteState {
  if (typeof window === "undefined") return EMPTY_STATE;
  return {
    decisions: readLegacyJson<DecisionMap>(LEGACY_DECISIONS_KEY, {}),
    lgmQueue: readLegacyJson<string[]>(LEGACY_LGM_QUEUE_KEY, []),
    lgmMissingLinkedInQueue: readLegacyJson<string[]>(LEGACY_LGM_MISSING_LINKEDIN_KEY, []),
    moreQueue: readLegacyJson<string[]>(LEGACY_MORE_QUEUE_KEY, []),
    lgmSynced: readLegacyJson<Record<string, string>>(LEGACY_LGM_SYNCED_KEY, {}),
  };
}

function readLegacyJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveLegacyDecision(id: string, decision: Decision) {
  if (typeof window === "undefined") return;
  const decisions = readLegacyJson<DecisionMap>(LEGACY_DECISIONS_KEY, {});
  decisions[id] = decision;
  localStorage.setItem(LEGACY_DECISIONS_KEY, JSON.stringify(decisions));
  localStorage.removeItem(LEGACY_MIGRATED_KEY);
}

function saveLegacyQueueState(id: string, queue: "lgm" | "lgmMissingLinkedIn" | "more" | "none") {
  if (typeof window === "undefined") return;
  removeLegacyQueueItem(LEGACY_LGM_QUEUE_KEY, id);
  removeLegacyQueueItem(LEGACY_LGM_MISSING_LINKEDIN_KEY, id);
  removeLegacyQueueItem(LEGACY_MORE_QUEUE_KEY, id);
  if (queue === "lgm") saveLegacyQueueItem(LEGACY_LGM_QUEUE_KEY, id);
  else if (queue === "lgmMissingLinkedIn") saveLegacyQueueItem(LEGACY_LGM_MISSING_LINKEDIN_KEY, id);
  else if (queue === "more") saveLegacyQueueItem(LEGACY_MORE_QUEUE_KEY, id);
  localStorage.removeItem(LEGACY_MIGRATED_KEY);
}

function saveLegacyQueueItem(key: string, id: string) {
  if (typeof window === "undefined") return;
  const queue = readLegacyJson<string[]>(key, []);
  if (!queue.includes(id)) queue.push(id);
  localStorage.setItem(key, JSON.stringify(queue));
  localStorage.removeItem(LEGACY_MIGRATED_KEY);
}

function removeLegacyQueueItem(key: string, id: string) {
  if (typeof window === "undefined") return;
  const queue = readLegacyJson<string[]>(key, []);
  localStorage.setItem(key, JSON.stringify(queue.filter(x => x !== id)));
  localStorage.removeItem(LEGACY_MIGRATED_KEY);
}

function clearLegacyState() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(LEGACY_DECISIONS_KEY);
  localStorage.removeItem(LEGACY_LGM_QUEUE_KEY);
  localStorage.removeItem(LEGACY_LGM_MISSING_LINKEDIN_KEY);
  localStorage.removeItem(LEGACY_MORE_QUEUE_KEY);
  localStorage.removeItem(LEGACY_LGM_SYNCED_KEY);
  localStorage.removeItem(LEGACY_MIGRATED_KEY);
}

function hasLegacyState(state: RemoteState) {
  return Object.keys(state.decisions).length > 0
    || state.lgmQueue.length > 0
    || state.lgmMissingLinkedInQueue.length > 0
    || state.moreQueue.length > 0
    || Object.keys(state.lgmSynced).length > 0;
}

function shouldMigrateLegacy() {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LEGACY_MIGRATED_KEY) !== "1";
}

function mergeState(legacy: RemoteState, remote: RemoteState): RemoteState {
  const decisions = { ...legacy.decisions, ...remote.decisions };
  const moreQueue = unique([...legacy.moreQueue, ...remote.moreQueue]);
  for (const [id, decision] of Object.entries(decisions)) {
    if (decision === "more" && !moreQueue.includes(id)) moreQueue.push(id);
  }
  return {
    decisions,
    lgmQueue: unique([...legacy.lgmQueue, ...remote.lgmQueue]),
    lgmMissingLinkedInQueue: unique([...legacy.lgmMissingLinkedInQueue, ...remote.lgmMissingLinkedInQueue]),
    moreQueue,
    lgmSynced: { ...legacy.lgmSynced, ...remote.lgmSynced },
  };
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

async function migrateLegacyState(state: RemoteState) {
  for (const [id, decision] of Object.entries(state.decisions)) {
    await saveDecision(id, decision);
  }
  for (const id of state.lgmQueue) await queueForLGM(id);
  for (const id of state.lgmMissingLinkedInQueue) await queueForLGMMissingLinkedIn(id);
  for (const id of state.moreQueue) await queueForMore(id);
  for (const id of Object.keys(state.lgmSynced)) await markLGMSynced(id);
  if (typeof window !== "undefined") localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
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
