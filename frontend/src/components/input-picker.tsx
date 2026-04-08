"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Loader2, ChevronDown, Hash, Search, Lock, AlertCircle } from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

export interface InputSpec {
  id: string;
  label: string;
  input_type: string;
  required?: boolean;
  description?: string;
  default?: string;
  options?: { value: string; label: string }[];
}

interface InputPickerProps {
  input: InputSpec;
  value: string;
  onChange: (id: string, value: string) => void;
  clientSlug?: string;
}

// ── Main Picker ──────────────────────────────────────────────────────────────

export function InputPicker({ input, value, onChange, clientSlug }: InputPickerProps) {
  switch (input.input_type) {
    case "slack_channel":
      return (
        <SlackChannelPicker
          input={input}
          value={value}
          onChange={onChange}
          clientSlug={clientSlug}
        />
      );
    case "notion_database":
    case "notion_page":
      return (
        <NotionResourcePicker
          input={input}
          value={value}
          onChange={onChange}
          clientSlug={clientSlug}
          resourceType={input.input_type === "notion_database" ? "databases" : "pages"}
        />
      );
    case "select":
      return <SelectPicker input={input} value={value} onChange={onChange} />;
    case "email":
      return <TextInput input={input} value={value} onChange={onChange} type="email" />;
    case "url":
      return <TextInput input={input} value={value} onChange={onChange} type="url" />;
    default:
      return <TextInput input={input} value={value} onChange={onChange} type="text" />;
  }
}

// ── Slack Channel Picker ─────────────────────────────────────────────────────

interface ChannelOption {
  id: string;
  name: string;
  is_private: boolean;
  num_members: number;
  topic: string;
}

