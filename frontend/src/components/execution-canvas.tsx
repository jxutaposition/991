"use client";

import {
  useRef,
  useImperativeHandle,
  forwardRef,
  useMemo,
  useCallback,
  useLayoutEffect,
  useState,
  useEffect,
} from "react";
import { ArrowDown, Brain, GitBranch, Lock, LockOpen, Check, X, Wrench, MessageCircle, ExternalLink, Loader2 } from "lucide-react";
import { IntegrationIcon } from "@/components/integration-icon";
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";

export interface ArtifactLink {
  type: string;
  url: string;
  title: string;
}

export interface ExecutionNode {
  id: string;
  agent_slug: string;
  task_description: string;
  status: string;
  requires: string[] | null;
  judge_score: number | null;
  judge_feedback: string | null;
  attempt_count: number;
  parent_uid?: string | null;
  model?: string | null;
  max_iterations?: number | null;
  skip_judge?: boolean | null;
  judge_config?: unknown;
  input?: unknown;
  output?: unknown;
  started_at?: string | null;
  completed_at?: string | null;
  depth?: number | null;
  spawn_context?: string | null;
  acceptance_criteria?: string[] | null;
  artifacts?: ArtifactLink[] | null;
  step_index?: number | null;
  error_category?: string | null;
  // Branching variant support
  variant_group?: string | null;
  variant_label?: string | null;
  variant_selected?: boolean | null;
  // Living system description (SD-005)
  description?: {
    display_name?: string;
    architecture?: { purpose?: string; connections?: string[]; data_flow?: string };
    technical_spec?: { approach?: string; tools?: string[]; configuration?: Record<string, unknown> };
    io_contract?: { inputs?: Array<{ name: string; source?: string; schema?: unknown }>; outputs?: Array<{ name: string; schema?: unknown }> };
    optionality?: Array<{ decision: string; tradeoffs?: string; recommendation?: string }>;
    visual_refs?: Array<{ type: string; url: string; caption?: string }>;
    prior_artifacts?: Array<{ title: string; reference?: string }>;
  } | null;
}

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => {
      const s = Math.floor((Date.now() - start) / 1000);
      if (s < 60) setElapsed(`${s}s`);
      else if (s < 3600) setElapsed(`${Math.floor(s / 60)}m ${s % 60}s`);
      else setElapsed(`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return <span className="text-[9px] font-mono text-blue-500">{elapsed}</span>;
}

export interface CanvasHandle {
  resetTransform: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

interface ToolCredentialInfo {
  name: string;
  credential: string | null;
  credential_status?: "connected" | "missing" | "not_required";
  display_name?: string;
  icon?: string;
}

interface IntegrationDetail {
  slug: string;
  display_name: string;
  icon: string;
  status: "connected" | "missing";
  setup_steps?: { label: string; help?: string; doc_url?: string; required?: boolean }[];
}

interface AgentCredentialInfo {
  tools: ToolCredentialInfo[];
  required_integrations: string[];
  integration_details?: IntegrationDetail[];
  missing: string[];
  status: "ready" | "blocked" | "no_tools";
}

export interface ProbeResultEntry {
  status: string;
  ok: boolean;
  http_status?: number;
  error?: string;
  hint?: string;
  latency_ms?: number;
}

export interface CredentialStatus {
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

type CatalogMap = Record<string, CatalogAgent>;

interface ExecutionCanvasProps {
  nodes: ExecutionNode[];
  sessionStatus: string;
  selectedNodeId: string | null;
  onNodeClick?: (id: string) => void;
  onZoomChange?: (scale: number) => void;
  credentialStatus?: CredentialStatus | null;
  catalogMap?: CatalogMap;
  livePreviewMap?: Record<string, string>;
}

type NodeStatus = string;

const NODE_BG: Record<string, string> = {
  passed:  "bg-green-50 border-green-300 text-green-700",
  running: "bg-blue-50 border-blue-400 text-blue-700 shadow-lg shadow-blue-200/50 ring-1 ring-blue-300/30",
  ready:   "bg-blue-50 border-blue-200 text-blue-600",
  waiting: "bg-amber-50 border-amber-300 text-amber-700",
  failed:  "bg-red-50 border-red-400 text-red-700",
  skipped: "bg-surface border-rim text-ink-3 line-through",
  pending: "bg-surface border-rim text-ink-3",
  preview: "bg-purple-50/50 border-dashed border-purple-200 text-purple-400",
  queued:  "bg-gray-50 border-gray-300 text-gray-500",
  awaiting_reply: "bg-amber-50 border-amber-400 text-amber-700 shadow-lg shadow-amber-100",
};

const DOT: Record<string, string> = {
  passed:  "bg-green-500",
  running: "bg-blue-500 animate-pulse",
  ready:   "bg-blue-400",
  waiting: "bg-amber-400",
  failed:  "bg-red-500",
  skipped: "bg-gray-300",
  pending: "bg-gray-300",
  preview: "bg-purple-300",
  queued:  "bg-gray-400",
  awaiting_reply: "bg-amber-500 animate-pulse",
};

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

const INTERNAL_TOOLS = ["read_upstream_output", "write_output", "spawn_agent"];

function NodeBox({
  node,
  isSelected,
  isChild,
  onClick,
  credInfo,
  catalogAgent,
  probeResults,
  sessionStatus,
  livePreview,
}: {
  node: ExecutionNode;
  isSelected: boolean;
  isChild: boolean;
  onClick: () => void;
  credInfo?: AgentCredentialInfo;
  catalogAgent?: CatalogAgent;
  probeResults?: Record<string, ProbeResultEntry>;
  sessionStatus?: string;
  livePreview?: string;
}) {
  const rawStatus = node.status as NodeStatus;
  const status = rawStatus === "preview" && sessionStatus === "executing" ? "queued" : rawStatus;
  const name = node.agent_slug || node.id.slice(0, 8);
  const desc = node.task_description?.trim();
  const score =
    node.judge_score != null ? Number(node.judge_score).toFixed(1) : null;
  const isVariantAlt = node.variant_group != null && node.variant_selected === false;

  // Credential status badge — use probe results when available
  const hasIntegrations = credInfo && credInfo.required_integrations.length > 0;
  const agentProbeIssue = hasIntegrations && probeResults
    ? credInfo.required_integrations.some((s) => probeResults[s] && !probeResults[s].ok)
    : false;
  const isBlocked = credInfo?.status === "blocked" || agentProbeIssue;

  // User-facing tools (from catalog, excluding internal tools)
  const userTools = catalogAgent?.tools?.filter(
    (t) => !INTERNAL_TOOLS.includes(t.name)
  ) ?? [];
  const toolsWithCred = userTools.filter((t) => t.credential);
  const toolsWithoutCred = userTools.filter((t) => !t.credential);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`relative rounded-xl border-2 px-5 py-4
        ${isChild ? "min-w-[180px] max-w-[260px]" : "min-w-[240px] max-w-[380px]"}
        ${isVariantAlt ? "opacity-40 border-dashed border-gray-300 bg-gray-50 text-gray-400" : NODE_BG[status] ?? NODE_BG.pending}
        ${isSelected ? "ring-2 ring-blue-400 ring-offset-2 ring-offset-white" : ""}
        ${isBlocked && !isVariantAlt ? (agentProbeIssue ? "border-l-red-400 border-l-4" : "border-l-amber-400 border-l-4") : ""}
        flex flex-col items-start gap-1.5 transition-all hover:scale-[1.03] cursor-pointer hover:shadow-lg`}
    >
      {/* Step index badge */}
      {node.step_index != null && (
        <div className="absolute -top-2.5 -left-2 bg-blue-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full shadow-sm z-10">
          {node.step_index}
        </div>
      )}

      <div className="absolute top-2 right-2.5 flex items-center gap-1">
        {status === "running" && !isVariantAlt && (
          <>
            <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />
            <Brain className="w-3 h-3 text-violet-400 animate-pulse" />
          </>
        )}
        {status === "awaiting_reply" && !isVariantAlt && (
          <MessageCircle className="w-3 h-3 text-amber-500 animate-pulse" />
        )}
        <div
          className={`w-2 h-2 rounded-full ${isVariantAlt ? "bg-gray-300" : DOT[status] ?? DOT.pending}`}
        />
      </div>

      {/* Auth status badge — top-left */}
      {!isVariantAlt && (
        <div
          className={`absolute top-2 left-2.5 flex items-center gap-0.5 ${
            isBlocked && agentProbeIssue
              ? "text-red-500"
              : isBlocked
                ? "text-amber-500"
                : hasIntegrations
                  ? "text-green-500"
                  : "text-ink-3"
          }`}
          title={
            isBlocked && agentProbeIssue
              ? `Issues: ${credInfo?.required_integrations.filter((s) => probeResults?.[s] && !probeResults[s].ok).map((s) => `${s} (${probeResults?.[s]?.status})`).join(", ")}`
              : isBlocked
                ? `Missing: ${credInfo?.missing.join(", ")}`
                : hasIntegrations
                  ? "All credentials verified"
                  : "No external auth required"
          }
        >
          {isBlocked ? (
            <Lock className="w-3 h-3" />
          ) : hasIntegrations ? (
            <LockOpen className="w-3 h-3" />
          ) : (
            <Wrench className="w-3 h-3" />
          )}
        </div>
      )}

      {isChild && !hasIntegrations && !catalogAgent && (
        <GitBranch className="absolute top-2.5 left-2.5 w-3 h-3 text-purple-400" />
      )}

      {/* Category badge */}
      {catalogAgent && !isVariantAlt && (
        <div className="text-[8px] font-medium text-ink-3 uppercase tracking-wider pl-4">
          {catalogAgent.category.replace(/_/g, " ")}
        </div>
      )}

      {node.variant_label && (
        <div className={`text-[9px] font-medium ${isVariantAlt ? "text-gray-400" : "text-purple-500"}`}>
          {node.variant_selected ? "\u2713 " : ""}{node.variant_label}
        </div>
      )}

      <div
        className={`text-sm font-semibold truncate w-full pl-4 pr-4`}
      >
        {name}
      </div>

      {desc && (
        <div className={`text-[11px] leading-snug line-clamp-2 w-full text-left ${isVariantAlt ? "text-gray-400" : "text-ink-2"}`}>
          {truncate(desc, 100)}
        </div>
      )}

      {/* Integration chips with icons */}
      {hasIntegrations && !isVariantAlt && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {(credInfo.integration_details ?? credInfo.required_integrations.map((slug) => ({
            slug,
            display_name: slug,
            icon: slug,
            status: (credInfo.missing.includes(slug) ? "missing" : "connected") as "missing" | "connected",
          }))).map((detail) => {
            const probe = probeResults?.[detail.slug];
            const probeOk = probe?.ok === true;
            const probeFailed = probe && !probe.ok;
            const isMissing = detail.status === "missing" || probe?.status === "missing";

            let chipClass = "bg-green-100 text-green-700";
            let chipLabel = "Verified";
            let chipIcon = <Check className="w-2.5 h-2.5" />;

            if (isMissing) {
              chipClass = "bg-gray-100 text-gray-600";
              chipLabel = "Not configured";
              chipIcon = <X className="w-2.5 h-2.5" />;
            } else if (probeFailed) {
              const statusLabels: Record<string, string> = {
                auth_failed: "Auth failed",
                endpoint_not_found: "Endpoint missing",
                server_error: "Service down",
                client_error: "Error",
                network_error: "Unreachable",
                config_missing: "Config needed",
              };
              chipLabel = statusLabels[probe.status] ?? "Failed";
              chipClass = probe.status === "config_missing"
                ? "bg-amber-100 text-amber-700"
                : "bg-red-100 text-red-700";
              chipIcon = <X className="w-2.5 h-2.5" />;
            } else if (probeOk) {
              chipLabel = probe.status === "rate_limited" ? "Verified" : "Verified";
              chipClass = "bg-green-100 text-green-700";
              chipIcon = <Check className="w-2.5 h-2.5" />;
            } else if (detail.status === "connected" && !probe) {
              chipLabel = "Saved";
              chipClass = "bg-gray-100 text-gray-500";
              chipIcon = <Check className="w-2.5 h-2.5" />;
            }

            return (
              <span
                key={detail.slug}
                className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full font-medium ${chipClass}`}
                title={probe?.hint || probe?.error || `${detail.display_name}: ${chipLabel}`}
              >
                <IntegrationIcon slug={detail.icon ?? detail.slug} size={10} />
                {detail.display_name}
                {chipIcon}
              </span>
            );
          })}
        </div>
      )}

      {/* Tool chips (for agents without required_integrations, show what tools they use) */}
      {!hasIntegrations && userTools.length > 0 && !isVariantAlt && (
        <div className="flex items-center gap-1 flex-wrap">
          {userTools.slice(0, 4).map((tool) => (
            <span
              key={tool.name}
              className="inline-flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded-full bg-gray-100 text-ink-3 font-mono"
              title={tool.credential ? `Requires: ${tool.credential}` : "No auth required"}
            >
              {tool.credential && <IntegrationIcon slug={tool.credential} size={8} />}
              {tool.name.replace(/_/g, " ")}
            </span>
          ))}
          {userTools.length > 4 && (
            <span className="text-[8px] text-ink-3">+{userTools.length - 4}</span>
          )}
        </div>
      )}

      {/* Live streaming preview for running nodes */}
      {livePreview && status === "running" && !isVariantAlt && (
        <div className="text-[10px] text-blue-500 italic truncate w-full mt-0.5">
          {truncate(livePreview, 60)}
          <span className="inline-block w-1.5 h-3 bg-blue-400 animate-pulse ml-0.5 align-middle" />
        </div>
      )}

      {/* Summary for completed nodes */}
      {status === "passed" && !isVariantAlt && (() => {
        const out = node.output as Record<string, unknown> | null;
        const summary = out?.summary;
        return summary ? (
          <div className="text-[10px] text-green-600 truncate w-full mt-0.5">
            {truncate(String(summary), 80)}
          </div>
        ) : null;
      })()}

      {/* Action title for awaiting_reply nodes */}
      {status === "awaiting_reply" && !isVariantAlt && (() => {
        const out = node.output as Record<string, unknown> | null;
        const actionTitle = out?.action_title;
        return actionTitle ? (
          <div className="text-[10px] text-amber-600 truncate w-full mt-0.5 font-medium">
            {"\u23F8"} {truncate(String(actionTitle), 60)}
          </div>
        ) : null;
      })()}

      {/* Error for failed nodes */}
      {status === "failed" && !isVariantAlt && (() => {
        const out = node.output as Record<string, unknown> | null;
        const errMsg = node.judge_feedback || (out?.error ? String(out.error) : "");
        return errMsg ? (
          <div className="text-[10px] text-red-500 truncate w-full mt-0.5">
            {truncate(errMsg, 80)}
          </div>
        ) : null;
      })()}

      {/* Artifact links */}
      {(node.artifacts?.length ?? 0) > 0 && (status === "passed" || status === "failed") && !isVariantAlt && (
        <div className="flex items-center gap-1 flex-wrap mt-1">
          {node.artifacts!.slice(0, 3).map((a, idx) => (
            <a key={idx} href={a.url} target="_blank" rel="noopener noreferrer"
               onClick={e => e.stopPropagation()}
               className="inline-flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors font-medium"
               title={a.url}>
              <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
              {truncate(a.title, 20)}
            </a>
          ))}
          {(node.artifacts?.length ?? 0) > 3 && (
            <span className="text-[8px] text-ink-3">+{node.artifacts!.length - 3}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs opacity-70">
        <span className="capitalize">{isVariantAlt ? "alternative" : status}</span>
        {status === "running" && node.started_at && (
          <ElapsedTimer startedAt={node.started_at} />
        )}
        {score && (
          <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-[10px] font-mono">
            {score}/10
          </span>
        )}
        {userTools.length > 0 && !hasIntegrations && (
          <span className="text-[10px] text-ink-3">
            {userTools.length} tool{userTools.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
    </button>
  );
}

type DagNode = {
  node: ExecutionNode;
  children: DagNode[];
};

function parseRequires(requires: string[] | string | null): string[] {
  if (!requires) return [];
  if (Array.isArray(requires)) return requires;
  if (typeof requires === "string") {
    try {
      const parsed = JSON.parse(requires);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function buildDag(nodes: ExecutionNode[]) {
  const byId = new Map<string, ExecutionNode>();
  for (const n of nodes) byId.set(n.id, n);

  const childrenOf = new Map<string, ExecutionNode[]>();
  const topLevel: ExecutionNode[] = [];

  for (const n of nodes) {
    if (n.parent_uid && byId.has(n.parent_uid)) {
      const list = childrenOf.get(n.parent_uid) ?? [];
      list.push(n);
      childrenOf.set(n.parent_uid, list);
    } else {
      topLevel.push(n);
    }
  }

  const requiresMap = new Map<string, string[]>();
  for (const n of topLevel) {
    const reqs = parseRequires(n.requires);
    if (reqs.length > 0) requiresMap.set(n.id, reqs);
  }

  const inDegree = new Map<string, number>();
  for (const n of topLevel) inDegree.set(n.id, 0);
  for (const [uid, reqs] of requiresMap) {
    inDegree.set(
      uid,
      reqs.filter((r) => topLevel.some((t) => t.id === r)).length
    );
  }

  const layers: ExecutionNode[][] = [];
  const assigned = new Set<string>();

  while (assigned.size < topLevel.length) {
    const layer: ExecutionNode[] = [];
    for (const n of topLevel) {
      if (!assigned.has(n.id) && (inDegree.get(n.id) ?? 0) === 0)
        layer.push(n);
    }
    if (layer.length === 0) break;
    layers.push(layer);
    for (const n of layer) {
      assigned.add(n.id);
      for (const [uid, reqs] of requiresMap) {
        if (reqs.includes(n.id))
          inDegree.set(uid, (inDegree.get(uid) ?? 1) - 1);
      }
    }
  }

  const edges: Array<{ from: string; to: string }> = [];
  for (const [uid, reqs] of requiresMap) {
    for (const req of reqs) {
      if (topLevel.some((t) => t.id === req))
        edges.push({ from: req, to: uid });
    }
  }

  function buildTree(n: ExecutionNode): DagNode {
    const kids = (childrenOf.get(n.id) ?? []).map(buildTree);
    return { node: n, children: kids };
  }

  const dagTrees = new Map<string, DagNode>();
  for (const n of topLevel) dagTrees.set(n.id, buildTree(n));

  return { layers, edges, dagTrees };
}

function ChildTree({
  tree,
  selectedNodeId,
  onNodeClick,
  credentialStatus,
  catalogMap,
  sessionStatus,
  livePreviewMap,
}: {
  tree: DagNode;
  selectedNodeId: string | null;
  onNodeClick?: (id: string) => void;
  credentialStatus?: CredentialStatus | null;
  catalogMap?: CatalogMap;
  sessionStatus?: string;
  livePreviewMap?: Record<string, string>;
}) {
  if (tree.children.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1 mt-1">
      <div className="w-px h-4 bg-purple-300/50" />
      <ArrowDown className="w-3 h-3 text-purple-400 -mt-1.5" />
      <div className="flex items-start gap-3">
        {tree.children.map((child) => (
          <div
            key={child.node.id}
            className="flex flex-col items-center gap-1"
          >
            <div data-node-uid={child.node.id}>
              <NodeBox
                node={child.node}
                isSelected={selectedNodeId === child.node.id}
                isChild
                onClick={() => onNodeClick?.(child.node.id)}
                credInfo={credentialStatus?.agents[child.node.agent_slug]}
                catalogAgent={catalogMap?.[child.node.agent_slug]}
                probeResults={credentialStatus?.probe_results}
                sessionStatus={sessionStatus}
                livePreview={livePreviewMap?.[child.node.id]}
              />
            </div>
            <ChildTree
              tree={child}
              selectedNodeId={selectedNodeId}
              onNodeClick={onNodeClick}
              credentialStatus={credentialStatus}
              catalogMap={catalogMap}
              sessionStatus={sessionStatus}
              livePreviewMap={livePreviewMap}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function DagEdges({
  edges,
  containerRef,
  nodeStatusMap,
}: {
  edges: Array<{ from: string; to: string }>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  nodeStatusMap?: Record<string, string>;
}) {
  const [paths, setPaths] = useState<Array<{ key: string; d: string; active: boolean }>>([]);

  const recalc = useCallback(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const newPaths: Array<{ key: string; d: string; active: boolean }> = [];

    function offsetRelativeTo(el: HTMLElement): {
      x: number;
      y: number;
      w: number;
      h: number;
    } {
      let x = 0,
        y = 0;
      let cur: HTMLElement | null = el;
      while (cur && cur !== container) {
        x += cur.offsetLeft;
        y += cur.offsetTop;
        cur = cur.offsetParent as HTMLElement | null;
      }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    }

    for (const edge of edges) {
      const fromEl = container.querySelector(
        `[data-node-uid="${edge.from}"]`
      ) as HTMLElement | null;
      const toEl = container.querySelector(
        `[data-node-uid="${edge.to}"]`
      ) as HTMLElement | null;
      if (!fromEl || !toEl) continue;

      const from = offsetRelativeTo(fromEl);
      const to = offsetRelativeTo(toEl);

      const x1 = from.x + from.w / 2;
      const y1 = from.y + from.h;
      const x2 = to.x + to.w / 2;
      const y2 = to.y;

      const dy = Math.abs(y2 - y1);
      const cp = Math.max(dy * 0.45, 20);
      const d = `M ${x1} ${y1} C ${x1} ${y1 + cp}, ${x2} ${y2 - cp}, ${x2} ${y2}`;
      const fromStatus = nodeStatusMap?.[edge.from] ?? "";
      const toStatus = nodeStatusMap?.[edge.to] ?? "";
      const active = fromStatus === "passed" && (toStatus === "running" || toStatus === "ready");
      newPaths.push({ key: `${edge.from}-${edge.to}`, d, active });
    }

    setPaths(newPaths);
  }, [edges, containerRef, nodeStatusMap]);

  useLayoutEffect(() => {
    recalc();
    const t1 = setTimeout(recalc, 80);
    const t2 = setTimeout(recalc, 300);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [recalc]);

  if (paths.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none overflow-visible"
      style={{ zIndex: 0 }}
    >
      <defs>
        <marker
          id="dag-arrow"
          markerWidth="10"
          markerHeight="7"
          refX="9"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="rgba(139,92,246,0.5)" />
        </marker>
        <marker
          id="dag-arrow-active"
          markerWidth="10"
          markerHeight="7"
          refX="9"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="rgba(59,130,246,0.8)" />
        </marker>
      </defs>
      <style>{`
        @keyframes flowDash { to { stroke-dashoffset: -20; } }
      `}</style>
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill="none"
          stroke={p.active ? "rgba(59,130,246,0.6)" : "rgba(139,92,246,0.4)"}
          strokeWidth={p.active ? 2.5 : 2}
          strokeDasharray={p.active ? "8 4" : "6 3"}
          markerEnd={p.active ? "url(#dag-arrow-active)" : "url(#dag-arrow)"}
          style={p.active ? { animation: "flowDash 1s linear infinite" } : undefined}
        />
      ))}
    </svg>
  );
}

export const ExecutionCanvas = forwardRef<CanvasHandle, ExecutionCanvasProps>(
  function ExecutionCanvas(
    { nodes, sessionStatus, selectedNodeId, onNodeClick, onZoomChange, credentialStatus, catalogMap, livePreviewMap },
    ref
  ) {
    const transformRef = useRef<ReactZoomPanPinchRef>(null);
    const dagContainerRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      resetTransform: () => transformRef.current?.resetTransform(),
      zoomIn: () => transformRef.current?.zoomIn(),
      zoomOut: () => transformRef.current?.zoomOut(),
    }));

    const { layers, edges, dagTrees } = useMemo(() => buildDag(nodes), [nodes]);
    const nodeStatusMap = useMemo(() => {
      const m: Record<string, string> = {};
      for (const n of nodes) m[n.id] = n.status;
      return m;
    }, [nodes]);

    if (nodes.length === 0) {
      return (
        <div className="flex items-center justify-center h-full text-ink-3 text-sm">
          {sessionStatus === "planning"
            ? "Building plan\u2026"
            : "No nodes in plan"}
        </div>
      );
    }

    return (
      <TransformWrapper
        ref={transformRef}
        initialScale={0.9}
        minScale={0.25}
        maxScale={2.5}
        onInit={(instance) => {
          setTimeout(() => instance.centerView(0.9), 60);
        }}
        onTransformed={(_, state) => {
          onZoomChange?.(state.scale);
        }}
        wheel={{ step: 0.08 }}
        doubleClick={{ disabled: true }}
        panning={{ allowLeftClickPan: true }}
        limitToBounds={false}
      >
        <TransformComponent
          wrapperStyle={{ width: "100%", height: "100%" }}
        >
          <div
            ref={dagContainerRef}
            className="relative flex flex-col items-center p-16 gap-10 min-h-[400px]"
          >
            {layers.map((layer, layerIdx) => (
              <div
                key={layerIdx}
                className="flex items-start justify-center gap-10"
              >
                {layer.map((node) => {
                  const tree = dagTrees.get(node.id);
                  return (
                    <div
                      key={node.id}
                      className="flex flex-col items-center gap-1"
                    >
                      <div data-node-uid={node.id}>
                        <NodeBox
                          node={node}
                          isSelected={selectedNodeId === node.id}
                          isChild={false}
                          onClick={() => onNodeClick?.(node.id)}
                          credInfo={credentialStatus?.agents[node.agent_slug]}
                          catalogAgent={catalogMap?.[node.agent_slug]}
                          probeResults={credentialStatus?.probe_results}
                          sessionStatus={sessionStatus}
                          livePreview={livePreviewMap?.[node.id]}
                        />
                      </div>
                      {tree && (
                        <ChildTree
                          tree={tree}
                          selectedNodeId={selectedNodeId}
                          onNodeClick={onNodeClick}
                          credentialStatus={credentialStatus}
                          catalogMap={catalogMap}
                          sessionStatus={sessionStatus}
                          livePreviewMap={livePreviewMap}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            <DagEdges edges={edges} containerRef={dagContainerRef} nodeStatusMap={nodeStatusMap} />
          </div>
        </TransformComponent>
      </TransformWrapper>
    );
  }
);
