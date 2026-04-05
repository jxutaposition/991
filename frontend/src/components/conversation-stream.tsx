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
    <span className="inline-block w-0.5 h-[1.1em] bg-brand animate-pulse ml-px align-text-bottom" />
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2 space-y-1">
        {loading ? (
          <p className="text-sm text-ink-3 px-4 py-4">Loading conversation...</p>
        ) : entries.length === 0 && !hasLiveContent ? (
          <div className="text-center py-12 px-4">
            <p className="text-sm text-ink-3">
              {selectedNode.status === "running"
                ? "Waiting for agent output..."
                : selectedNode.status === "pending" ||
                    selectedNode.status === "ready"
                  ? "Chat will appear once execution starts."
                  : "No activity yet."}
            </p>
          </div>
        ) : (
          <>
            {entries.map((entry, i) => {
              if (entry.stream_type === "event") return null;

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
                    <StreamChatMessage
                      key={entry.id ?? `m-${i}`}
                      entry={entry}
                      isStreaming={false}
                    />
                  );
                default:
                  return null;
              }
            })}

            {/* Live thinking chunks */}
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

            {/* Live text chunks */}
            {Object.entries(liveTextChunks)
              .filter(
                ([blockIdx]) =>
                  Number(blockIdx) >= finalizedAssistantCount
              )
              .map(([blockIdx, text]) => (
                <StreamChatMessage
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
            <div className="flex items-center gap-2 px-4 py-2">
              <div className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse" />
              <span className="text-sm text-ink-3">Agent is working...</span>
            </div>
          )}
        {selectedNode.status === "awaiting_reply" && (
          <div className="flex items-center gap-2 mx-4 px-3 py-2 bg-amber-50 rounded-lg border border-amber-200">
            <MessageCircle className="w-3.5 h-3.5 text-amber-600" />
            <span className="text-xs text-amber-700">
              Agent is waiting for your reply
            </span>
          </div>
        )}
      </div>

      {/* Reply input -- always visible */}
      {onReply && (
        <div className="border-t border-rim px-4 py-3 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Send a message..."
              className="flex-1 text-sm text-ink border border-rim rounded-lg px-3 py-2 leading-relaxed resize-none min-h-[40px] max-h-[120px] focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand bg-surface"
              rows={1}
              disabled={sending}
            />
            <button
              onClick={handleSend}
              disabled={!replyText.trim() || sending}
              className="shrink-0 p-2.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-40 transition-colors"
              title="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Thinking Block (minimal, Cursor-style) ──────────────────────────────────

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

  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  return (
    <div className="mx-4 my-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2 py-1 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
        <Brain className="w-3 h-3 shrink-0" />
        <span>Thinking{isStreaming ? "..." : ""}</span>
      </button>
      {open && (
        <div className="ml-[22px] pb-1">
          <pre className="text-xs font-mono text-ink-3 whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto">
            {text}
            {isStreaming && <StreamingCursor />}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Chat Message (full-width, no bubbles) ───────────────────────────────────

function StreamChatMessage({
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

  return (
    <div className={`px-4 py-3 ${isUser ? "bg-surface/50" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        {isUser ? (
          <User className="w-3.5 h-3.5 text-brand shrink-0" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-ink-2 shrink-0" />
        )}
        <span className="text-xs font-semibold text-ink-2">
          {isUser ? (isHumanReply ? "You" : "System") : "Assistant"}
        </span>
      </div>
      {!isUser && !isStreaming ? (
        <div className="text-[13px] text-ink leading-relaxed prose prose-sm max-w-none prose-pre:bg-surface prose-pre:border prose-pre:border-rim prose-pre:rounded-lg prose-pre:p-3 prose-pre:text-xs prose-pre:text-ink-2 prose-code:text-[12px] prose-code:bg-surface prose-code:text-ink-2 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-headings:text-ink prose-headings:font-semibold prose-p:my-2 prose-li:my-0.5 prose-a:text-brand prose-a:no-underline hover:prose-a:underline">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-[13px] text-ink whitespace-pre-wrap leading-relaxed">
          {content}
          {isStreaming && <StreamingCursor />}
        </p>
      )}
    </div>
  );
}

// ── Tool Call (compact, expandable) ─────────────────────────────────────────

function StreamToolCall({ entry }: { entry: StreamEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isResult = entry.sub_type === "tool_result";
  const toolName =
    ((entry.metadata as Record<string, unknown>)?.tool_name as string) ||
    entry.content ||
    "tool";
  const content = entry.content ?? "";

  if (isResult && !content) return null;

  return (
    <div className="mx-4 py-0.5">
      <button
        onClick={() => isResult && content ? setExpanded(!expanded) : undefined}
        className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2 transition-colors"
      >
        <Wrench className="w-3 h-3 text-cyan-500 shrink-0" />
        <span className="font-mono">
          {isResult ? `${toolName} \u2192 result` : `${toolName}()`}
        </span>
        {isResult && content && (
          expanded ? (
            <ChevronDown className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0" />
          )
        )}
      </button>
      {expanded && isResult && content && (
        <div className="ml-[22px] mt-1 bg-gray-50 rounded p-2 max-h-[120px] overflow-y-auto">
          <pre className="text-[11px] font-mono text-ink-2 whitespace-pre-wrap break-all">
            {content.slice(0, 1000)}
            {content.length > 1000 ? "..." : ""}
          </pre>
        </div>
      )}
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
    <div className="mx-4 rounded-xl border-2 border-amber-300 bg-amber-50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-100 border-b border-amber-200">
        <Hand className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-sm font-semibold text-amber-800">
          {actionTitle}
        </span>
      </div>

      {instructions && (
        <div className="px-4 py-3">
          <div className="text-sm text-ink leading-relaxed prose prose-sm max-w-none prose-pre:bg-white prose-pre:p-2 prose-pre:rounded prose-pre:border prose-pre:border-amber-200 prose-pre:text-xs prose-code:text-xs prose-code:bg-white prose-code:px-1 prose-code:rounded prose-ol:pl-5 prose-ul:pl-5">
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
