"use client";

import { useCallback, useRef, useState } from "react";
import { GripVertical } from "lucide-react";

interface DragResizeLayoutProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Which side has a fixed pixel width */
  fixedSide?: "left" | "right";
  defaultRightWidth?: number;
  defaultLeftWidth?: number;
  minRightWidth?: number;
  minLeftWidth?: number;
  maxRightWidth?: number | string;
  maxLeftWidth?: number | string;
}

export function DragResizeLayout({
  left,
  right,
  fixedSide = "right",
  defaultRightWidth = 380,
  defaultLeftWidth = 420,
  minRightWidth = 240,
  minLeftWidth = 280,
  maxRightWidth = "70%",
  maxLeftWidth = "60%",
}: DragResizeLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const defaultWidth = fixedSide === "left" ? defaultLeftWidth : defaultRightWidth;
  const minWidth = fixedSide === "left" ? minLeftWidth : minRightWidth;
  const maxWidth = fixedSide === "left" ? maxLeftWidth : maxRightWidth;

  const [fixedWidth, setFixedWidth] = useState(defaultWidth);
  const [isDragging, setIsDragging] = useState(false);

  const getMaxWidth = useCallback(() => {
    if (!containerRef.current) return 9999;
    const containerWidth = containerRef.current.offsetWidth;
    if (typeof maxWidth === "number") return maxWidth;
    if (typeof maxWidth === "string" && maxWidth.endsWith("%")) {
      return (containerWidth * parseFloat(maxWidth)) / 100;
    }
    return containerWidth * 0.7;
  }, [maxWidth]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);

      const startX = e.clientX;
      const startWidth = fixedWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = fixedSide === "left"
          ? moveEvent.clientX - startX
          : startX - moveEvent.clientX;
        const newWidth = Math.max(
          minWidth,
          Math.min(getMaxWidth(), startWidth + delta)
        );
        setFixedWidth(newWidth);
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
    [fixedWidth, minWidth, getMaxWidth, fixedSide]
  );

  const dragHandle = (
    <div
      onMouseDown={handleMouseDown}
      className={`relative flex items-center justify-center w-2 cursor-col-resize shrink-0 group
        ${isDragging ? "bg-brand/20" : "hover:bg-brand/10"}
        transition-colors`}
    >
      <div className="z-10 flex h-8 w-4 items-center justify-center rounded-sm border border-rim bg-surface shadow-sm group-hover:border-brand/40 transition-colors">
        <GripVertical className="h-3.5 w-3.5 text-ink-3 group-hover:text-brand transition-colors" />
      </div>
      <div className="absolute inset-y-0 -left-2 -right-2" />
    </div>
  );

  return (
    <div ref={containerRef} className="flex flex-1 overflow-hidden h-full">
      {fixedSide === "left" ? (
        <>
          <div className="shrink-0 overflow-hidden" style={{ width: fixedWidth }}>{left}</div>
          {dragHandle}
          <div className="flex-1 min-w-0 overflow-hidden">{right}</div>
        </>
      ) : (
        <>
          <div className="flex-1 min-w-0 overflow-hidden">{left}</div>
          {dragHandle}
          <div className="shrink-0 overflow-hidden" style={{ width: fixedWidth }}>{right}</div>
        </>
      )}
    </div>
  );
}
