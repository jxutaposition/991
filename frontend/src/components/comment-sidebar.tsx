"use client";

import { useState, useCallback } from "react";
import { MessageSquare, Check, Send, Loader2 } from "lucide-react";

export interface CommentThread {
  id: string;
  session_id?: string;
  node_id?: string;
  section_path: string;
  highlighted_text?: string | null;
  status: "open" | "resolved" | "archived";
  message_count?: number;
  created_at: string;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  description_patch?: unknown;
  created_at: string;
}

interface CommentSidebarProps {
  threads: CommentThread[];
  sessionId: string;
  /** When set, session/thread routes require this workspace (matches other execute API calls). */
  clientSlug?: string | null;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onThreadCreated?: () => void;
}

export function CommentSidebar({
  threads,
  sessionId,
  clientSlug,
  apiFetch,
  onThreadCreated,
}: CommentSidebarProps) {
  const clientQs = clientSlug
    ? `?client_slug=${encodeURIComponent(clientSlug)}`
    : "";
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<Record<string, ThreadMessage[]>>({});
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [loadingThreads, setLoadingThreads] = useState<Record<string, boolean>>({});

  const fetchThreadMessages = useCallback(async (threadId: string) => {
    setLoadingThreads((prev) => ({ ...prev, [threadId]: true }));
    try {
      const r = await apiFetch(`/api/execute/${sessionId}/threads/${threadId}${clientQs}`);
      if (r.ok) {
        const data = await r.json();
        setThreadMessages((prev) => ({ ...prev, [threadId]: data.messages ?? [] }));
      }
    } catch { /* transient */ } finally {
      setLoadingThreads((prev) => ({ ...prev, [threadId]: false }));
    }
  }, [sessionId, apiFetch, clientQs]);

  const toggleThread = (threadId: string) => {
    const willExpand = expandedThread !== threadId;
    setExpandedThread(willExpand ? threadId : null);
    if (willExpand && !threadMessages[threadId]) {
      fetchThreadMessages(threadId);
    }
  };

  const sendReply = useCallback(async (threadId: string) => {
    const text = replyInputs[threadId]?.trim();
    if (!text) return;

    setLoadingThreads((prev) => ({ ...prev, [threadId]: true }));
    try {
      const r = await apiFetch(`/api/execute/${sessionId}/threads/${threadId}/messages${clientQs}`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      if (r.ok) {
        setReplyInputs((prev) => ({ ...prev, [threadId]: "" }));
        await fetchThreadMessages(threadId);
      }
    } catch { /* transient */ } finally {
      setLoadingThreads((prev) => ({ ...prev, [threadId]: false }));
    }
  }, [sessionId, apiFetch, clientQs, replyInputs, fetchThreadMessages]);

  const resolveThread = useCallback(async (threadId: string) => {
    await apiFetch(`/api/execute/${sessionId}/threads/${threadId}${clientQs}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    });
    onThreadCreated?.();
  }, [sessionId, apiFetch, clientQs, onThreadCreated]);

  const openThreads = threads.filter((t) => t.status === "open");
  const resolvedThreads = threads.filter((t) => t.status !== "open");

  if (threads.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <MessageSquare className="w-5 h-5 text-ink-3 mx-auto mb-2" />
        <p className="text-xs text-ink-3">No comments yet. Select text in the description to start a discussion.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-3 py-3">
      {openThreads.map((thread) => (
        <div key={thread.id} className="border border-rim rounded-lg overflow-hidden">
          <button
            onClick={() => toggleThread(thread.id)}
            className="w-full flex items-start gap-2 px-3 py-2 bg-surface hover:bg-gray-50 text-left"
          >
            <MessageSquare className="w-3 h-3 text-brand mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-xs font-mono text-ink-3">{thread.section_path}</span>
              {thread.highlighted_text ? (
                <p className="text-xs text-ink truncate mt-0.5">&ldquo;{thread.highlighted_text}&rdquo;</p>
              ) : null}
            </div>
          </button>

          {expandedThread === thread.id ? (
            <div className="border-t border-rim px-3 py-2 space-y-2">
              {/* Messages */}
              {(threadMessages[thread.id] ?? []).map((msg) => (
                <div
                  key={msg.id}
                  className={`text-xs px-2 py-1.5 rounded ${
                    msg.role === "user" ? "bg-blue-50 text-blue-800" : "bg-gray-50 text-ink"
                  }`}
                >
                  <span className="font-medium text-xs uppercase">{msg.role}</span>
                  <p className="mt-0.5 whitespace-pre-wrap">{msg.content}</p>
                </div>
              ))}

              {/* Reply input */}
              <div className="flex gap-1.5">
                <input
                  value={replyInputs[thread.id] ?? ""}
                  onChange={(e) => setReplyInputs((prev) => ({ ...prev, [thread.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendReply(thread.id)}
                  placeholder="Reply..."
                  className="flex-1 text-xs border border-rim rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand"
                  disabled={loadingThreads[thread.id]}
                />
                <button
                  onClick={() => sendReply(thread.id)}
                  disabled={loadingThreads[thread.id]}
                  className="p-1 rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-40"
                  aria-label="Send reply"
                >
                  {loadingThreads[thread.id] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => resolveThread(thread.id)}
                  className="p-1 rounded text-green-600 hover:bg-green-50"
                  title="Resolve"
                  aria-label="Resolve thread"
                >
                  <Check className="w-3 h-3" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}

      {resolvedThreads.length > 0 ? (
        <div className="mt-3">
          <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
            Resolved ({resolvedThreads.length})
          </span>
          {resolvedThreads.map((thread) => (
            <div key={thread.id} className="flex items-center gap-2 text-xs text-ink-3 mt-1">
              <Check className="w-3 h-3 text-green-500" />
              <span className="font-mono">{thread.section_path}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
