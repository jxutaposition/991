"use client";

import { useState } from "react";
import { Globe, AlertCircle } from "lucide-react";

export function LiveTestPanel({
  sessionId,
  onStartSession,
  onEndSession,
  isRecording,
}: {
  sessionId: string | null;
  onStartSession: () => void;
  onEndSession: () => void;
  isRecording: boolean;
}) {
  const [url, setUrl] = useState("/mock-gtm/sales-nav/search");

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* URL bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-rim bg-page shrink-0">
        <Globe className="w-3.5 h-3.5 text-ink-3 shrink-0" />
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setUrl(url)}
          className="flex-1 bg-surface border border-rim rounded px-2 py-1 text-xs font-mono text-ink focus:outline-none focus:border-brand"
          placeholder="Enter URL..."
        />
        {!isRecording ? (
          <button
            onClick={onStartSession}
            className="bg-red-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-red-700"
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={onEndSession}
            className="bg-ink-3 text-white px-3 py-1 rounded text-xs font-medium hover:bg-ink-2"
          >
            Stop Recording
          </button>
        )}
      </div>

      {/* Recording indicator */}
      {isRecording && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 border-b border-red-200 shrink-0">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-[10px] text-red-700 font-medium">Recording — browse in this iframe or a separate tab with the extension</span>
        </div>
      )}

      {/* Info banner */}
      {!isRecording && !sessionId && (
        <div className="flex items-start gap-2 px-3 py-2 bg-blue-50 border-b border-blue-200 shrink-0">
          <AlertCircle className="w-3.5 h-3.5 text-blue-500 mt-0.5 shrink-0" />
          <div className="text-[10px] text-blue-700">
            <p className="font-medium">How Live Test works:</p>
            <p className="mt-0.5">1. Click "Start Recording" to create an observation session</p>
            <p>2. Browse mock pages in the iframe below, or real sites in a separate tab with the Chrome extension</p>
            <p>3. Events appear in the live feed on the right</p>
          </div>
        </div>
      )}

      {/* Iframe */}
      <div className="flex-1">
        <iframe
          src={url}
          className="w-full h-full border-0"
          title="Live browsing"
        />
      </div>
    </div>
  );
}
