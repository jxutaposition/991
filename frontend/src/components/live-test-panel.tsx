"use client";

import { useState, useRef, useEffect } from "react";
import { Globe, CheckCircle2, XCircle, Plug } from "lucide-react";

function useExtensionDetected(): boolean {
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    function check() {
      setDetected(document.documentElement.dataset.leleObserver === "active");
    }
    check();
    // Re-check periodically (extension may load after page)
    const interval = setInterval(check, 2000);
    return () => clearInterval(interval);
  }, []);

  return detected;
}

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
  const [iframeSrc, setIframeSrc] = useState("/mock-gtm/sales-nav/search");
  const [inputValue, setInputValue] = useState("/mock-gtm/sales-nav/search");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const extensionDetected = useExtensionDetected();

  function normalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith("/")) return trimmed;
    if (/^https?:\/\//.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  function toIframeSrc(raw: string): string {
    const normalized = normalizeUrl(raw);
    // Local/mock paths load directly; external URLs go through the proxy
    if (normalized.startsWith("/")) return normalized;
    return `/proxy?url=${encodeURIComponent(normalized)}`;
  }

  function navigateTo(raw: string) {
    const normalized = normalizeUrl(raw);
    setInputValue(normalized);
    setIframeSrc(toIframeSrc(raw));
  }

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* URL bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-rim bg-page shrink-0">
        <Globe className="w-3.5 h-3.5 text-ink-3 shrink-0" />
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigateTo(inputValue)}
          className="flex-1 bg-surface border border-rim rounded px-2 py-1 text-xs font-mono text-ink focus:outline-none focus:border-brand"
          placeholder="Enter URL (e.g. google.com or /mock-gtm/sales-nav/search)"
        />

        {/* Extension status pill */}
        <div
          className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium shrink-0 ${
            extensionDetected
              ? "bg-success-subtle text-success"
              : "bg-warning-subtle text-warning"
          }`}
        >
          <Plug className="w-3 h-3" />
          {extensionDetected ? "Extension active" : "No extension"}
        </div>

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
          <span className="text-xs text-red-700 font-medium">Recording — browse in this iframe or a separate tab with the extension</span>
        </div>
      )}

      {/* Extension setup / instructions banner */}
      {!isRecording && !sessionId && (
        extensionDetected ? (
          <div className="flex items-start gap-2 px-3 py-2 bg-green-50 border-b border-green-200 shrink-0">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-600 mt-0.5 shrink-0" />
            <div className="text-xs text-green-800">
              <p className="font-semibold">Extension connected</p>
              <p className="mt-0.5">1. Click &quot;Start Recording&quot; to begin an observation session</p>
              <p>2. Browse mock pages in the iframe below, or any site in a separate tab</p>
              <p>3. The extension captures clicks, navigation, and form submissions automatically</p>
              <p>4. Events and AI narrations appear in the live feed on the right</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 shrink-0">
            <XCircle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-900">
              <p className="font-semibold">Extension not detected — install it to capture browser events</p>
              <div className="mt-1.5 space-y-1 text-amber-800">
                <p>1. Open <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-xs">chrome://extensions</code> in Chrome</p>
                <p>2. Enable <strong>Developer mode</strong> (toggle in top-right corner)</p>
                <p>3. Click <strong>Load unpacked</strong> and select the <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-xs">extension/</code> folder from this repo</p>
                <p>4. Reload this page — the status above will turn green when the extension is active</p>
              </div>
              <p className="mt-1.5 text-amber-600">
                Without the extension, &quot;Start Recording&quot; will still create a session,
                but no DOM events will be captured automatically.
              </p>
            </div>
          </div>
        )
      )}

      {/* Iframe */}
      <div className="flex-1">
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          className="w-full h-full border-0"
          title="Live browsing"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        />
      </div>
    </div>
  );
}
