/** Cursor debug ingest — only when explicitly enabled (avoids noisy localhost Network tab). */
const INGEST = "http://127.0.0.1:7924/ingest/2f5fe76c-0c9d-4511-bb6b-6e08dd27dd37";
const SESSION_KEY = "9c95a4_agent_last";

function isLocalIngestHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

function agentDebugIngestEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AGENT_DEBUG === "1";
}

export type AgentDebugLogOptions = {
  /** When true, writes one snapshot to sessionStorage (e.g. failed auth for prod diagnosis). */
  persistSession?: boolean;
};

/**
 * Hypothesis-scoped debug log. Opt-in: set `NEXT_PUBLIC_AGENT_DEBUG=1` for localhost NDJSON ingest.
 * Never send tokens or id_token bodies.
 */
export function agentDebugLog(
  runId: string,
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  options?: AgentDebugLogOptions,
): void {
  const payload = {
    sessionId: "9c95a4",
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  if (options?.persistSession && typeof window !== "undefined") {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      /* quota / private mode */
    }
  }
  if (!isLocalIngestHost() || !agentDebugIngestEnabled()) return;
  // #region agent log
  fetch(INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "9c95a4",
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  // #endregion
}
