"use client";

import { Plus, Minus, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CanvasToolbarProps {
  zoomLevel: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;
}

export function CanvasToolbar({
  zoomLevel,
  onZoomIn,
  onZoomOut,
  onFitToScreen,
}: CanvasToolbarProps) {
  return (
    <TooltipProvider>
      <div className="absolute left-4 top-4 z-20 flex flex-col gap-1 bg-page border border-rim rounded-xl p-1.5 shadow-md">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              onClick={onZoomIn}
              className="w-8 h-8 p-0"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Zoom In</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              onClick={onZoomOut}
              className="w-8 h-8 p-0"
            >
              <Minus className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Zoom Out</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              onClick={onFitToScreen}
              className="w-8 h-8 p-0"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Fit to Screen</TooltipContent>
        </Tooltip>

        <div className="h-px bg-rim my-0.5" />

        <div className="px-1 py-0.5 text-xs text-ink-3 text-center font-mono">
          {Math.round(zoomLevel * 100)}%
        </div>
      </div>
    </TooltipProvider>
  );
}
