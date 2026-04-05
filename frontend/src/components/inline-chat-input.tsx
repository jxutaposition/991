"use client";

import { useState } from "react";
import { Send, X, Loader2 } from "lucide-react";

interface InlineChatInputProps {
  onSubmit: (instruction: string) => Promise<string>;
  onCancel: () => void;
  position?: { top: number; left: number };
}

export function InlineChatInput({ onSubmit, onCancel, position }: InlineChatInputProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!input.trim() || loading) return;
    setLoading(true);
    try {
      const response = await onSubmit(input.trim());
      setResult(response);
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="absolute z-50 w-80 bg-white border border-rim rounded-lg shadow-lg overflow-hidden"
      style={position ? { top: position.top, left: position.left } : undefined}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border-b border-rim">
        <span className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider flex-1">
          Edit with AI
        </span>
        <button onClick={onCancel} className="text-ink-3 hover:text-ink">
          <X className="w-3 h-3" />
        </button>
      </div>

      {result === null ? (
        <div className="p-2">
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="How should this change?"
              className="flex-1 text-xs border border-rim rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand"
              disabled={loading}
            />
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || loading}
              className="p-1.5 rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-40"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      ) : (
        <div className="p-2">
          <div className="text-xs text-ink bg-gray-50 rounded p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">
            {result}
          </div>
          <div className="flex gap-1.5 mt-2 justify-end">
            <button
              onClick={onCancel}
              className="text-xs px-2 py-1 rounded border border-rim text-ink-3 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
