"use client";

import { Check, X } from "lucide-react";

interface DiffPreviewProps {
  original: string;
  proposed: string;
  onAccept: () => void;
  onReject: () => void;
}

export function DiffPreview({ original, proposed, onAccept, onReject }: DiffPreviewProps) {
  // Simple line-by-line diff
  const origLines = original.split("\n");
  const propLines = proposed.split("\n");

  const maxLines = Math.max(origLines.length, propLines.length);
  const diffLines: Array<{ type: "same" | "removed" | "added"; content: string }> = [];

  for (let i = 0; i < maxLines; i++) {
    const orig = origLines[i];
    const prop = propLines[i];
    if (orig === prop) {
      if (orig !== undefined) diffLines.push({ type: "same", content: orig });
    } else {
      if (orig !== undefined) diffLines.push({ type: "removed", content: orig });
      if (prop !== undefined) diffLines.push({ type: "added", content: prop });
    }
  }

  return (
    <div className="border border-rim rounded-lg overflow-hidden">
      <div className="bg-gray-50 px-3 py-1.5 border-b border-rim flex items-center justify-between">
        <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
          Proposed Changes
        </span>
        <div className="flex gap-1">
          <button
            onClick={onAccept}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-500 text-white hover:bg-green-600"
          >
            <Check className="w-3 h-3" /> Accept
          </button>
          <button
            onClick={onReject}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-500 text-white hover:bg-red-600"
          >
            <X className="w-3 h-3" /> Reject
          </button>
        </div>
      </div>
      <div className="p-2 text-xs font-mono max-h-60 overflow-y-auto">
        {diffLines.map((line, i) => (
          <div
            key={i}
            className={`px-2 py-0.5 ${
              line.type === "removed"
                ? "bg-red-50 text-red-700 line-through"
                : line.type === "added"
                ? "bg-green-50 text-green-700"
                : "text-ink-2"
            }`}
          >
            <span className="text-ink-3 mr-2 select-none">
              {line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}
            </span>
            {line.content}
          </div>
        ))}
      </div>
    </div>
  );
}
