import React, { useEffect, useState, useRef } from "react";

interface NarrationEntry {
  id: string;
  text: string;
  timestamp: number;
  type: "narration" | "correction" | "error";
}

interface RecordingState {
  isRecording: boolean;
  sessionId: string | null;
  expertId: string;
}

const BACKEND = "http://localhost:3001";

export function SidePanel() {
  const [state, setState] = useState<RecordingState>({ isRecording: false, sessionId: null, expertId: "default_expert" });
  const [narrations, setNarrations] = useState<NarrationEntry[]>([]);
  const [correction, setCorrection] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (res?.state) setState(res.state as RecordingState);
    });
  }, []);

  // SSE narration stream
  useEffect(() => {
    esRef.current?.close();
    if (!state.sessionId) { esRef.current = null; return; }
    const es = new EventSource(`${BACKEND}/api/observe/session/${state.sessionId}/narration`);
    es.addEventListener("narration_chunk", (e) => {
      const data = JSON.parse(e.data) as { text: string };
      setNarrations((prev) => [...prev, { id: crypto.randomUUID(), text: data.text, timestamp: Date.now(), type: "narration" }]);
    });
    es.onerror = () => {
      setNarrations((prev) => [...prev, { id: crypto.randomUUID(), text: "Connection lost — reconnecting...", timestamp: Date.now(), type: "error" }]);
    };
    esRef.current = es;
    return () => es.close();
  }, [state.sessionId]);

  // Background messages
  useEffect(() => {
    const handler = (msg: { type: string; sessionId?: string }) => {
      if (msg.type === "SESSION_STARTED" && msg.sessionId) setState((s) => ({ ...s, isRecording: true, sessionId: msg.sessionId! }));
      if (msg.type === "SESSION_ENDED") setState((s) => ({ ...s, isRecording: false, sessionId: null }));
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // Auto-scroll
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [narrations]);

  const startRecording = () => chrome.runtime.sendMessage({ type: "START_RECORDING", expertId: state.expertId });
  const stopRecording = () => chrome.runtime.sendMessage({ type: "STOP_RECORDING" });

  const submitCorrection = async () => {
    if (!correction.trim() || !state.sessionId) return;
    setSubmitting(true);
    const text = correction.trim();
    setCorrection("");
    try {
      await fetch(`${BACKEND}/api/observe/session/${state.sessionId}/correction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequence_ref: narrations.length, correction: text }),
      });
      setNarrations((prev) => [...prev, { id: crypto.randomUUID(), text: `You: ${text}`, timestamp: Date.now(), type: "correction" }]);
    } finally {
      setSubmitting(false);
    }
  };

  const S: Record<string, React.CSSProperties> = {
    root: { display: "flex", flexDirection: "column", height: "100vh", background: "#09090b", color: "#e4e4e7", fontFamily: "system-ui, sans-serif", fontSize: 13 },
    header: { padding: "12px 16px", borderBottom: "1px solid #27272a", display: "flex", alignItems: "center", justifyContent: "space-between" },
    dot: { width: 8, height: 8, borderRadius: "50%", background: state.isRecording ? "#ef4444" : "#3f3f46" },
    feed: { flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 },
    footer: { padding: "10px 16px", borderTop: "1px solid #27272a", display: "flex", gap: 8 },
    input: { flex: 1, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, padding: "6px 10px", color: "#e4e4e7", fontSize: 12, outline: "none" },
    sendBtn: { padding: "6px 12px", background: "#1d4ed8", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, opacity: submitting || !correction.trim() ? 0.5 : 1 },
    recBtn: { padding: "4px 12px", borderRadius: 6, border: "none", background: state.isRecording ? "#450a0a" : "#052e16", color: state.isRecording ? "#fca5a5" : "#86efac", cursor: "pointer", fontSize: 12, fontWeight: 500 },
  };

  return (
    <div style={S.root}>
      <div style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={S.dot} />
          <span style={{ fontWeight: 600 }}>lele</span>
          {state.sessionId && <span style={{ fontSize: 11, color: "#52525b" }}>{state.sessionId.slice(0, 8)}</span>}
        </div>
        <button style={S.recBtn} onClick={state.isRecording ? stopRecording : startRecording}>
          {state.isRecording ? "Stop" : "Record"}
        </button>
      </div>

      <div ref={feedRef} style={S.feed}>
        {narrations.length === 0 && (
          <div style={{ color: "#52525b", fontSize: 12, marginTop: 24, textAlign: "center" }}>
            {state.isRecording ? "Observing… narration will appear shortly." : "Press Record to start a session."}
          </div>
        )}
        {narrations.map((n) => (
          <div key={n.id} style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: n.type === "correction" ? "#1c1917" : n.type === "error" ? "#1c0a0a" : "#18181b",
            borderLeft: `2px solid ${n.type === "correction" ? "#a16207" : n.type === "error" ? "#7f1d1d" : "#3f3f46"}`,
            lineHeight: 1.5,
            color: n.type === "error" ? "#fca5a5" : n.type === "correction" ? "#fde68a" : "#d4d4d8",
          }}>
            {n.text}
          </div>
        ))}
      </div>

      {state.isRecording && (
        <div style={S.footer}>
          <input
            style={S.input}
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submitCorrection()}
            placeholder="Correct the narration…"
          />
          <button style={S.sendBtn} onClick={submitCorrection} disabled={submitting || !correction.trim()}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}
