"use client";

import { GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof Group>) => (
  <Group
    className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
    {...props}
  />
);

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}) => (
  <Separator
    className={cn(
      "relative flex w-2 items-center justify-center bg-transparent hover:bg-brand/10 active:bg-brand/20 transition-colors cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-6 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand focus-visible:ring-offset-1 data-[panel-group-direction=vertical]:h-2 data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:cursor-row-resize data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-6 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 [&[data-panel-group-direction=vertical]>div]:rotate-90",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-8 w-4 items-center justify-center rounded-sm border border-rim bg-surface shadow-sm">
        <GripVertical className="h-3.5 w-3.5 text-ink-3" />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
