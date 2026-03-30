"use client";

import { useCallback, useRef, useState } from "react";
import { GripVertical } from "lucide-react";

interface DragResizeLayoutProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Default right panel width in pixels */
  defaultRightWidth?: number;
  /** Minimum right panel width in pixels */
  minRightWidth?: number;
  /** Maximum right panel width — pixels or "70%" style string */
  maxRightWidth?: number | string;
}

export function DragResizeLayout({
  left,
  right,
  defaultRightWidth = 380,
  minRightWidth = 240,
  maxRightWidth = "70%",
}: DragResizeLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rightWidth, setRightWidth] = useState(defaultRightWidth);
  const [isDragging, setIsDragging] = useState(false);

  const getMaxWidth = useCallback(() => {
    if (!containerRef.current) return 9999;
    const containerWidth = containerRef.current.offsetWidth;
    if (typeof maxRightWidth === "number") return maxRightWidth;
    if (typeof maxRightWidth === "string" && maxRightWidth.endsWith("%")) {
      return (containerWidth * parseFloat(maxRightWidth)) / 100;
    }
    return containerWidth * 0.7;
  }, [maxRightWidth]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);

      const startX = e.clientX;
      const startWidth = rightWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        const newWidth = Math.max(
          minRightWidth,
          Math.min(getMaxWidth(), startWidth + delta)
        );
        setRightWidth(newWidth);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [rightWidth, minRightWidth, getMaxWidth]
  );

  return (
    <div ref={containerRef} className="flex flex-1 overflow-hidden h-full">
      {/* Left panel — fills remaining space */}
      <div className="flex-1 min-w-0 overflow-hidden">{left}</div>

      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`relative flex items-center justify-center w-2 cursor-col-resize shrink-0 group
          ${isDragging ? "bg-brand/20" : "hover:bg-brand/10"}
          transition-colors`}
      >
        {/* Visible grab indicator */}
        <div className="z-10 flex h-8 w-4 items-center justify-center rounded-sm border border-rim bg-surface shadow-sm group-hover:border-brand/40 transition-colors">
          <GripVertical className="h-3.5 w-3.5 text-ink-3 group-hover:text-brand transition-colors" />
        </div>
        {/* Extended invisible hit area */}
        <div className="absolute inset-y-0 -left-2 -right-2" />
      </div>

      {/* Right panel — explicit pixel width */}
      <div
        className="shrink-0 overflow-hidden"
        style={{ width: rightWidth }}
      >
        {right}
      </div>
    </div>
  );
}
