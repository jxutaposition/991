"use client";

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  Activity,
  Brain,
  Clock,
  CheckCircle2,
  XCircle,
  SkipForward,
  Play,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  KeyRound,
  Lock,
  LockOpen,
  ExternalLink,
  Pencil,
  Save,
  MessageCircle,
  Send,
  User,
  Bot,
  Wrench,
} from "lucide-react";
import { IntegrationIcon } from "@/components/integration-icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ExecutionNode } from "./execution-canvas";
import { EventDetailsPopup } from "./event-details-popup";
import { ConversationStream, type StreamEntry } from "./conversation-stream";

export interface ExecutionEvent {
  id: string;
  node_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface ToolCredentialInfo {
  name: string;
  credential: string | null;
  credential_status?: "connected" | "missing" | "not_required";
  display_name?: string;
  icon?: string;
}

interface SetupStep {
  label: string;
  help?: string;
  doc_url?: string;
  required?: boolean;
}

interface IntegrationDetail {
  slug: string;
  display_name: string;
  icon: string;
  status: "connected" | "missing";
  setup_steps?: SetupStep[];
}

interface AgentCredentialInfo {
  tools: ToolCredentialInfo[];
  required_integrations: string[];
  integration_details?: IntegrationDetail[];
  missing: string[];
  status: "ready" | "blocked" | "no_tools";
}

interface ProbeResultEntry {
  status: string;
  ok: boolean;
  http_status?: number;
  error?: string;
  hint?: string;
  latency_ms?: number;
}

interface CredentialStatus {
  agents: Record<string, AgentCredentialInfo>;
  connected: string[];
  probe_results?: Record<string, ProbeResultEntry>;
}

interface CatalogAgent {
  slug: string;
  name: string;
  category: string;
  description: string;
  tools: Array<{ name: string; credential: string | null }>;
  required_integrations: string[];
}

export interface ThinkingBlock {
  id: string;
  node_id: string;
  iteration: number;
  thinking_text: string;
  token_count: number | null;
  created_at: string;
}

export interface NodeMessage {
  id: string;
  node_id: string;
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface InspectorPanelProps {
  selectedNode: ExecutionNode | null;
  nodeEvents: ExecutionEvent[];
  nodeEventsLoading: boolean;
  allNodes: ExecutionNode[];
  credentialStatus?: CredentialStatus | null;
  catalogMap?: Record<string, CatalogAgent>;
  sessionStatus?: string;
  onNodeUpdate?: (nodeId: string, patch: Record<string, unknown>) => Promise<void>;
  thinkingBlocks?: ThinkingBlock[];
  thinkingBlocksLoading?: boolean;
  liveThinkingChunks?: Record<string, string>;
  nodeMessages?: NodeMessage[];
  nodeMessagesLoading?: boolean;
  onReply?: (nodeId: string, message: string) => Promise<void>;
  streamEntries?: StreamEntry[];
  streamLoading?: boolean;
  liveTextChunks?: Record<string, string>;
  failures?: ExecutionNode[];
  onNodeSelect?: (id: string) => void;
}

const INTERNAL_TOOLS = ["read_upstream_output", "write_output", "spawn_agent"];

function NodeDetailContent({
  selectedNode,
  allNodes,
  credentialStatus,
  catalogMap,
  sessionStatus,
  onNodeUpdate,
}: {
  selectedNode: ExecutionNode;
  allNodes: ExecutionNode[];
  credentialStatus?: CredentialStatus | null;
  catalogMap?: Record<string, CatalogAgent>;
  sessionStatus?: string;
  onNodeUpdate?: (nodeId: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const isEditable = sessionStatus === "awaiting_approval" && !!onNodeUpdate;
  const [editingTask, setEditingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState(selectedNode.task_description);
  const [saving, setSaving] = useState(false);

  const catalogAgent = catalogMap?.[selectedNode.agent_slug];
  const credInfo = credentialStatus?.agents[selectedNode.agent_slug];

  // Tools from catalog (user-facing only)
  const catalogTools = catalogAgent?.tools?.filter(
    (t) => !INTERNAL_TOOLS.includes(t.name)
  ) ?? [];

  // Tools from credential check (has auth status)
  const credTools = (credInfo?.tools ?? []).filter(
    (t) => !INTERNAL_TOOLS.includes(t.name)
  );

  const hasIntegrations = (credInfo?.required_integrations?.length ?? 0) > 0;
  const probes = credentialStatus?.probe_results;
  const agentProbeFailures = hasIntegrations && probes
    ? credInfo!.required_integrations.filter((s) => probes[s] && !probes[s].ok)
    : [];
  const hasProbeIssues = agentProbeFailures.length > 0;
  const isBlocked = credInfo?.status === "blocked" || hasProbeIssues;
  const hasSetupSteps = (credInfo?.integration_details ?? []).some(
    (d) => d.status === "connected" && d.setup_steps && d.setup_steps.some((s) => s.required)
  );

  const handleSaveTask = useCallback(async () => {
    if (!onNodeUpdate || taskDraft === selectedNode.task_description) {
      setEditingTask(false);
      return;
    }
    setSaving(true);
    await onNodeUpdate(selectedNode.id, { task_description: taskDraft });
    setSaving(false);
    setEditingTask(false);
  }, [onNodeUpdate, taskDraft, selectedNode.id, selectedNode.task_description]);

  const handleSaveField = useCallback(async (field: string, value: unknown) => {
    if (!onNodeUpdate) return;
    setSaving(true);
    await onNodeUpdate(selectedNode.id, { [field]: value });
    setSaving(false);
  }, [onNodeUpdate, selectedNode.id]);

  return (
    <div className="p-4 space-y-5">
      {/* Header: name + status + category */}
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink truncate">
            {selectedNode.agent_slug}
          </h3>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded capitalize shrink-0 ${statusBadgeClass(selectedNode.status)}`}
          >
            {selectedNode.status}
          </span>
          {isBlocked && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 flex items-center gap-0.5 shrink-0">
              <Lock className="w-2.5 h-2.5" /> blocked
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <CopyableId id={selectedNode.id} />
          {catalogAgent && (
            <span className="text-[10px] text-ink-3 bg-gray-100 px-1.5 py-0.5 rounded">
              {catalogAgent.category.replace(/_/g, " ")}
            </span>
          )}
        </div>
      </div>

      {/* Agent Swap — editable: pick a different agent for this step */}
      {isEditable && catalogMap && (
        <CollapsibleSection title="Change Agent" defaultOpen={false}>
          <div className="space-y-2">
            <p className="text-[10px] text-ink-3">
              Swap this step to use a different agent from the catalog.
            </p>
            <AgentSwapSelector
              currentSlug={selectedNode.agent_slug}
              catalogMap={catalogMap}
              currentCategory={catalogAgent?.category}
              onSelect={(slug) => handleSaveField("agent_slug", slug)}
            />
          </div>
        </CollapsibleSection>
      )}

      {/* Auth Status Banner */}
      {credInfo && (
        <div className={`flex flex-col gap-1.5 px-3 py-2 rounded-lg text-xs ${
          hasProbeIssues
            ? "bg-red-50 border border-red-200 text-red-800"
            : isBlocked
              ? "bg-amber-50 border border-amber-200 text-amber-800"
              : hasIntegrations && hasSetupSteps
                ? "bg-orange-50 border border-orange-200 text-orange-800"
                : hasIntegrations
                  ? "bg-green-50 border border-green-200 text-green-800"
                  : "bg-gray-50 border border-rim text-ink-3"
        }`}>
          <div className="flex items-center gap-2">
            {hasProbeIssues ? (
              <>
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span>Credential issues found:</span>
              </>
            ) : isBlocked ? (
              <>
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span>Missing credentials: <strong>{credInfo.missing.join(", ")}</strong></span>
                <a
                  href={`/settings/integrations#${credInfo.missing[0]}`}
                  className="ml-auto text-brand hover:underline flex items-center gap-0.5"
                >
                  Configure <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </>
            ) : hasIntegrations && hasSetupSteps ? (
              <>
                <LockOpen className="w-3.5 h-3.5 shrink-0" />
                <span>Credentials connected — <strong className="text-amber-700">extra setup needed</strong></span>
              </>
            ) : hasIntegrations ? (
              <>
                <LockOpen className="w-3.5 h-3.5 shrink-0" />
                <span>All credentials verified</span>
              </>
            ) : (
              <span>No external auth required</span>
            )}
          </div>
          {hasProbeIssues && agentProbeFailures.map((slug) => {
            const p = probes![slug];
            const statusLabels: Record<string, string> = {
              auth_failed: "Auth failed",
              endpoint_not_found: "Endpoint not found",
              server_error: "Service down",
              client_error: "Request error",
              network_error: "Unreachable",
              config_missing: "Config missing",
              missing: "Not configured",
            };
            return (
              <div key={slug} className="flex items-start gap-1.5 text-[10px] pl-5">
                <span className="font-medium shrink-0">{slug}</span>
                <span className="px-1 py-0.5 rounded bg-red-100 text-red-700 font-medium shrink-0">
                  {statusLabels[p.status] ?? p.status}
                </span>
                {p.error && <span className="text-red-600">{p.error}</span>}
                {p.hint && (
                  <a
                    href="/settings/integrations"
                    className="ml-auto text-brand hover:underline flex items-center gap-0.5 shrink-0"
                  >
                    Fix <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Timing bar */}
      <TimingSection node={selectedNode} />

      {/* Judge Evaluation */}
      <JudgeSection node={selectedNode} />

      {/* Task Description — editable */}
      {selectedNode.task_description && (
        <CollapsibleSection title="Task" defaultOpen={true}>
          {isEditable && editingTask ? (
            <div className="space-y-2">
              <textarea
                value={taskDraft}
                onChange={(e) => setTaskDraft(e.target.value)}
                className="w-full text-xs text-ink border border-rim rounded-lg p-2 leading-relaxed resize-y min-h-[80px] focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand"
                rows={4}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveTask}
                  disabled={saving}
                  className="text-[10px] px-2 py-1 bg-brand text-white rounded hover:bg-brand-hover disabled:opacity-50 flex items-center gap-1"
                >
                  <Save className="w-2.5 h-2.5" /> {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => { setEditingTask(false); setTaskDraft(selectedNode.task_description); }}
                  className="text-[10px] px-2 py-1 text-ink-3 hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="relative group">
              <p className="text-xs text-ink whitespace-pre-wrap leading-relaxed">
                {selectedNode.task_description}
              </p>
              {isEditable && (
                <button
                  onClick={() => { setTaskDraft(selectedNode.task_description); setEditingTask(true); }}
                  className="absolute top-0 right-0 text-ink-3 hover:text-brand opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Edit task description"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </CollapsibleSection>
      )}

      {/* Model & Config — editable */}
      <CollapsibleSection title="Configuration" defaultOpen={isEditable}>
        <div className="space-y-1.5">
          {isEditable ? (
            <>
              <EditableConfigRow
                label="Model"
                value={selectedNode.model || ""}
                type="select"
                options={[
                  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (default)" },
                  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
                  { value: "claude-opus-4-6", label: "Opus 4.6" },
                ]}
                onSave={(v) => handleSaveField("model", v)}
              />
              <EditableConfigRow
                label="Max iterations"
                value={String(selectedNode.max_iterations ?? 12)}
                type="number"
                onSave={(v) => handleSaveField("max_iterations", parseInt(v))}
              />
              <EditableConfigRow
                label="Skip judge"
                value={selectedNode.skip_judge ? "true" : "false"}
                type="select"
                options={[
                  { value: "false", label: "No" },
                  { value: "true", label: "Yes" },
                ]}
                onSave={(v) => handleSaveField("skip_judge", v === "true")}
              />
            </>
          ) : (
            <>
              <ConfigRow label="Model" value={selectedNode.model || "-"} />
              <ConfigRow
                label="Max iterations"
                value={selectedNode.max_iterations != null ? String(selectedNode.max_iterations) : "-"}
              />
              <ConfigRow
                label="Attempts"
                value={selectedNode.attempt_count != null ? String(selectedNode.attempt_count) : "-"}
              />
              <ConfigRow
                label="Skip judge"
                value={selectedNode.skip_judge ? "Yes" : "No"}
              />
            </>
          )}
          {selectedNode.requires && selectedNode.requires.length > 0 && (
            <ConfigRow
              label="Depends on"
              value={`${selectedNode.requires.length} node(s)`}
            />
          )}
        </div>
      </CollapsibleSection>

      {/* Judge Config */}
      {selectedNode.judge_config != null ? (
        <CollapsibleSection title="Judge Config" defaultOpen={false}>
          <JsonBlock data={selectedNode.judge_config} />
        </CollapsibleSection>
      ) : null}

      {/* Variant info */}
      {selectedNode.variant_group && (
        <CollapsibleSection title="Decision Variants" defaultOpen={true}>
          <div className="space-y-1.5">
            {allNodes
              .filter((n) => n.variant_group === selectedNode.variant_group)
              .map((v) => (
                <div
                  key={v.id}
                  className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded ${
                    v.variant_selected
                      ? "bg-purple-50 text-purple-700 border border-purple-200"
                      : "bg-surface text-ink-3"
                  }`}
                >
                  <span className="font-medium">
                    {v.variant_selected ? "\u2713" : "\u2022"}{" "}
                    {v.variant_label || v.agent_slug}
                  </span>
                  {v.variant_selected && (
                    <span className="ml-auto text-[10px] bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded">
                      selected
                    </span>
                  )}
                </div>
              ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Tools & Integrations — always shown */}
      <CollapsibleSection title="Tools & Integrations" defaultOpen={true}>
        {/* Tool list */}
        {(credTools.length > 0 || catalogTools.length > 0) && (
          <div className="space-y-1 mb-3">
            <p className="text-[10px] text-ink-3 uppercase tracking-wider font-medium mb-1">
              Tools ({(credTools.length || catalogTools.length)})
            </p>
            {(credTools.length > 0 ? credTools : catalogTools.map((t) => ({
              name: t.name,
              credential: t.credential,
              credential_status: (t.credential ? "missing" : "not_required") as "connected" | "missing" | "not_required",
              display_name: t.credential ?? undefined,
              icon: t.credential ?? undefined,
            }))).map((tool) => {
              const credStatus = tool.credential_status ?? "not_required";
              return (
                <div key={tool.name} className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded border ${
                  credStatus === "missing"
                    ? "bg-amber-50 border-amber-200"
                    : credStatus === "connected"
                      ? "bg-green-50 border-green-200"
                      : "bg-surface border-rim"
                }`}>
                  {tool.icon && tool.credential ? (
                    <IntegrationIcon slug={tool.icon} size={14} />
                  ) : (
                    <KeyRound className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                  )}
                  <span className="font-mono text-ink text-[11px]">{tool.name}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {credStatus === "connected" && (
                      <>
                        <LockOpen className="w-3 h-3 text-green-600" />
                        <span className="text-[10px] text-green-600">Connected</span>
                      </>
                    )}
                    {credStatus === "missing" && (
                      <>
                        <Lock className="w-3 h-3 text-amber-600" />
                        <span className="text-[10px] text-amber-600">
                          needs {tool.display_name || tool.credential}
                        </span>
                      </>
                    )}
                    {credStatus === "not_required" && (
                      <span className="text-[10px] text-ink-3">no auth</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Required integrations with icons */}
        {hasIntegrations && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-ink-3 uppercase tracking-wider font-medium">
              Required Integrations
            </p>
            {(credInfo?.integration_details ?? credInfo?.required_integrations.map((slug) => ({
              slug,
              display_name: slug,
              icon: slug,
              status: (credInfo?.missing.includes(slug) ? "missing" : "connected") as "missing" | "connected",
            })) ?? []).map((detail) => {
              const probe = probes?.[detail.slug];
              const probeOk = probe?.ok === true;
              const probeFailed = probe && !probe.ok;
              const isMissing = detail.status === "missing" || probe?.status === "missing";

              const statusLabels: Record<string, string> = {
                verified: "Verified",
                rate_limited: "Verified",
                auth_failed: "Auth failed",
                endpoint_not_found: "Endpoint not found",
                server_error: "Service down",
                client_error: "Error",
                network_error: "Unreachable",
                config_missing: "Config needed",
                missing: "Not configured",
              };

              let rowClass = "bg-green-50 text-green-700 border border-green-200";
              let label = "Verified";
              let Icon = LockOpen;
              if (isMissing) {
                rowClass = "bg-gray-50 text-gray-600 border border-gray-200";
                label = "Not configured";
                Icon = Lock;
              } else if (probeFailed) {
                rowClass = probe.status === "config_missing"
                  ? "bg-amber-50 text-amber-700 border border-amber-200"
                  : "bg-red-50 text-red-700 border border-red-200";
                label = statusLabels[probe.status] ?? "Failed";
                Icon = Lock;
              } else if (probeOk) {
                label = statusLabels[probe.status] ?? "Verified";
              } else if (detail.status === "connected" && !probe) {
                label = "Saved";
                rowClass = "bg-gray-50 text-gray-500 border border-gray-200";
              }

              return (
                <div
                  key={detail.slug}
                  className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded ${rowClass}`}
                  title={probe?.hint || probe?.error || ""}
                >
                  <IntegrationIcon slug={detail.icon ?? detail.slug} size={14} />
                  <Icon className="w-3 h-3 shrink-0" />
                  <span className="font-medium">{detail.display_name}</span>
                  <span className="ml-auto text-[10px]">{label}</span>
                  {probe?.latency_ms != null && probe.latency_ms > 0 && (
                    <span className="text-[9px] text-ink-3">{probe.latency_ms}ms</span>
                  )}
                </div>
              );
            })}
            {(credInfo?.missing?.length ?? 0) > 0 && (
              <a
                href={`/settings/integrations#${credInfo?.missing[0]}`}
                className="flex items-center gap-1 text-[10px] text-brand hover:underline mt-1"
              >
                Configure integrations <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}

            {/* Setup steps for connected integrations that need extra config */}
            {(credInfo?.integration_details ?? [])
              .filter((d) => d.status === "connected" && d.setup_steps && d.setup_steps.length > 0)
              .map((detail) => (
                <div
                  key={`setup-${detail.slug}`}
                  className="mt-2 border border-amber-200 bg-amber-50 rounded-lg px-2.5 py-2"
                >
                  <p className="text-[10px] font-semibold text-amber-800 mb-1">
                    {detail.display_name} — additional setup needed
                  </p>
                  {detail.setup_steps!.filter((s) => s.required).map((step, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-700 mt-1">
                      <span className="shrink-0 mt-px">&#9888;</span>
                      <span>
                        {step.label}
                        {step.doc_url && (
                          <>
                            {" "}<a href={step.doc_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                              Docs &rarr;
                            </a>
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        )}

        {!hasIntegrations && catalogTools.length === 0 && credTools.length === 0 && (
          <p className="text-[10px] text-ink-3">No external tools or integrations required</p>
        )}
      </CollapsibleSection>
    </div>
  );
}

function NodeChatContent({
  selectedNode,
  messages,
  loading,
  onReply,
}: {
  selectedNode: ExecutionNode;
  messages: NodeMessage[];
  loading: boolean;
  onReply?: (nodeId: string, message: string) => Promise<void>;
}) {
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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

  const canReply = selectedNode.status === "awaiting_reply" ||
    selectedNode.status === "passed" ||
    selectedNode.status === "failed";

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <p className="text-xs text-ink-3">Loading conversation...</p>
        ) : messages.length === 0 ? (
          <div className="text-center py-8">
            <MessageCircle className="w-8 h-8 text-ink-3/30 mx-auto mb-2" />
            <p className="text-xs text-ink-3">
              {selectedNode.status === "running"
                ? "Conversation will appear as the agent runs..."
                : selectedNode.status === "pending" || selectedNode.status === "ready"
                  ? "Conversation will appear once execution starts."
                  : "No conversation recorded for this node."}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <ChatBubble key={msg.id} message={msg} />
          ))
        )}
        {selectedNode.status === "running" && messages.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            <span className="text-xs text-ink-3">Agent is working...</span>
          </div>
        )}
        {selectedNode.status === "awaiting_reply" && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 rounded-lg border border-amber-200">
            <MessageCircle className="w-3.5 h-3.5 text-amber-600" />
            <span className="text-xs text-amber-700">Agent is waiting for your reply</span>
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
              className="flex-1 text-xs text-ink border border-rim rounded-lg p-2 leading-relaxed resize-none min-h-[36px] max-h-[120px] focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand"
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

function ChatBubble({ message }: { message: NodeMessage }) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isTool = message.role === "tool_use" || message.role === "tool_result";
  const isHumanReply = message.metadata && (message.metadata as Record<string, unknown>).source === "human_reply";

  if (isTool) {
    const toolName = (message.metadata as Record<string, unknown>)?.tool_name as string || message.content;
    return (
      <div className="flex items-start gap-2 px-2">
        <Wrench className="w-3 h-3 text-ink-3 mt-0.5 shrink-0" />
        <div className="text-[10px] text-ink-3 min-w-0">
          <span className="font-mono font-medium">
            {message.role === "tool_use" ? `${toolName}()` : `${toolName} result`}
          </span>
          {message.role === "tool_result" && message.content && (
            <div className="mt-0.5 bg-surface rounded p-1.5 max-h-[80px] overflow-y-auto">
              <pre className="text-[10px] font-mono whitespace-pre-wrap break-all">
                {message.content.slice(0, 500)}
                {message.content.length > 500 ? "..." : ""}
              </pre>
            </div>
          )}
        </div>
        <span className="text-[9px] text-ink-3 ml-auto shrink-0">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
        isUser
          ? isHumanReply ? "bg-brand/10" : "bg-gray-100"
          : "bg-violet-100"
      }`}>
        {isUser ? (
          <User className={`w-3 h-3 ${isHumanReply ? "text-brand" : "text-ink-3"}`} />
        ) : (
          <Bot className="w-3 h-3 text-violet-600" />
        )}
      </div>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 ${
        isUser
          ? isHumanReply
            ? "bg-brand/10 border border-brand/20"
            : "bg-gray-100"
          : "bg-surface border border-rim"
      }`}>
        {isHumanReply && (
          <span className="text-[9px] text-brand font-medium block mb-0.5">You</span>
        )}
        <p className="text-xs text-ink whitespace-pre-wrap leading-relaxed break-words">
          {message.content}
        </p>
        <span className={`text-[9px] block mt-1 ${isUser ? "text-right" : ""} text-ink-3`}>
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

export function InspectorPanel({
  selectedNode,
  nodeEvents,
  nodeEventsLoading,
  allNodes,
  credentialStatus,
  catalogMap,
  sessionStatus,
  onNodeUpdate,
  thinkingBlocks = [],
  thinkingBlocksLoading = false,
  liveThinkingChunks = {},
  nodeMessages = [],
  nodeMessagesLoading = false,
  onReply,
  streamEntries = [],
  streamLoading = false,
  liveTextChunks = {},
  failures = [],
  onNodeSelect,
}: InspectorPanelProps) {
  const [selectedEvent, setSelectedEvent] = useState<ExecutionEvent | null>(
    null
  );

  const isActive = selectedNode && (selectedNode.status === "running" || selectedNode.status === "passed" || selectedNode.status === "failed" || selectedNode.status === "awaiting_reply");
  const defaultTab = !selectedNode ? "overview" : isActive ? "conversation" : "nodeinfo";

  // Session-level stats
  const sessionStats = useMemo(() => {
    const passed = allNodes.filter((n) => n.status === "passed").length;
    const failed = allNodes.filter((n) => n.status === "failed").length;
    const skipped = allNodes.filter((n) => n.status === "skipped").length;
    const running = allNodes.filter((n) => n.status === "running").length;
    const pending = allNodes.filter(
      (n) => n.status === "pending" || n.status === "waiting" || n.status === "ready"
    ).length;
    const total = allNodes.length;

    // Duration from earliest started_at to latest completed_at
    const startTimes = allNodes
      .map((n) => n.started_at)
      .filter(Boolean)
      .map((t) => new Date(t!).getTime());
    const endTimes = allNodes
      .map((n) => n.completed_at)
      .filter(Boolean)
      .map((t) => new Date(t!).getTime());
    const earliestStart = startTimes.length ? Math.min(...startTimes) : null;
    const latestEnd = endTimes.length ? Math.max(...endTimes) : null;
    const totalDurationMs =
      earliestStart && latestEnd ? latestEnd - earliestStart : null;

    return { passed, failed, skipped, running, pending, total, totalDurationMs };
  }, [allNodes]);

  // Synthesize timeline from node data when no DB events exist
  const synthesizedTimeline = useMemo(() => {
    if (!selectedNode) return [];
    if (nodeEvents.length > 0) return []; // real events exist, don't synthesize

    const entries: Array<{
      type: string;
      label: string;
      detail: string;
      time: string | null;
      color: string;
    }> = [];

    if (selectedNode.started_at) {
      entries.push({
        type: "node_started",
        label: "Node started",
        detail: `Agent: ${selectedNode.agent_slug}`,
        time: selectedNode.started_at,
        color: "bg-blue-500",
      });
    }

    if (selectedNode.status === "running") {
      entries.push({
        type: "running",
        label: "Executing...",
        detail: `Attempt ${selectedNode.attempt_count || 1}`,
        time: null,
        color: "bg-blue-500 animate-pulse",
      });
    }

    if (
      selectedNode.judge_score != null &&
      selectedNode.status !== "skipped"
    ) {
      const passed = selectedNode.status === "passed";
      entries.push({
        type: passed ? "judge_pass" : "judge_fail",
        label: passed ? "Judge passed" : "Judge failed",
        detail: `Score: ${Number(selectedNode.judge_score).toFixed(1)}/10`,
        time: null,
        color: passed ? "bg-green-500" : "bg-red-500",
      });
    }

    if (selectedNode.completed_at) {
      entries.push({
        type: "node_completed",
        label:
          selectedNode.status === "skipped"
            ? "Node skipped"
            : "Node completed",
        detail: `Status: ${selectedNode.status}`,
        time: selectedNode.completed_at,
        color:
          selectedNode.status === "passed"
            ? "bg-green-500"
            : selectedNode.status === "skipped"
              ? "bg-gray-400"
              : "bg-red-500",
      });
    }

    return entries;
  }, [selectedNode, nodeEvents]);

  return (
    <div className="flex h-full flex-col border-l border-rim bg-page">
      <Tabs
        defaultValue={defaultTab}
        key={selectedNode?.id ?? "none"}
        className="flex flex-col h-full"
      >
        <TabsList className="w-full justify-start border-b border-rim bg-transparent px-2 py-0 h-10 shrink-0">
          {selectedNode ? (
            <>
              <TabsTrigger
                value="nodeinfo"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                Detail
              </TabsTrigger>
              <TabsTrigger
                value="conversation"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                <Activity className="w-3 h-3 mr-1" /> Conversation
              </TabsTrigger>
              <TabsTrigger
                value="output"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                Output
              </TabsTrigger>
              <TabsTrigger
                value="failures"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                Failures
                {failures.filter(f => f.status === "failed").length > 0 && (
                  <span className="ml-1 bg-red-500 text-white text-[10px] rounded-full px-1.5 leading-4 inline-block min-w-[18px] text-center">
                    {failures.filter(f => f.status === "failed").length}
                  </span>
                )}
              </TabsTrigger>
            </>
          ) : (
            <>
              <TabsTrigger
                value="overview"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="failures"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                Failures
                {failures.filter(f => f.status === "failed").length > 0 && (
                  <span className="ml-1 bg-red-500 text-white text-[10px] rounded-full px-1.5 leading-4 inline-block min-w-[18px] text-center">
                    {failures.filter(f => f.status === "failed").length}
                  </span>
                )}
              </TabsTrigger>
            </>
          )}
        </TabsList>

        {/* ── Node Detail tab ─────────────────────────────── */}
        <TabsContent value="nodeinfo" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            {selectedNode && (
              <NodeDetailContent
                selectedNode={selectedNode}
                allNodes={allNodes}
                credentialStatus={credentialStatus}
                catalogMap={catalogMap}
                sessionStatus={sessionStatus}
                onNodeUpdate={onNodeUpdate}
              />
            )}
          </ScrollArea>
        </TabsContent>

        {/* ── Session Overview tab (no node selected) ──── */}
        <TabsContent value="overview" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-5">
              {/* Session stats */}
              <div>
                <h3 className="text-sm font-semibold text-ink mb-3">
                  Session Overview
                </h3>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  <StatCard
                    label="Passed"
                    value={sessionStats.passed}
                    color="text-green-600"
                    icon={
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                    }
                  />
                  <StatCard
                    label="Failed"
                    value={sessionStats.failed}
                    color="text-red-600"
                    icon={<XCircle className="w-3.5 h-3.5 text-red-500" />}
                  />
                  <StatCard
                    label="Skipped"
                    value={sessionStats.skipped}
                    color="text-ink-3"
                    icon={
                      <SkipForward className="w-3.5 h-3.5 text-gray-400" />
                    }
                  />
                  {sessionStats.running > 0 && (
                    <StatCard
                      label="Running"
                      value={sessionStats.running}
                      color="text-blue-600"
                      icon={<Play className="w-3.5 h-3.5 text-blue-500" />}
                    />
                  )}
                  {sessionStats.pending > 0 && (
                    <StatCard
                      label="Pending"
                      value={sessionStats.pending}
                      color="text-amber-600"
                      icon={
                        <Clock className="w-3.5 h-3.5 text-amber-400" />
                      }
                    />
                  )}
                </div>

                {/* Duration */}
                {sessionStats.totalDurationMs != null && (
                  <div className="flex items-center gap-2 text-xs text-ink-2 mb-4">
                    <Clock className="w-3 h-3 text-ink-3" />
                    <span>
                      Total duration:{" "}
                      {formatDuration(sessionStats.totalDurationMs)}
                    </span>
                  </div>
                )}

                {/* Progress bar */}
                {sessionStats.total > 0 && (
                  <div className="mb-4">
                    <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
                      {sessionStats.passed > 0 && (
                        <div
                          className="bg-green-500"
                          style={{
                            width: `${(sessionStats.passed / sessionStats.total) * 100}%`,
                          }}
                        />
                      )}
                      {sessionStats.failed > 0 && (
                        <div
                          className="bg-red-500"
                          style={{
                            width: `${(sessionStats.failed / sessionStats.total) * 100}%`,
                          }}
                        />
                      )}
                      {sessionStats.running > 0 && (
                        <div
                          className="bg-blue-500 animate-pulse"
                          style={{
                            width: `${(sessionStats.running / sessionStats.total) * 100}%`,
                          }}
                        />
                      )}
                      {sessionStats.skipped > 0 && (
                        <div
                          className="bg-gray-300"
                          style={{
                            width: `${(sessionStats.skipped / sessionStats.total) * 100}%`,
                          }}
                        />
                      )}
                    </div>
                    <p className="text-[10px] text-ink-3 mt-1">
                      {sessionStats.passed + sessionStats.failed + sessionStats.skipped}/
                      {sessionStats.total} completed
                    </p>
                  </div>
                )}
              </div>

              {/* Node list */}
              <div>
                <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-2">
                  All Nodes ({allNodes.length})
                </h4>
                {allNodes.length === 0 ? (
                  <p className="text-xs text-ink-3">
                    No nodes. Submit a request to get started.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {allNodes.map((n) => (
                      <div
                        key={n.id}
                        className="flex items-center gap-2 text-xs text-ink-2 py-1.5 px-2 rounded hover:bg-surface"
                      >
                        <div
                          className={`w-2 h-2 rounded-full shrink-0 ${dotClass(n.status)}`}
                        />
                        <span className="truncate font-medium">
                          {n.agent_slug || n.id.slice(0, 8)}
                        </span>
                        <span className="text-ink-3 capitalize ml-auto shrink-0">
                          {n.status}
                        </span>
                        {n.judge_score != null && (
                          <span className="text-[10px] font-mono text-green-600 shrink-0">
                            {Number(n.judge_score).toFixed(1)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* ── Timeline tab ────────────────────────────── */}
        {/* ── Conversation tab (unified stream) ──────── */}
        <TabsContent value="conversation" className="flex-1 min-h-0 m-0 flex flex-col">
          {!selectedNode ? (
            <div className="p-4">
              <p className="text-xs text-ink-3">Select a node to view its conversation.</p>
            </div>
          ) : (
            <ConversationStream
              entries={streamEntries}
              loading={streamLoading}
              selectedNode={selectedNode}
              onReply={onReply}
              liveThinkingChunks={liveThinkingChunks}
              liveTextChunks={liveTextChunks}
            />
          )}
        </TabsContent>

        {/* ── Output tab ──────────────────────────────── */}
        <TabsContent value="output" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              {!selectedNode ? (
                <p className="text-xs text-ink-3">
                  Select a node to view its output.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">
                      Node Output
                    </h3>
                    {selectedNode.output != null ? (
                      <CopyButton
                        text={JSON.stringify(selectedNode.output, null, 2)}
                      />
                    ) : null}
                  </div>

                  {/* Artifacts */}
                  {(selectedNode.artifacts as Array<{type: string; url: string; title: string}> | null)?.length ? (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-ink-2 uppercase tracking-wider">Artifacts</h4>
                      <div className="grid gap-2">
                        {(selectedNode.artifacts as Array<{type: string; url: string; title: string}>).map((artifact, idx) => (
                          <a
                            key={idx}
                            href={artifact.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-3 p-3 rounded-lg border border-rim bg-surface hover:bg-blue-50 hover:border-blue-200 transition-colors group"
                          >
                            <div className="flex-shrink-0 w-8 h-8 rounded-md bg-blue-100 text-blue-600 flex items-center justify-center">
                              <ExternalLink className="w-4 h-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-ink truncate group-hover:text-blue-700">{artifact.title}</p>
                              <p className="text-[10px] text-ink-3 truncate">{artifact.type.replace(/_/g, " ")} &middot; {artifact.url}</p>
                            </div>
                            <ExternalLink className="w-3.5 h-3.5 text-ink-3 group-hover:text-blue-500 flex-shrink-0" />
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {selectedNode.output != null ? (
                    <JsonBlock data={selectedNode.output} />
                  ) : (
                    <div className="text-xs text-ink-3 bg-surface rounded-lg p-4 text-center">
                      {selectedNode.status === "running"
                        ? "Output will appear when execution completes..."
                        : selectedNode.status === "skipped"
                          ? "Node was skipped (upstream dependency failed)"
                          : selectedNode.status === "pending" ||
                              selectedNode.status === "ready" ||
                              selectedNode.status === "waiting"
                            ? "Node has not executed yet"
                            : "No output produced"}
                    </div>
                  )}

                  {/* Input section */}
                  {selectedNode.input != null ? (
                    <CollapsibleSection title="Input" defaultOpen={false}>
                      <JsonBlock data={selectedNode.input} />
                    </CollapsibleSection>
                  ) : null}
                </>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
        {/* ── Failures tab ───────────────────────────── */}
        <TabsContent value="failures" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-3">
              <h3 className="text-sm font-semibold text-ink">
                Failures &amp; Retries
              </h3>
              {failures.length === 0 ? (
                <p className="text-xs text-ink-3">No failures or retries in this session.</p>
              ) : (
                <div className="space-y-2">
                  {failures.map((node) => {
                    const cat = node.error_category;
                    const outputObj = node.output as Record<string, unknown> | undefined;
                    const verification = outputObj?.verification as Record<string, unknown> | undefined;
                    const blockers = verification?.blockers as string[] | undefined;
                    const errorMsg = node.judge_feedback ||
                      (outputObj?.error as string) ||
                      "";
                    return (
                      <div
                        key={node.id}
                        className="rounded-lg border border-rim bg-surface p-3 space-y-1.5"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className={`w-2 h-2 rounded-full shrink-0 ${dotClass(node.status)}`} />
                          <span className="text-xs font-medium font-mono text-ink">
                            {node.agent_slug}
                          </span>
                          {cat && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${categoryBadgeClass(cat)}`}>
                              {cat.replace(/_/g, " ")}
                            </span>
                          )}
                          <span className="text-[10px] text-ink-3 capitalize ml-auto">
                            {node.status}
                          </span>
                          {(node.attempt_count ?? 0) > 1 && (
                            <span className="text-[10px] text-amber-600 font-medium">
                              {node.attempt_count} attempts
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-2 leading-relaxed line-clamp-2">
                          {node.task_description}
                        </p>
                        {errorMsg && (
                          <p className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1 leading-relaxed line-clamp-3">
                            {errorMsg}
                          </p>
                        )}
                        {blockers && blockers.length > 0 && (
                          <div className="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1 space-y-0.5">
                            <span className="font-medium">Blockers:</span>
                            <ul className="list-disc list-inside">
                              {blockers.map((b, i) => (
                                <li key={i}>{b}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {node.judge_score != null && (
                          <div className="text-[10px] text-ink-3">
                            Judge score: {Number(node.judge_score).toFixed(1)}/10
                          </div>
                        )}
                        {onNodeSelect && (
                          <button
                            onClick={() => onNodeSelect(node.id)}
                            className="text-[11px] text-brand hover:underline"
                          >
                            View node details
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const CATEGORY_BADGE_CLASSES: Record<string, string> = {
  preflight_error: "bg-amber-100 text-amber-700",
  auth_error: "bg-amber-100 text-amber-700",
  validation_error: "bg-red-100 text-red-700",
  timeout: "bg-orange-100 text-orange-700",
  api_error: "bg-blue-100 text-blue-700",
  internal_error: "bg-gray-100 text-gray-600",
};

function categoryBadgeClass(category: string): string {
  return CATEGORY_BADGE_CLASSES[category] ?? "bg-gray-100 text-gray-600";
}

// ── Thinking components ──────────────────────────────────────────────────────

function ThinkingCard({
  iteration,
  text,
  tokenCount,
  timestamp,
  isLive,
  defaultOpen,
}: {
  iteration: number;
  text: string;
  tokenCount: number | null;
  timestamp: string | null;
  isLive: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const previewLength = 120;
  const preview = text.length > previewLength
    ? text.slice(0, previewLength).trimEnd() + "\u2026"
    : text;

  return (
    <div
      className={`rounded-lg border overflow-hidden transition-colors ${
        isLive
          ? "border-violet-400/40 bg-violet-500/5 border-l-2 border-l-violet-400 animate-pulse"
          : "border-violet-500/10 bg-violet-500/[0.03]"
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-violet-500/5 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-violet-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-violet-400 shrink-0" />
        )}
        <Brain className="w-3 h-3 text-violet-400 shrink-0" />
        <span className="text-xs font-medium text-ink">
          Iteration {iteration}
        </span>
        {isLive && (
          <span className="text-[9px] font-medium text-violet-500 bg-violet-500/10 px-1.5 py-0.5 rounded-full">
            LIVE
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {tokenCount != null && (
            <span className="text-[10px] text-violet-500/70 font-mono">
              {tokenCount.toLocaleString()} tokens
            </span>
          )}
          {timestamp && (
            <span className="text-[10px] text-ink-3">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
        </span>
      </button>

      {!open && (
        <div className="px-3 pb-2 -mt-0.5">
          <p className="text-[11px] text-ink-3 font-mono truncate">{preview}</p>
        </div>
      )}

      {open && (
        <div className="border-t border-violet-500/10">
          <div className="px-3 py-2 max-h-[500px] overflow-y-auto">
            <pre className="text-[11px] font-mono text-ink-2 whitespace-pre-wrap leading-relaxed break-words">
              {text}
            </pre>
          </div>
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-violet-500/10 bg-violet-500/[0.02]">
            <span className="text-[10px] text-ink-3">
              {text.length.toLocaleString()} chars
              {tokenCount != null && ` \u00B7 ${tokenCount.toLocaleString()} tokens`}
            </span>
            <CopyButton text={text} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function TimingSection({ node }: { node: ExecutionNode }) {
  if (!node.started_at && !node.completed_at) return null;

  const started = node.started_at ? new Date(node.started_at) : null;
  const completed = node.completed_at ? new Date(node.completed_at) : null;
  const durationMs =
    started && completed ? completed.getTime() - started.getTime() : null;

  return (
    <div className="flex items-center gap-3 py-2 px-3 bg-surface rounded-lg text-xs text-ink-2">
      <Clock className="w-3.5 h-3.5 text-ink-3 shrink-0" />
      <div className="min-w-0 flex-1">
        {started && (
          <div>
            Started: {started.toLocaleTimeString()}{" "}
            <span className="text-ink-3">
              {started.toLocaleDateString()}
            </span>
          </div>
        )}
        {durationMs != null && (
          <div className="font-medium text-ink">
            Duration: {formatDuration(durationMs)}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const color =
    score >= 7
      ? "bg-green-500"
      : score >= 5
        ? "bg-amber-500"
        : "bg-red-500";
  const textColor =
    score >= 7
      ? "text-green-700"
      : score >= 5
        ? "text-amber-700"
        : "text-red-700";

  return (
    <div className="flex items-center gap-2 flex-1">
      <span className={`text-lg font-bold font-mono ${textColor}`}>
        {score.toFixed(1)}
      </span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-ink-3">/10</span>
    </div>
  );
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-rim rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-2 bg-surface hover:bg-gray-50 transition-colors text-left"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-ink-3" />
        ) : (
          <ChevronRight className="w-3 h-3 text-ink-3" />
        )}
        <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
          {title}
        </span>
      </button>
      {open && <div className="px-3 py-2 border-t border-rim">{children}</div>}
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-ink-3 w-24 shrink-0">{label}</span>
      <span className="text-ink font-mono">{value}</span>
    </div>
  );
}

function AgentSwapSelector({
  currentSlug,
  catalogMap,
  currentCategory,
  onSelect,
}: {
  currentSlug: string;
  catalogMap: Record<string, CatalogAgent>;
  currentCategory?: string;
  onSelect: (slug: string) => void;
}) {
  const [filter, setFilter] = useState<"same_category" | "all">("same_category");

  const agents = Object.values(catalogMap)
    .filter((a) => {
      if (a.slug === currentSlug) return false;
      if (filter === "same_category" && currentCategory && a.category !== currentCategory) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setFilter("same_category")}
          className={`text-[10px] px-2 py-0.5 rounded-full ${
            filter === "same_category" ? "bg-brand text-white" : "bg-surface text-ink-3 border border-rim"
          }`}
        >
          Same category
        </button>
        <button
          onClick={() => setFilter("all")}
          className={`text-[10px] px-2 py-0.5 rounded-full ${
            filter === "all" ? "bg-brand text-white" : "bg-surface text-ink-3 border border-rim"
          }`}
        >
          All agents
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto space-y-1">
        {agents.map((agent) => (
          <button
            key={agent.slug}
            onClick={() => onSelect(agent.slug)}
            className="w-full text-left flex items-start gap-2 text-xs py-1.5 px-2 rounded hover:bg-surface border border-rim transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium text-ink">{agent.name}</div>
              <div className="text-[10px] text-ink-3 truncate">{agent.description}</div>
              {agent.required_integrations.length > 0 && (
                <div className="flex items-center gap-1 mt-0.5">
                  {agent.required_integrations.map((ri) => (
                    <span key={ri} className="text-[8px] px-1 py-0.5 rounded-full bg-blue-50 text-blue-600">
                      {ri}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </button>
        ))}
        {agents.length === 0 && (
          <p className="text-[10px] text-ink-3 text-center py-2">No other agents in this category</p>
        )}
      </div>
    </div>
  );
}

function EditableConfigRow({
  label,
  value,
  type = "text",
  options,
  onSave,
}: {
  label: string;
  value: string;
  type?: "text" | "number" | "select";
  options?: Array<{ value: string; label: string }>;
  onSave: (value: string) => void;
}) {
  const [current, setCurrent] = useState(value);

  const handleChange = (newValue: string) => {
    setCurrent(newValue);
    onSave(newValue);
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-ink-3 w-24 shrink-0">{label}</span>
      {type === "select" && options ? (
        <select
          value={current}
          onChange={(e) => handleChange(e.target.value)}
          className="flex-1 text-xs font-mono text-ink bg-surface border border-rim rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          onBlur={() => handleChange(current)}
          className="flex-1 text-xs font-mono text-ink bg-surface border border-rim rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand"
        />
      )}
    </div>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

  return (
    <pre className="text-[11px] font-mono text-ink bg-gray-50 border border-rim rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
      {text}
    </pre>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 mt-1 text-[10px] font-mono text-ink-3 hover:text-ink transition-colors"
    >
      {id.slice(0, 8)}...
      {copied ? (
        <Check className="w-2.5 h-2.5 text-green-500" />
      ) : (
        <Copy className="w-2.5 h-2.5" />
      )}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="text-[10px] text-ink-3 hover:text-ink flex items-center gap-1 transition-colors"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 text-green-500" /> Copied
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" /> Copy
        </>
      )}
    </button>
  );
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-lg px-3 py-2 flex items-center gap-2">
      {icon}
      <div>
        <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
        <div className="text-[10px] text-ink-3 uppercase tracking-wider">
          {label}
        </div>
      </div>
    </div>
  );
}

// ── Event rendering ──────────────────────────────────────────────────────────

function EventRow({
  event,
  index,
  onClick,
}: {
  event: ExecutionEvent;
  index: number;
  onClick?: () => void;
}) {
  const eventType = event.event_type || "";
  const payload = event.payload;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === " ") && onClick?.()
      }
      className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-surface group cursor-pointer"
    >
      <div
        className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${eventDotColor(eventType)}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-ink">
            {formatEventType(eventType)}
          </span>
          {event.created_at && (
            <span className="text-[10px] text-ink-3 ml-auto">
              {new Date(event.created_at).toLocaleTimeString()}
            </span>
          )}
        </div>
        {payload && Object.keys(payload).length > 0 && (
          <div className="text-[10px] text-ink-3 font-mono mt-0.5 truncate max-w-full">
            {formatPayload(payload)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Formatters & helpers ─────────────────────────────────────────────────────

function JudgeSection({ node }: { node: ExecutionNode }) {
  if (node.judge_score == null && !node.judge_feedback) return null;
  return (
    <CollapsibleSection title="Judge Evaluation" defaultOpen={true}>
      {node.judge_score != null && (
        <div className="flex items-center gap-3 mb-2">
          <ScoreBar score={node.judge_score} />
        </div>
      )}
      {node.judge_feedback ? (
        <p className="text-xs text-ink-2 whitespace-pre-wrap leading-relaxed">
          {node.judge_feedback}
        </p>
      ) : null}
    </CollapsibleSection>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.floor(secs % 60);
  return `${mins}m ${remainSecs}s`;
}

function formatEventType(eventType: string): string {
  const labels: Record<string, string> = {
    node_started: "Node started",
    node_completed: "Node completed",
    executor_start: "Executor started",
    executor_llm_send: "LLM request",
    executor_llm_receive: "LLM response",
    executor_thinking: "Model thinking",
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
  if (payload.stop_reason) parts.push(`stop=${payload.stop_reason}`);
  if (payload.input_tokens) parts.push(`in=${payload.input_tokens}`);
  if (payload.output_tokens) parts.push(`out=${payload.output_tokens}`);
  if (payload.cache_read_tokens) parts.push(`cache_hit=${payload.cache_read_tokens}`);
  if (payload.cache_creation_tokens) parts.push(`cache_write=${payload.cache_creation_tokens}`);
  if (payload.thinking_tokens) parts.push(`thinking=${payload.thinking_tokens}`);
  if (payload.thinking_length) parts.push(`${payload.thinking_length} chars`);
  if (payload.duration_ms != null) parts.push(`${payload.duration_ms}ms`);
  if (payload.model) parts.push(`${payload.model}`);
  if (payload.passed != null) parts.push(payload.passed ? "passed" : "failed");
  if (payload.feedback)
    parts.push(String(payload.feedback).slice(0, 60) + "\u2026");
  if (!parts.length) {
    const json = JSON.stringify(payload);
    return json.length > 80 ? json.slice(0, 80) + "\u2026" : json;
  }
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
  if (eventType.includes("thinking")) return "bg-violet-400";
  if (eventType.includes("judge")) return "bg-purple-500";
  if (eventType.includes("critic")) return "bg-amber-500";
  if (eventType.includes("tool")) return "bg-cyan-500";
  if (eventType.includes("llm_send") || eventType.includes("llm_receive"))
    return "bg-indigo-400";
  if (eventType.includes("executor")) return "bg-blue-400";
  if (eventType.includes("started")) return "bg-blue-500";
  return "bg-gray-400";
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "passed":
      return "bg-green-50 text-green-700";
    case "running":
      return "bg-blue-50 text-blue-700";
    case "ready":
      return "bg-blue-50 text-blue-600";
    case "waiting":
      return "bg-amber-50 text-amber-700";
    case "failed":
      return "bg-red-50 text-red-700";
    case "skipped":
      return "bg-surface text-ink-3";
    case "awaiting_reply":
      return "bg-amber-50 text-amber-700";
    default:
      return "bg-surface text-ink-2";
  }
}

function dotClass(status: string): string {
  switch (status) {
    case "passed":
      return "bg-green-500";
    case "running":
      return "bg-blue-500 animate-pulse";
    case "ready":
      return "bg-blue-400";
    case "waiting":
      return "bg-amber-400";
    case "failed":
      return "bg-red-500";
    case "skipped":
      return "bg-gray-300";
    case "awaiting_reply":
      return "bg-amber-500 animate-pulse";
    default:
      return "bg-gray-300";
  }
}