function SlackChannelPicker({
  input,
  value,
  onChange,
  clientSlug,
}: InputPickerProps) {
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!clientSlug) return;
    setLoading(true);
    fetch(`/api/clients/${clientSlug}/integrations/slack/channels`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Slack not connected" : `Error ${r.status}`);
        return r.json();
      })
      .then((data) => setChannels(data.channels ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [clientSlug]);

  const filtered = useMemo(() => {
    if (!search) return channels;
    const q = search.toLowerCase();
    return channels.filter(
      (ch) => ch.name.toLowerCase().includes(q) || ch.topic.toLowerCase().includes(q)
    );
  }, [channels, search]);

  const selectedChannel = channels.find((ch) => ch.id === value);

  if (!clientSlug) {
    return (
      <PickerWrapper input={input}>
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <AlertCircle className="w-3 h-3" />
          <span>Select a workspace first to load Slack channels</span>
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(input.id, e.target.value)}
          placeholder="C01ABCDEF"
          className="mt-1.5 w-full text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </PickerWrapper>
    );
  }

  if (error) {
    return (
      <PickerWrapper input={input}>
        <div className="flex items-center gap-2 text-xs text-red-600">
          <AlertCircle className="w-3 h-3" />
          <span>{error} — enter channel ID manually</span>
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(input.id, e.target.value)}
          placeholder="C01ABCDEF"
          className="mt-1.5 w-full text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </PickerWrapper>
    );
  }

  return (
    <PickerWrapper input={input}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between gap-2 text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink hover:border-brand/50 transition-colors"
        >
          {loading ? (
            <span className="flex items-center gap-1.5 text-ink-3">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading channels…
            </span>
          ) : selectedChannel ? (
            <span className="flex items-center gap-1.5">
              {selectedChannel.is_private ? (
                <Lock className="w-3 h-3 text-ink-3" />
              ) : (
                <Hash className="w-3 h-3 text-ink-3" />
              )}
              {selectedChannel.name}
            </span>
          ) : (
            <span className="text-ink-3">Select a channel…</span>
          )}
          <ChevronDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full bg-surface border border-rim rounded-lg shadow-lg max-h-[240px] overflow-hidden">
            <div className="p-1.5 border-b border-rim">
              <div className="flex items-center gap-1.5 px-2 py-1 bg-surface-2 rounded-md">
                <Search className="w-3 h-3 text-ink-3" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search channels…"
                  className="flex-1 text-xs bg-transparent outline-none text-ink placeholder:text-ink-3"
                />
              </div>
            </div>
            <div className="overflow-y-auto max-h-[192px]">
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-ink-3">No channels found</div>
              )}
              {filtered.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => {
                    onChange(input.id, ch.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface-2 transition-colors ${
                    ch.id === value ? "bg-brand/5 text-brand" : "text-ink"
                  }`}
                >
                  {ch.is_private ? (
                    <Lock className="w-3 h-3 text-ink-3 shrink-0" />
                  ) : (
                    <Hash className="w-3 h-3 text-ink-3 shrink-0" />
                  )}
                  <span className="truncate">{ch.name}</span>
                  <span className="ml-auto text-ink-3 shrink-0">
                    {ch.num_members} members
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </PickerWrapper>
  );
}

// ── Notion Resource Picker ───────────────────────────────────────────────────

interface NotionOption {
  id: string;
  title: string;
  url: string;
}

function NotionResourcePicker({
  input,
  value,
  onChange,
  clientSlug,
  resourceType,
}: InputPickerProps & { resourceType: "databases" | "pages" }) {
  const [resources, setResources] = useState<NotionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!clientSlug) return;
    setLoading(true);
    fetch(`/api/clients/${clientSlug}/integrations/notion/${resourceType}`)
      .then((r) => {
        if (!r.ok)
          throw new Error(r.status === 403 ? "Notion not connected" : `Error ${r.status}`);
        return r.json();
      })
      .then((data) => setResources(data[resourceType] ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [clientSlug, resourceType]);

  const filtered = useMemo(() => {
    if (!search) return resources;
    const q = search.toLowerCase();
    return resources.filter((r) => r.title.toLowerCase().includes(q));
  }, [resources, search]);

  const selected = resources.find((r) => r.id === value);

  if (!clientSlug) {
    return (
      <PickerWrapper input={input}>
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <AlertCircle className="w-3 h-3" />
          <span>Select a workspace first to load Notion {resourceType}</span>
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(input.id, e.target.value)}
          placeholder="Paste Notion ID"
          className="mt-1.5 w-full text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </PickerWrapper>
    );
  }

  if (error) {
    return (
      <PickerWrapper input={input}>
        <div className="flex items-center gap-2 text-xs text-red-600">
          <AlertCircle className="w-3 h-3" />
          <span>{error} — enter ID manually</span>
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(input.id, e.target.value)}
          placeholder="Paste Notion ID"
          className="mt-1.5 w-full text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </PickerWrapper>
    );
  }

  return (
    <PickerWrapper input={input}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between gap-2 text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink hover:border-brand/50 transition-colors"
        >
          {loading ? (
            <span className="flex items-center gap-1.5 text-ink-3">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
            </span>
          ) : selected ? (
            <span className="truncate">{selected.title}</span>
          ) : (
            <span className="text-ink-3">
              Select a {resourceType === "databases" ? "database" : "page"}…
            </span>
          )}
          <ChevronDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full bg-surface border border-rim rounded-lg shadow-lg max-h-[240px] overflow-hidden">
            <div className="p-1.5 border-b border-rim">
              <div className="flex items-center gap-1.5 px-2 py-1 bg-surface-2 rounded-md">
                <Search className="w-3 h-3 text-ink-3" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${resourceType}…`}
                  className="flex-1 text-xs bg-transparent outline-none text-ink placeholder:text-ink-3"
                />
              </div>
            </div>
            <div className="overflow-y-auto max-h-[192px]">
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-ink-3">
                  No {resourceType} found. Make sure they are shared with the Notion integration.
                </div>
              )}
              {filtered.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    onChange(input.id, r.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface-2 transition-colors ${
                    r.id === value ? "bg-brand/5 text-brand" : "text-ink"
                  }`}
                >
                  <span className="truncate">{r.title || "Untitled"}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </PickerWrapper>
  );
}

// ── Select Picker ────────────────────────────────────────────────────────────

function SelectPicker({ input, value, onChange }: Omit<InputPickerProps, "clientSlug">) {
  return (
    <PickerWrapper input={input}>
      <select
        value={value}
        onChange={(e) => onChange(input.id, e.target.value)}
        className="w-full text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand"
      >
        <option value="">Select…</option>
        {(input.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </PickerWrapper>
  );
}

// ── Text Input ───────────────────────────────────────────────────────────────

function TextInput({
  input,
  value,
  onChange,
  type,
}: Omit<InputPickerProps, "clientSlug"> & { type: string }) {
  return (
    <PickerWrapper input={input}>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(input.id, e.target.value)}
        placeholder={input.description || `Enter ${input.label.toLowerCase()}`}
        className="w-full text-sm border border-rim rounded-md px-2.5 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand"
      />
    </PickerWrapper>
  );
}

// ── Shared Wrapper ───────────────────────────────────────────────────────────

function PickerWrapper({
  input,
  children,
}: {
  input: InputSpec;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1 text-xs font-medium text-ink">
        {input.label}
        {input.required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {input.description && (
        <p className="text-[11px] text-ink-3 leading-relaxed">{input.description}</p>
      )}
    </div>
  );
}

// ── Inputs Section (container for multiple pickers with submit) ──────────────

interface InputsSectionProps {
  section: {
    title: string;
    inputs?: InputSpec[];
  };
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  clientSlug?: string;
  disabled?: boolean;
}

export function InputsSection({ section, onSubmit, clientSlug, disabled }: InputsSectionProps) {
  const inputs = section.inputs ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const inp of inputs) {
      init[inp.id] = inp.default ?? "";
    }
    return init;
  });
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleChange = useCallback((id: string, val: string) => {
    setValues((prev) => ({ ...prev, [id]: val }));
  }, []);

  const allRequiredFilled = inputs
    .filter((inp) => inp.required)
    .every((inp) => (values[inp.id] ?? "").trim() !== "");

  const handleSubmit = useCallback(async () => {
    if (!allRequiredFilled || submitted || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(values);
      setSubmitted(true);
    } catch {
      setSubmitError("Failed to submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [allRequiredFilled, submitted, submitting, onSubmit, values]);

  if (inputs.length === 0) return null;

  return (
    <div className="border-t border-amber-200 px-4 py-3 space-y-3">
      <div className="text-xs font-medium text-amber-800">{section.title}</div>
      {inputs.map((inp) => (
        <InputPicker
          key={inp.id}
          input={inp}
          value={values[inp.id] ?? ""}
          onChange={handleChange}
          clientSlug={clientSlug}
        />
      ))}
      {submitError && (
        <div className="flex items-center gap-2 text-xs text-red-600">
          <AlertCircle className="w-3 h-3" />
          <span>{submitError}</span>
        </div>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!allRequiredFilled || submitted || submitting || disabled}
        className="w-full py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-40 transition-colors"
      >
        {submitted ? "Submitted" : submitting ? "Submitting…" : "Submit"}
      </button>
    </div>
  );
}
