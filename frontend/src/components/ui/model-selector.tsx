"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Info, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { MODEL_COST_LABEL, MODEL_COST_COLOR } from "@/lib/tokens";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  cost?: string;       // "low" | "medium" | "high" | "very_high"
  provider?: string;   // e.g. "anthropic", "openai"
}

export interface ModelSelectorProps {
  /** Available models to choose from. */
  models: ModelOption[];
  /** Currently selected model id. */
  value: string;
  /** Callback when a model is selected. */
  onChange: (id: string) => void;
  /** The default model id — shown with a "Default" label. */
  defaultModel?: string;
  /** Optional label above the trigger. */
  label?: string;
  /** Menu opens upward instead of downward. */
  openUpward?: boolean;
  /** Additional className for the root wrapper. */
  className?: string;
  /** Render as compact inline button (no label row). */
  compact?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Provider icon — small colored dot per provider                     */
/* ------------------------------------------------------------------ */

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-[#d97757]",
  openai:    "bg-[#10a37f]",
  google:    "bg-[#4285f4]",
  xai:       "bg-[#1d9bf0]",
};

function ProviderDot({ provider }: { provider?: string }) {
  const color = PROVIDER_COLORS[provider ?? ""] ?? "bg-ink-3";
  return (
    <span
      className={cn("w-6 h-6 rounded-full flex items-center justify-center shrink-0", color)}
    >
      <Sparkles className="w-3 h-3 text-white" />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ModelSelector({
  models,
  value,
  onChange,
  defaultModel,
  label = "Model",
  openUpward = false,
  className,
  compact = false,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const selected = models.find((m) => m.id === value);
  const isDefault = value === defaultModel;
  const triggerLabel = isDefault ? "Default" : (selected?.name ?? "Select model");

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {/* Label row */}
      {!compact && label && (
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-xs font-medium text-ink-2">{label}</span>
          <Info className="w-3 h-3 text-ink-3" />
        </div>
      )}

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center justify-between gap-2 w-full rounded-lg border border-rim bg-page text-sm text-ink transition-colors hover:border-rim-strong focus:outline-none focus:ring-1 focus:ring-brand",
          compact ? "px-2.5 py-1 text-[11px]" : "px-3 py-2",
        )}
      >
        <span className="truncate font-medium">{triggerLabel}</span>
        <ChevronDown className={cn("w-4 h-4 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>

      {/* Dropdown menu */}
      {open && (
        <div
          className={cn(
            "absolute left-0 z-50 w-72 bg-page border border-rim rounded-xl shadow-lg py-1 overflow-auto max-h-80",
            openUpward ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {/* Default option */}
          {defaultModel && (
            <button
              type="button"
              onClick={() => { onChange(defaultModel); setOpen(false); }}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface",
                value === defaultModel && "bg-surface",
              )}
            >
              <span className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 bg-ink-3/10">
                <Sparkles className="w-3 h-3 text-ink-2" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink">Default</div>
                <div className="text-xs text-success">Usage Cost: Low</div>
              </div>
              {value === defaultModel && <Check className="w-4 h-4 text-ink shrink-0" />}
            </button>
          )}

          {/* Separator */}
          {defaultModel && <div className="border-t border-rim my-1" />}

          {/* Model list */}
          {models
            .filter((m) => !defaultModel || m.id !== defaultModel)
            .map((m) => {
              const isSelected = m.id === value;
              const costLabel = MODEL_COST_LABEL[m.cost ?? ""] ?? m.cost;
              const costColor = MODEL_COST_COLOR[m.cost ?? ""] ?? "text-ink-3";

              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onChange(m.id); setOpen(false); }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface",
                    isSelected && "bg-surface",
                  )}
                >
                  <ProviderDot provider={m.provider} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">{m.name}</div>
                    {costLabel && (
                      <div className="text-xs">
                        <span className="text-ink-3">Usage Cost: </span>
                        <span className={costColor}>{costLabel}</span>
                      </div>
                    )}
                  </div>
                  {isSelected && <Check className="w-4 h-4 text-ink shrink-0" />}
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
