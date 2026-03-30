import React, { useEffect, useState } from "react";

interface RecordingState {
  isRecording: boolean;
  sessionId: string | null;
}

export function Popup() {
  const [state, setState] = useState<RecordingState | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (res?.state) setState(res.state as RecordingState);
    });
  }, []);

  const openSidePanel = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) {
        (chrome.sidePanel as { open: (opts: { tabId: number }) => void }).open({ tabId: tab.id });
        window.close();
      }
    });
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", color: "#e4e4e7" }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>lele Observer</div>
        <div style={{ fontSize: 12, color: "#71717a" }}>
          {state?.isRecording ? `Recording · ${state.sessionId?.slice(0, 8) ?? ""}` : "Not recording"}
        </div>
      </div>
      <button
        onClick={openSidePanel}
        style={{ width: "100%", padding: 8, background: "#1d4ed8", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 }}
      >
        Open Side Panel
      </button>
    </div>
  );
}
