"use client";

import { useState, useCallback } from "react";
import { Play, Square, FlaskConical, Eye, Clapperboard } from "lucide-react";
import { DragResizeLayout } from "@/components/drag-resize-layout";
import { LiveEventFeed } from "@/components/live-event-feed";
import { ScriptedDemo } from "@/components/scripted-demo";
import { LiveTestPanel } from "@/components/live-test-panel";
import { ShadowSessionPanel } from "@/components/shadow-session-panel";

type Mode = "scripted" | "live" | "shadow";

const MODE_CONFIG = {
  scripted: { label: "Scripted Demo", icon: Clapperboard, description: "Auto-plays a GTM workflow on mock pages" },
  live: { label: "Live Test", icon: FlaskConical, description: "Browse mock pages yourself with the extension" },
  shadow: { label: "Shadow Session", icon: Eye, description: "Watch an expert\u2019s session in real-time" },
} as const;

export default function TestingPage() {
  const [mode, setMode] = useState<Mode>("scripted");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const startScriptedDemo = useCallback(async () => {
    setIsRunning(true);
    try {
      const res = await fetch("/api/demo/run", { method: "POST" });
      if (!res.ok) throw new Error(`Demo failed: ${res.statusText}`);
      const data = await res.json();
      if (data.session_id) {
        setSessionId(data.session_id);
      }
    } catch (e) {
      console.error("Failed to start demo:", e);
      setIsRunning(false);
    }
  }, []);

  const startLiveSession = useCallback(async () => {
    try {
      const res = await fetch("/api/observe/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expert_id: "00000000-0000-0000-0000-000000000099" }),
      });
      if (!res.ok) throw new Error(`Session start failed: ${res.statusText}`);
      const data = await res.json();
      if (data.session_id) {
        setSessionId(data.session_id);
        setIsRunning(true);
      }
    } catch (e) {
      console.error("Failed to start session:", e);
    }
  }, []);

  const endLiveSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`/api/observe/session/${sessionId}/end`, { method: "POST" });
      setIsRunning(false);
    } catch (e) {
      console.error("Failed to end session:", e);
    }
  }, [sessionId]);

  const handleModeChange = (newMode: Mode) => {
    setMode(newMode);
    // Don't reset session when switching to shadow mode (it picks existing sessions)
    if (newMode !== "shadow") {
      setSessionId(null);
      setIsRunning(false);
    }
  };

  // Build left panel based on mode
  const leftPanel = (() => {
    switch (mode) {
      case "scripted":
        return <ScriptedDemo sessionId={sessionId} isRunning={isRunning} />;
      case "live":
        return (
          <LiveTestPanel
            sessionId={sessionId}
            onStartSession={startLiveSession}
            onEndSession={endLiveSession}
            isRecording={isRunning}
          />
        );
      case "shadow":
        return (
          <ShadowSessionPanel
            onSessionSelect={(id) => setSessionId(id)}
            selectedSessionId={sessionId}
          />
        );
    }
  })();

  return (
    <div className="flex flex-col h-screen">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-rim bg-page shrink-0">
        {/* Mode toggle */}
        <div className="flex gap-1 bg-surface rounded-lg p-0.5">
          {(Object.entries(MODE_CONFIG) as [Mode, typeof MODE_CONFIG[Mode]][]).map(([key, cfg]) => {
            const Icon = cfg.icon;
            return (
              <button
                key={key}
                onClick={() => handleModeChange(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors ${
                  mode === key
                    ? "bg-page text-ink shadow-sm"
                    : "text-ink-3 hover:text-ink-2"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {cfg.label}
              </button>
            );
          })}
        </div>

        <span className="text-xs text-ink-3">{MODE_CONFIG[mode].description}</span>

        <div className="flex-1" />

        {/* Action buttons */}
        {mode === "scripted" && !isRunning && (
          <button
            onClick={startScriptedDemo}
            className="flex items-center gap-1.5 bg-brand text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-hover transition-colors"
          >
            <Play className="w-3.5 h-3.5" /> Start Demo
          </button>
        )}
        {mode === "scripted" && isRunning && (
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Pipeline running...
          </div>
        )}
        {mode === "live" && isRunning && (
          <button
            onClick={endLiveSession}
            className="flex items-center gap-1.5 bg-ink-3 text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-ink-2 transition-colors"
          >
            <Square className="w-3.5 h-3.5" /> End Session
          </button>
        )}
      </div>

      {/* Split screen: left panel + live feed */}
      <DragResizeLayout
        defaultRightWidth={480}
        minRightWidth={320}
        maxRightWidth="60%"
        left={leftPanel}
        right={<LiveEventFeed sessionId={sessionId} />}
      />
    </div>
  );
}
