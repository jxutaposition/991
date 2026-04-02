"use client";

import { useState } from "react";
import { X, Clock, Zap, MessageSquare, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { ExecutionEvent } from "./inspector-panel";

interface EventDetailsPopupProps {
  event: ExecutionEvent;
  onClose: () => void;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-ink-3 hover:text-ink-2 transition-colors"
      title="Copy"
    >
      {copied ? (
        <Check className="w-3 h-3 text-green-600" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  );
}

function formatTimestamp(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return ts.slice(0, 19);
  }
}

function getEventIcon(eventType: string) {
  if (eventType.includes("tool")) return Zap;
  if (eventType.includes("judge") || eventType.includes("critic"))
    return MessageSquare;
  return Clock;
}

function getEventColor(eventType: string): string {
  if (eventType.includes("fail") || eventType.includes("reject"))
    return "bg-red-50 border-red-300";
  if (eventType.includes("completed") || eventType.includes("pass"))
    return "bg-green-50 border-green-300";
  if (eventType.includes("tool")) return "bg-cyan-50 border-cyan-200";
  if (eventType.includes("judge")) return "bg-purple-50 border-purple-200";
  return "bg-page border-rim";
}

export function EventDetailsPopup({ event, onClose }: EventDetailsPopupProps) {
  const Icon = getEventIcon(event.event_type);
  const payload = event.payload;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`bg-page border rounded-2xl w-full max-w-2xl flex flex-col shadow-xl ${getEventColor(event.event_type)}`}
        style={{ height: "auto", maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 shrink-0 border-b border-rim">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-lg bg-surface border border-rim flex items-center justify-center shrink-0 mt-0.5">
              <Icon className="w-5 h-5 text-ink-2" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2 flex-wrap">
                <h2 className="text-base font-semibold text-ink">
                  {formatEventType(event.event_type)}
                </h2>
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono bg-surface border-rim text-ink-2 shrink-0"
                >
                  {event.event_type}
                </Badge>
              </div>
              <p className="text-xs text-ink-3 mt-1">
                {formatTimestamp(event.created_at)}
              </p>
            </div>
          </div>
          <Button
            onClick={onClose}
            variant="ghost"
            size="sm"
            className="text-ink-3 hover:text-ink w-8 h-8 p-0 shrink-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-6 space-y-4">
            {/* Event Metadata */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-surface border border-rim rounded p-2">
                <p className="text-ink-3">Event ID</p>
                <p className="text-ink font-mono text-[10px] flex items-center gap-1">
                  {event.id?.slice(0, 18)}\u2026
                  <CopyButton text={event.id} />
                </p>
              </div>
              <div className="bg-surface border border-rim rounded p-2">
                <p className="text-ink-3">Node ID</p>
                <p className="text-ink font-mono text-[10px] flex items-center gap-1">
                  {event.node_id?.slice(0, 18)}\u2026
                  <CopyButton text={event.node_id} />
                </p>
              </div>
            </div>

            {/* Payload details */}
            {payload && Object.keys(payload).length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-ink-2 mb-2">
                  Payload
                </h3>

                {payload.tool != null && (
                  <div className="mb-2 text-xs bg-surface border border-rim rounded p-2">
                    <span className="text-ink-3">Tool: </span>
                    <span className="text-brand font-mono">
                      {String(payload.tool)}
                    </span>
                  </div>
                )}

                {payload.feedback != null && (
                  <div className="mb-2 text-xs bg-surface border border-rim rounded p-3">
                    <p className="text-ink-3 font-semibold mb-1">Feedback</p>
                    <p className="text-ink whitespace-pre-wrap">
                      {String(payload.feedback)}
                    </p>
                  </div>
                )}

                {payload.score != null && (
                  <div className="mb-2 text-xs bg-surface border border-rim rounded p-2">
                    <span className="text-ink-3">Score: </span>
                    <span className="text-ink font-mono font-semibold">
                      {String(payload.score)}
                    </span>
                  </div>
                )}

                {(payload.input_tokens != null || payload.cache_read_tokens != null) && (
                  <div className="mb-2 text-xs bg-surface border border-rim rounded p-2 space-y-1">
                    <p className="text-ink-3 font-semibold">Token Usage</p>
                    <div className="flex gap-4 font-mono">
                      {payload.input_tokens != null && (
                        <span>in: <span className="text-ink font-semibold">{String(payload.input_tokens)}</span></span>
                      )}
                      {payload.output_tokens != null && (
                        <span>out: <span className="text-ink font-semibold">{String(payload.output_tokens)}</span></span>
                      )}
                    </div>
                    {(payload.cache_read_tokens != null || payload.cache_creation_tokens != null) && (
                      <div className="flex gap-4 font-mono">
                        {payload.cache_read_tokens != null && (
                          <span className="text-green-500">cache hit: {String(payload.cache_read_tokens)}</span>
                        )}
                        {payload.cache_creation_tokens != null && (
                          <span className="text-yellow-500">cache write: {String(payload.cache_creation_tokens)}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Raw JSON */}
                <pre className="text-xs text-ink-2 bg-surface p-3 rounded border border-rim overflow-auto max-h-64 whitespace-pre-wrap break-words">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              </div>
            )}

            {/* Empty payload */}
            {(!payload || Object.keys(payload).length === 0) && (
              <p className="text-xs text-ink-3">
                No additional details for this event.
              </p>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function formatEventType(eventType: string): string {
  const labels: Record<string, string> = {
    node_started: "Node Started",
    node_completed: "Node Completed",
    tool_call: "Tool Call",
    tool_result: "Tool Result",
    critic_start: "Critic Started",
    critic_done: "Critic Done",
    judge_start: "Judge Started",
    judge_done: "Judge Verdict",
    judge_pass: "Judge Passed",
    judge_fail: "Judge Failed",
    judge_reject: "Judge Rejected",
    node_retry: "Node Retry",
    child_agent_spawned: "Child Agent Spawned",
    checkpoint_reached: "Checkpoint Reached",
    session_completed: "Session Completed",
  };
  return labels[eventType] || eventType.replace(/_/g, " ");
}
