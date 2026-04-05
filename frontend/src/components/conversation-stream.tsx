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
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
  FileText,
  AlertTriangle,
  Table2,
  ListOrdered,
  ExternalLink,
  X,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
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
                    selectedNode.status === "ready" ||
                    selectedNode.status === "preview"
                  ? "Ask questions or give more details before approving the plan."
                  : "No activity yet."}
            </p>
          </div>
        ) : (
          <>
            {entries.map((entry, i) => {
              if (entry.stream_type === "event") return null;

              const meta = entry.metadata as Record<string, unknown> | null;
              const phase = meta?.phase as string | undefined;

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
                  if (phase === "enrichment_request" || phase === "enrichment_response") {
                    return null;
                  }

                  if (phase === "step_result") {
                    return (
                      <OrchestratorStepCard
                        key={entry.id ?? `m-${i}`}
                        entry={entry}
                      />
                    );
                  }

                  if (phase === "synthesis") {
                    return (
                      <SynthesisMessage
                        key={entry.id ?? `m-${i}`}
                        entry={entry}
                      />
                    );
                  }

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

      {/* Reply input */}
      {onReply && (
        <div className="border-t border-rim px-4 py-3 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                selectedNode.status === "pending" || selectedNode.status === "ready" || selectedNode.status === "preview"
                  ? "Ask a question or refine the plan..."
                  : "Send a message..."
              }
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

// ── Manual Action Card (progressive disclosure) ────────────────────────────

interface ActionSection {
  type: "overview" | "table_spec" | "steps" | "warnings" | "reference";
  title: string;
  content?: string;
  summary?: string;
  columns?: { name: string; type: string; purpose: string; detail?: string }[];
  steps?: { step: number; label: string; detail?: string }[];
  items?: string[];
  entries?: Record<string, unknown>;
}

interface ParsedAction {
  actionTitle: string;
  summary: string;
  sections: ActionSection[];
  context: Record<string, unknown> | null;
  resumeHint: string;
}

function parseActionEntry(entry: StreamEntry): ParsedAction {
  const content = entry.content ?? "";
  const fallback: ParsedAction = {
    actionTitle: "Manual action required",
    summary: "",
    sections: [],
    context: null,
    resumeHint: "",
  };

  let source: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") source = parsed;
  } catch {
    const meta = entry.metadata as Record<string, unknown> | null;
    if (meta?.tool_input && typeof meta.tool_input === "object") {
      source = meta.tool_input as Record<string, unknown>;
    }
  }

  if (!source) return fallback;

  return {
    actionTitle: (source.action_title as string) ?? fallback.actionTitle,
    summary: (source.summary as string) ?? "",
    sections: (source.sections as ActionSection[]) ?? [],
    context: (source.context as Record<string, unknown>) ?? null,
    resumeHint: (source.resume_hint as string) ?? "",
  };
}

function ManualActionCard({ entry }: { entry: StreamEntry }) {
  const { actionTitle, summary, sections, context, resumeHint } =
    parseActionEntry(entry);

  return (
    <div className="mx-4 rounded-xl border-2 border-amber-300 bg-amber-50 overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-100 border-b border-amber-200">
        <Hand className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <span className="text-sm font-semibold text-amber-800 block">
            {actionTitle}
          </span>
          {summary && (
            <span className="text-xs text-amber-700 block mt-0.5">
              {summary}
            </span>
          )}
        </div>
      </div>

      {/* Sections */}
      {sections.map((section, i) => (
        <ActionSectionRenderer key={i} section={section} />
      ))}

      {/* Context (legacy/extra structured data) */}
      {context && Object.keys(context).length > 0 && (
        <CollapsibleReferenceEntries
          title={`Reference data (${Object.keys(context).length} items)`}
          entries={context}
        />
      )}

      {/* Resume hint */}
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

function ActionSectionRenderer({ section }: { section: ActionSection }) {
  switch (section.type) {
    case "overview":
      return <SectionOverview section={section} />;
    case "table_spec":
      return <SectionTableSpec section={section} />;
    case "steps":
      return <SectionSteps section={section} />;
    case "warnings":
      return <SectionWarnings section={section} />;
    case "reference":
      return (
        <CollapsibleReferenceEntries
          title={section.title}
          entries={section.entries ?? {}}
        />
      );
    default:
      return null;
  }
}

// -- Overview: always visible prose
function SectionOverview({ section }: { section: ActionSection }) {
  if (!section.content) return null;
  return (
    <div className="px-4 py-2.5 border-t border-amber-200">
      <p className="text-[13px] text-ink leading-relaxed">{section.content}</p>
    </div>
  );
}

// -- Table spec: collapsed grid with expandable column detail
function SectionTableSpec({ section }: { section: ActionSection }) {
  const [open, setOpen] = useState(false);
  const columns = section.columns ?? [];
  if (columns.length === 0) return null;

  return (
    <div className="border-t border-amber-200">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-4 py-2 text-left hover:bg-amber-100/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />
        )}
        <Table2 className="w-3 h-3 text-amber-600 shrink-0" />
        <span className="text-xs font-medium text-amber-800 truncate">
          {section.title}
        </span>
        <span className="text-[10px] text-amber-600 shrink-0 ml-auto">
          {columns.length} columns
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          <div className="rounded-lg border border-amber-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-amber-100/70">
                  <th className="text-left px-2.5 py-1.5 font-medium text-amber-800">Column</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-amber-800">Type</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-amber-800">Purpose</th>
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {columns.map((col, i) => (
                  <ColumnRow key={i} col={col} />
                ))}
              </tbody>
            </table>
          </div>
          {section.summary && (
            <p className="text-[10px] text-amber-600 mt-1.5 px-0.5">
              {section.summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnRow({
  col,
}: {
  col: { name: string; type: string; purpose: string; detail?: string };
}) {
  return (
    <tr className="border-t border-amber-100 hover:bg-amber-50/50">
      <td className="px-2.5 py-1.5 font-mono font-medium text-ink">
        {col.name}
      </td>
      <td className="px-2.5 py-1.5">
        <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-medium">
          {col.type}
        </span>
      </td>
      <td className="px-2.5 py-1.5 text-ink-2">{col.purpose}</td>
      <td className="px-1.5 py-1.5">
        {col.detail && <DetailDialog title={col.name} detail={col.detail} />}
      </td>
    </tr>
  );
}

// -- Steps: collapsed numbered list with expandable detail per step
function SectionSteps({ section }: { section: ActionSection }) {
  const [open, setOpen] = useState(false);
  const steps = section.steps ?? [];
  if (steps.length === 0) return null;

  return (
    <div className="border-t border-amber-200">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-4 py-2 text-left hover:bg-amber-100/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />
        )}
        <ListOrdered className="w-3 h-3 text-amber-600 shrink-0" />
        <span className="text-xs font-medium text-amber-800 truncate">
          {section.title}
        </span>
        <span className="text-[10px] text-amber-600 shrink-0 ml-auto">
          {steps.length} steps
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-1">
          {steps.map((s) => (
            <StepRow key={s.step} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({
  step,
}: {
  step: { step: number; label: string; detail?: string };
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-amber-100 overflow-hidden">
      <button
        onClick={() => step.detail && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
          step.detail
            ? "hover:bg-amber-50/50 cursor-pointer"
            : "cursor-default"
        }`}
      >
        <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-[10px] font-semibold shrink-0">
          {step.step}
        </span>
        <span className="text-ink flex-1">{step.label}</span>
        {step.detail && (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-amber-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-amber-400 shrink-0" />
          )
        )}
      </button>
      {expanded && step.detail && (
        <div className="px-2.5 pb-2 pl-[38px]">
          <p className="text-[11px] text-ink-2 leading-relaxed whitespace-pre-wrap">
            {step.detail}
          </p>
        </div>
      )}
    </div>
  );
}

// -- Warnings: always visible amber bullets
function SectionWarnings({ section }: { section: ActionSection }) {
  const items = section.items ?? [];
  if (items.length === 0) return null;

  return (
    <div className="px-4 py-2.5 border-t border-amber-200">
      <div className="flex items-center gap-1.5 mb-1.5">
        <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
        <span className="text-xs font-medium text-amber-800">
          {section.title}
        </span>
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-[11px] text-amber-700 leading-relaxed flex items-start gap-1.5">
            <span className="text-amber-400 shrink-0 mt-1">&#x2022;</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// -- Reference: collapsible key-value pairs
function CollapsibleReferenceEntries({
  title,
  entries,
}: {
  title: string;
  entries: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(entries);
  if (keys.length === 0) return null;

  return (
    <div className="border-t border-amber-200">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-4 py-2 text-left hover:bg-amber-100/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />
        )}
        <ExternalLink className="w-3 h-3 text-amber-600 shrink-0" />
        <span className="text-xs font-medium text-amber-700">{title}</span>
        <span className="text-[10px] text-amber-600 shrink-0 ml-auto">
          {keys.length} items
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-1.5">
          {Object.entries(entries).map(([key, val]) => (
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
  );
}

// -- Detail dialog (for column detail, long content)
function DetailDialog({ title, detail }: { title: string; detail: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          className="p-0.5 rounded hover:bg-amber-100 transition-colors"
          title="View detail"
        >
          <ExternalLink className="w-3 h-3 text-amber-500" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[90vw] max-w-lg max-h-[80vh] bg-white rounded-xl shadow-xl border border-amber-200 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-100 bg-amber-50">
            <Dialog.Title className="text-sm font-semibold text-amber-800">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="p-1 rounded hover:bg-amber-100 transition-colors">
                <X className="w-4 h-4 text-amber-600" />
              </button>
            </Dialog.Close>
          </div>
          <div className="p-4 overflow-y-auto flex-1">
            <pre className="text-xs font-mono text-ink-2 whitespace-pre-wrap break-words leading-relaxed">
              {detail}
            </pre>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Orchestrator Step Card ───────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string; bg: string; border: string }> = {
  passed: {
    icon: <CircleCheck className="w-3 h-3" />,
    label: "Passed",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
  },
  failed: {
    icon: <CircleX className="w-3 h-3" />,
    label: "Failed",
    color: "text-red-700",
    bg: "bg-red-50",
    border: "border-red-200",
  },
  awaiting_reply: {
    icon: <Clock className="w-3 h-3" />,
    label: "Awaiting Reply",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
  },
  running: {
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
    label: "Running",
    color: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-200",
  },
};

function parseStepResult(content: string, meta: Record<string, unknown> | null): {
  agentSlug: string;
  status: string;
  durationMs: number | null;
  summary: string;
  error: string | null;
  rawJson: string | null;
} {
  const rawOutput = meta?.raw_output as Record<string, unknown> | undefined;

  if (rawOutput) {
    return {
      agentSlug: (rawOutput.agent_slug as string) ?? (meta?.agent_slug as string) ?? "agent",
      status: (rawOutput.status as string) ?? (meta?.status as string) ?? "unknown",
      durationMs: (rawOutput.duration_ms as number) ?? null,
      summary: (rawOutput.summary as string) ?? content,
      error: (rawOutput.error as string) ?? null,
      rawJson: JSON.stringify(rawOutput, null, 2),
    };
  }

  // Legacy: parse from content (old messages without structured metadata)
  try {
    const parsed = JSON.parse(content.replace(/^Step \d+ \([^)]+\) completed with status: \w+\.\s*\n*Result:\n?/, ""));
    return {
      agentSlug: (parsed.agent_slug as string) ?? "agent",
      status: (parsed.status as string) ?? "unknown",
      durationMs: (parsed.duration_ms as number) ?? null,
      summary: (parsed.summary as string) ?? "",
      error: (parsed.error as string) ?? null,
      rawJson: JSON.stringify(parsed, null, 2),
    };
  } catch {
    // Fallback: try to extract from the "Step N (slug) completed..." format
    const headerMatch = content.match(/^Step \d+ \(([^)]+)\) completed with status: (\w+)/);
    const jsonStart = content.indexOf("{");
    let rawJson: string | null = null;
    let parsed: Record<string, unknown> | null = null;
    if (jsonStart >= 0) {
      rawJson = content.slice(jsonStart);
      try { parsed = JSON.parse(rawJson); } catch { /* ignore */ }
    }
    return {
      agentSlug: headerMatch?.[1] ?? (parsed?.agent_slug as string) ?? "agent",
      status: headerMatch?.[2] ?? (parsed?.status as string) ?? "unknown",
      durationMs: (parsed?.duration_ms as number) ?? null,
      summary: (parsed?.summary as string) ?? "",
      error: (parsed?.error as string) ?? null,
      rawJson,
    };
  }
}

function OrchestratorStepCard({ entry }: { entry: StreamEntry }) {
  const [expanded, setExpanded] = useState(false);
  const content = entry.content ?? "";
  const meta = entry.metadata as Record<string, unknown> | null;

  const { agentSlug, status, durationMs, summary, error, rawJson } = parseStepResult(content, meta);
  const config = STATUS_CONFIG[status] ?? {
    icon: <FileText className="w-3 h-3" />,
    label: status,
    color: "text-ink-2",
    bg: "bg-surface",
    border: "border-rim",
  };

  const durationLabel = durationMs != null
    ? durationMs >= 60000
      ? `${(durationMs / 60000).toFixed(1)}m`
      : `${(durationMs / 1000).toFixed(1)}s`
    : null;

  return (
    <div className="mx-4 my-1.5">
      <div className={`rounded-lg border ${config.border} ${config.bg} overflow-hidden`}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80 transition-opacity"
        >
          <span className={`shrink-0 ${config.color}`}>{config.icon}</span>
          <span className="text-xs font-semibold text-ink truncate">
            {agentSlug.replace(/_/g, " ")}
          </span>
          <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${config.bg} ${config.color} border ${config.border}`}>
            {config.label}
          </span>
          {durationLabel && (
            <span className="text-[10px] text-ink-3 tabular-nums">{durationLabel}</span>
          )}
          <span className="ml-auto shrink-0">
            {expanded ? (
              <ChevronDown className="w-3 h-3 text-ink-3" />
            ) : (
              <ChevronRight className="w-3 h-3 text-ink-3" />
            )}
          </span>
        </button>

        {summary && (
          <div className="px-3 pb-2 -mt-0.5">
            <p className="text-[11px] text-ink-2 leading-relaxed line-clamp-2">{summary}</p>
          </div>
        )}

        {error && (
          <div className="px-3 pb-2">
            <p className="text-[11px] text-red-600 leading-relaxed line-clamp-2">{error}</p>
          </div>
        )}

        {expanded && rawJson && (
          <div className="border-t border-inherit px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-medium text-ink-3 uppercase tracking-wider">Raw Output</span>
              <SmallCopyButton text={rawJson} />
            </div>
            <pre className="text-[10px] font-mono text-ink-2 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto leading-relaxed">
              {rawJson}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Synthesis Message ────────────────────────────────────────────────────────

function parseSynthesisContent(content: string, meta: Record<string, unknown> | null): {
  summary: string;
  rawJson: string | null;
} {
  const metaSummary = meta?.summary as string | undefined;
  const metaRawOutput = meta?.raw_output;

  if (metaSummary) {
    return {
      summary: metaSummary,
      rawJson: metaRawOutput ? JSON.stringify(metaRawOutput, null, 2) : content,
    };
  }

  // Legacy: try to parse the content as JSON to extract summary
  const cleaned = content.trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary: parsed.summary ?? "Plan execution complete.",
      rawJson: JSON.stringify(parsed, null, 2),
    };
  } catch {
    // Not JSON - treat as markdown summary directly
    return { summary: content, rawJson: null };
  }
}

function SynthesisMessage({ entry }: { entry: StreamEntry }) {
  const [showRaw, setShowRaw] = useState(false);
  const content = entry.content ?? "";
  const meta = entry.metadata as Record<string, unknown> | null;

  const { summary, rawJson } = parseSynthesisContent(content, meta);

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Bot className="w-3.5 h-3.5 text-ink-2 shrink-0" />
        <span className="text-xs font-semibold text-ink-2">Plan Summary</span>
      </div>
      <div className="text-[13px] text-ink leading-relaxed prose prose-sm max-w-none prose-pre:bg-surface prose-pre:border prose-pre:border-rim prose-pre:rounded-lg prose-pre:p-3 prose-pre:text-xs prose-pre:text-ink-2 prose-code:text-[12px] prose-code:bg-surface prose-code:text-ink-2 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-headings:text-ink prose-headings:font-semibold prose-p:my-2 prose-li:my-0.5 prose-a:text-brand prose-a:no-underline hover:prose-a:underline">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
      </div>

      {rawJson && (
        <div className="mt-2">
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="flex items-center gap-1.5 text-[11px] text-ink-3 hover:text-ink-2 transition-colors"
          >
            {showRaw ? (
              <ChevronDown className="w-3 h-3 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 shrink-0" />
            )}
            <span>View full output</span>
          </button>
          {showRaw && (
            <div className="mt-1.5 bg-surface border border-rim rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-medium text-ink-3 uppercase tracking-wider">Full JSON</span>
                <SmallCopyButton text={rawJson} />
              </div>
              <pre className="text-[10px] font-mono text-ink-2 whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto leading-relaxed">
                {rawJson}
              </pre>
            </div>
          )}
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
