"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain,
  Bot,
  User,
  Wrench,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Send,
  MessageCircle,
  Activity,
  Hand,
} from "lucide-react";
import type { ExecutionNode } from "./execution-canvas";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StreamEntry {
  id?: string;
  node_id?: string;
  stream_type: "event" | "thinking" | "message";
  sub_type: string;
  content?: string | null;
  thinking_text?: string | null;
  iteration?: number | null;
  token_count?: number | null;
  role?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

interface ConversationStreamProps {
  entries: StreamEntry[];
  loading: boolean;
  selectedNode: ExecutionNode;
  onReply?: (nodeId: string, message: string) => Promise<void>;
  liveThinkingChunks?: Record<string, string>;
  liveTextChunks?: Record<string, string>;
}

// ── Streaming Cursor ─────────────────────────────────────────────────────────

function StreamingCursor() {
  return (
    <span className="inline-block w-1.5 h-4 bg-ink animate-pulse ml-0.5 align-middle" />
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function ConversationStream({
  entries,
  loading,
  selectedNode,
  onReply,
  liveThinkingChunks = {},
  liveTextChunks = {},
}: ConversationStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);

  const hasLiveContent =
    Object.keys(liveTextChunks).length > 0 ||
    Object.keys(liveThinkingChunks).length > 0;

  // Auto-scroll to bottom when entries or live chunks change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, liveTextChunks, liveThinkingChunks]);

  const handleSend = useCallback(async () => {
    if (!replyText.trim() || !onReply || sending) return;
    setSending(true);
    try {
      await onReply(selectedNode.id, replyText.trim());
      setReplyText("");
    } finally {
      setSending(false);
    }
  }, [replyText, onReply, sending, selectedNode.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const canReply =
    selectedNode.status === "awaiting_reply" ||
    selectedNode.status === "passed" ||
    selectedNode.status === "failed";

  // Filter out noisy internal events
  const HIDDEN_EVENTS = new Set([
    "executor_start",
    "executor_llm_send",
    "executor_llm_receive",
    "executor_thinking",
  ]);

  // Dedup guard: track which block indices have finalized assistant entries
  const finalizedAssistantCount = useMemo(
    () =>
      entries.filter(
        (e) => e.stream_type === "message" && e.sub_type === "assistant"
      ).length,
    [entries]
  );
  const finalizedThinkingCount = useMemo(
    () => entries.filter((e) => e.stream_type === "thinking").length,
    [entries]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Stream area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {loading ? (
          <p className="text-sm text-ink-3">Loading conversation...</p>
        ) : entries.length === 0 && !hasLiveContent ? (
          <div className="text-center py-8">
            <Activity className="w-8 h-8 text-ink-3/30 mx-auto mb-2" />
            <p className="text-sm text-ink-3">
              {selectedNode.status === "running"
                ? "Conversation will appear as the agent runs..."
                : selectedNode.status === "pending" ||
                    selectedNode.status === "ready"
                  ? "Conversation will appear once execution starts."
                  : "No activity recorded for this node."}
            </p>
          </div>
        ) : (
          <>
            {entries.map((entry, i) => {
              if (
                entry.stream_type === "event" &&
                HIDDEN_EVENTS.has(entry.sub_type)
              )
                return null;

              switch (entry.stream_type) {
                case "thinking":
                  return (
                    <StreamThinkingBlock
                      key={entry.id ?? `t-${i}`}
                      entry={entry}
                      defaultOpen={false}
                      isStreaming={false}
                    />
                  );
                case "message":
                  if (
                    entry.sub_type === "tool_use" ||
                    entry.sub_type === "tool_result"
                  ) {
                    const toolName = (entry.metadata as Record<string, unknown>)?.tool_name as string | undefined;
                    if (entry.sub_type === "tool_use" && toolName === "request_user_action") {
                      return (
                        <ManualActionCard
                          key={entry.id ?? `m-${i}`}
                          entry={entry}
                        />
                      );
                    }
                    if (entry.sub_type === "tool_result" && toolName === "request_user_action") {
                      return null;
                    }
                    return (
                      <StreamToolCall
                        key={entry.id ?? `m-${i}`}
                        entry={entry}
                      />
                    );
                  }
                  return (
                    <StreamChatBubble
                      key={entry.id ?? `m-${i}`}
                      entry={entry}
                      isStreaming={false}
                    />
                  );
                case "event":
                  return (
                    <StreamEventPill
                      key={entry.id ?? `e-${i}`}
                      entry={entry}
                    />
                  );
                default:
                  return null;
              }
            })}

            {/* Live thinking chunks (dedup: only show if not yet finalized) */}
            {Object.entries(liveThinkingChunks)
              .filter(
                ([blockIdx]) =>
                  Number(blockIdx) >= finalizedThinkingCount
              )
              .map(([blockIdx, text]) => (
                <StreamThinkingBlock
                  key={`live-think-${blockIdx}`}
                  entry={{
                    stream_type: "thinking",
                    sub_type: "thinking_block",
                    thinking_text: text,
                    created_at: new Date().toISOString(),
                  }}
                  defaultOpen={true}
                  isStreaming={true}
                />
              ))}

            {/* Live text chunks (dedup: only show if not yet finalized) */}
            {Object.entries(liveTextChunks)
              .filter(
                ([blockIdx]) =>
                  Number(blockIdx) >= finalizedAssistantCount
              )
              .map(([blockIdx, text]) => (
                <StreamChatBubble
                  key={`live-text-${blockIdx}`}
                  entry={{
                    stream_type: "message",
                    sub_type: "assistant",
                    content: text,
                    created_at: new Date().toISOString(),
                  }}
                  isStreaming={true}
                />
              ))}
          </>
        )}
        {selectedNode.status === "running" &&
          entries.length === 0 &&
          !hasLiveContent && (
            <div className="flex items-center gap-2 px-3 py-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
              <span className="text-xs text-ink-3">Agent is working...</span>
            </div>
          )}
        {selectedNode.status === "awaiting_reply" && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 rounded-lg border border-amber-200">
            <MessageCircle className="w-3.5 h-3.5 text-amber-600" />
            <span className="text-xs text-amber-700">
              Agent is waiting for your reply
            </span>
          </div>
        )}
      </div>

      {/* Reply input */}
      {canReply && onReply && (
        <div className="border-t border-rim p-3 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                selectedNode.status === "awaiting_reply"
                  ? "Reply to the agent..."
                  : "Continue the conversation..."
              }
              className="flex-1 text-sm text-ink border border-rim rounded-lg p-2 leading-relaxed resize-none min-h-[36px] max-h-[120px] focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand"
              rows={1}
              disabled={sending}
            />
            <button
              onClick={handleSend}
              disabled={!replyText.trim() || sending}
              className="shrink-0 p-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50 transition-colors"
              title="Send reply"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-[10px] text-ink-3 mt-1.5">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      )}
    </div>
  );
}

// ── Thinking Block ───────────────────────────────────────────────────────────

function StreamThinkingBlock({
  entry,
  defaultOpen,
  isStreaming,
}: {
  entry: StreamEntry;
  defaultOpen: boolean;
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const text = entry.thinking_text ?? "";
  const previewLength = 120;
  const preview =
    text.length > previewLength
      ? text.slice(0, previewLength).trimEnd() + "\u2026"
      : text;

  // Auto-open while streaming
  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  return (
    <div
      className={`rounded-lg border overflow-hidden ${
        isStreaming
          ? "border-violet-400/40 bg-violet-500/5 border-l-2 border-l-violet-400"
          : "border-violet-500/10 bg-violet-500/[0.03]"
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-violet-500/5 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-violet-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-violet-400 shrink-0" />
        )}
        <Brain className="w-3 h-3 text-violet-400 shrink-0" />
        <span className="text-xs font-medium text-violet-600">
          Thinking{entry.iteration != null ? ` (iter ${entry.iteration})` : ""}
          {isStreaming && (
            <span className="text-[9px] font-medium text-violet-500 bg-violet-500/10 px-1.5 py-0.5 rounded-full ml-2">
              LIVE
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {entry.token_count != null && (
            <span className="text-[9px] text-violet-500/70 font-mono">
              {entry.token_count.toLocaleString()} tokens
            </span>
          )}
        </span>
      </button>
      {!open && (
        <div className="px-3 pb-1.5 -mt-0.5">
          <p className="text-xs text-ink-3 font-mono truncate">
            {preview}
            {isStreaming && <StreamingCursor />}
          </p>
        </div>
      )}
      {open && (
        <div className="border-t border-violet-500/10">
          <div className="px-3 py-2 max-h-[400px] overflow-y-auto">
            <pre className="text-xs font-mono text-ink-2 whitespace-pre-wrap leading-relaxed break-words">
              {text}
              {isStreaming && <StreamingCursor />}
            </pre>
          </div>
          {!isStreaming && (
            <div className="flex items-center justify-between px-3 py-1 border-t border-violet-500/10 bg-violet-500/[0.02]">
              <span className="text-[9px] text-ink-3">
                {text.length.toLocaleString()} chars
                {entry.token_count != null &&
                  ` \u00B7 ${entry.token_count.toLocaleString()} tokens`}
              </span>
              <SmallCopyButton text={text} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Chat Bubble ──────────────────────────────────────────────────────────────

function StreamChatBubble({
  entry,
  isStreaming,
}: {
  entry: StreamEntry;
  isStreaming: boolean;
}) {
  const isUser = entry.sub_type === "user" || entry.role === "user";
  const isHumanReply =
    entry.metadata &&
    (entry.metadata as Record<string, unknown>).source === "human_reply";
  const content = entry.content ?? "";
  const isAssistant = !isUser;

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
          isUser
            ? isHumanReply
              ? "bg-brand/10"
              : "bg-gray-100"
            : "bg-violet-100"
        }`}
      >
        {isUser ? (
          <User
            className={`w-3 h-3 ${isHumanReply ? "text-brand" : "text-ink-3"}`}
          />
        ) : (
          <Bot className="w-3 h-3 text-violet-600" />
        )}
      </div>
      <div
        className={`max-w-full rounded-lg px-3 py-2 ${
          isUser
            ? isHumanReply
              ? "bg-brand/10 border border-brand/20"
              : "bg-gray-100"
            : "bg-surface border border-rim"
        }`}
      >
        {isHumanReply && (
          <span className="text-[9px] text-brand font-medium block mb-0.5">
            You
          </span>
        )}
        {isAssistant && !isStreaming ? (
          <div className="text-sm text-ink leading-relaxed break-words prose prose-sm prose-slate max-w-none [&_pre]:bg-gray-50 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_code]:text-xs [&_code]:bg-gray-50 [&_code]:px-1 [&_code]:rounded">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed break-words">
            {content}
            {isStreaming && <StreamingCursor />}
          </p>
        )}
        {!isStreaming && (
          <span
            className={`text-[9px] block mt-1 ${isUser ? "text-right" : ""} text-ink-3`}
          >
            {new Date(entry.created_at).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Tool Call / Result ────────────────────────────────────────────────────────

function StreamToolCall({ entry }: { entry: StreamEntry }) {
  const isResult = entry.sub_type === "tool_result";
  const toolName =
    ((entry.metadata as Record<string, unknown>)?.tool_name as string) ||
    entry.content ||
    "tool";
  const content = entry.content ?? "";

  return (
    <div className="flex items-start gap-2 px-2 py-0.5">
      <Wrench className="w-3 h-3 text-cyan-500 mt-0.5 shrink-0" />
      <div className="text-xs text-ink-3 min-w-0 flex-1">
        <span className="font-mono font-medium text-ink-2">
          {isResult ? `${toolName} \u2192 result` : `${toolName}()`}
        </span>
        {isResult && content && (
          <div className="mt-0.5 bg-surface rounded p-1.5 max-h-[80px] overflow-y-auto">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all">
              {content.slice(0, 500)}
              {content.length > 500 ? "..." : ""}
            </pre>
          </div>
        )}
      </div>
      <span className="text-[9px] text-ink-3 ml-auto shrink-0">
        {new Date(entry.created_at).toLocaleTimeString()}
      </span>
    </div>
  );
}

// ── Manual Action Card ──────────────────────────────────────────────────────

function ManualActionCard({ entry }: { entry: StreamEntry }) {
  const [contextOpen, setContextOpen] = useState(false);
  const content = entry.content ?? "";

  let actionTitle = "Manual action required";
  let instructions = "";
  let context: Record<string, unknown> | null = null;
  let resumeHint = "";

  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      actionTitle = parsed.action_title ?? actionTitle;
      instructions = parsed.instructions ?? "";
      context = parsed.context ?? null;
      resumeHint = parsed.resume_hint ?? "";
    }
  } catch {
    // Tool input might be stored differently in metadata
    const meta = entry.metadata as Record<string, unknown> | null;
    if (meta?.tool_input && typeof meta.tool_input === "object") {
      const input = meta.tool_input as Record<string, unknown>;
      actionTitle = (input.action_title as string) ?? actionTitle;
      instructions = (input.instructions as string) ?? "";
      context = (input.context as Record<string, unknown>) ?? null;
      resumeHint = (input.resume_hint as string) ?? "";
    }
  }

  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-100 border-b border-amber-200">
        <Hand className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-sm font-semibold text-amber-800">
          {actionTitle}
        </span>
      </div>

      {instructions && (
        <div className="px-4 py-3">
          <div className="text-sm text-ink leading-relaxed break-words prose prose-sm prose-slate max-w-none [&_pre]:bg-white [&_pre]:p-2 [&_pre]:rounded [&_pre]:border [&_pre]:border-amber-200 [&_pre]:text-xs [&_code]:text-xs [&_code]:bg-white [&_code]:px-1 [&_code]:rounded [&_ol]:pl-5 [&_ul]:pl-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {instructions}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {context && Object.keys(context).length > 0 && (
        <div className="border-t border-amber-200">
          <button
            onClick={() => setContextOpen(!contextOpen)}
            className="w-full flex items-center gap-1.5 px-4 py-2 text-left hover:bg-amber-100/50 transition-colors"
          >
            {contextOpen ? (
              <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />
            )}
            <span className="text-xs font-medium text-amber-700">
              Reference data ({Object.keys(context).length} items)
            </span>
          </button>
          {contextOpen && (
            <div className="px-4 pb-3 space-y-1.5">
              {Object.entries(context).map(([key, val]) => (
                <div key={key} className="flex items-start gap-2 text-xs">
                  <span className="font-mono text-amber-700 shrink-0 font-medium">
                    {key}:
                  </span>
                  <span className="font-mono text-ink break-all flex-1">
                    {typeof val === "string" ? val : JSON.stringify(val)}
                  </span>
                  <SmallCopyButton
                    text={typeof val === "string" ? val : JSON.stringify(val)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {resumeHint && (
        <div className="px-4 py-2 border-t border-amber-200 bg-amber-100/50">
          <p className="text-xs text-amber-700">
            <span className="font-medium">When done:</span> {resumeHint}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Event Pill ───────────────────────────────────────────────────────────────

function StreamEventPill({ entry }: { entry: StreamEntry }) {
  const eventType = entry.sub_type;

  return (
    <div className="flex items-center gap-2 py-0.5 px-2">
      <div
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${eventDotColor(eventType)}`}
      />
      <span className="text-xs text-ink-3">
        {formatEventType(eventType)}
      </span>
      {entry.content &&
        (() => {
          try {
            const payload = JSON.parse(entry.content);
            if (payload && typeof payload === "object") {
              const summary = formatPayload(payload);
              if (summary) {
                return (
                  <span className="text-[9px] text-ink-3/70 font-mono truncate max-w-[200px]">
                    {summary}
                  </span>
                );
              }
            }
          } catch {
            // Not JSON, skip
          }
          return null;
        })()}
      <span className="text-[9px] text-ink-3 ml-auto shrink-0">
        {new Date(entry.created_at).toLocaleTimeString()}
      </span>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function SmallCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="p-0.5 rounded hover:bg-surface transition-colors"
      title="Copy"
    >
      {copied ? (
        <Check className="w-3 h-3 text-green-500" />
      ) : (
        <Copy className="w-3 h-3 text-ink-3" />
      )}
    </button>
  );
}

function formatEventType(eventType: string): string {
  const labels: Record<string, string> = {
    node_started: "Node started",
    node_completed: "Node completed",
    tool_call: "Tool call",
    tool_result: "Tool result",
    critic_start: "Critic started",
    critic_done: "Critic done",
    judge_start: "Judge started",
    judge_done: "Judge verdict",
    judge_pass: "Judge passed",
    judge_fail: "Judge failed",
    judge_reject: "Judge rejected",
    node_retry: "Node retry",
    child_agent_spawned: "Child agent spawned",
    checkpoint_reached: "Checkpoint",
    session_completed: "Session completed",
  };
  return labels[eventType] || eventType.replace(/_/g, " ");
}

function formatPayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (payload.tool) parts.push(`tool=${payload.tool}`);
  if (payload.iteration) parts.push(`iter=${payload.iteration}`);
  if (payload.verdict) parts.push(`verdict=${payload.verdict}`);
  if (payload.score != null) parts.push(`score=${payload.score}`);
  if (payload.status) parts.push(`status=${payload.status}`);
  if (payload.duration_ms != null) parts.push(`${payload.duration_ms}ms`);
  if (payload.passed != null) parts.push(payload.passed ? "passed" : "failed");
  if (payload.feedback)
    parts.push(String(payload.feedback).slice(0, 60) + "\u2026");
  if (!parts.length) return "";
  return parts.join(" \u00B7 ");
}

function eventDotColor(eventType: string): string {
  if (eventType.includes("completed") || eventType.includes("pass"))
    return "bg-green-500";
  if (
    eventType.includes("fail") ||
    eventType.includes("reject") ||
    eventType.includes("retry")
  )
    return "bg-red-500";
  if (eventType.includes("judge")) return "bg-purple-500";
  if (eventType.includes("critic")) return "bg-amber-500";
  if (eventType.includes("tool")) return "bg-cyan-500";
  if (eventType.includes("spawn")) return "bg-indigo-400";
  if (eventType.includes("started")) return "bg-blue-500";
  return "bg-gray-400";
}
