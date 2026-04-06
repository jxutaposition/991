"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Loader2 } from "lucide-react";

const DEMO_STEPS = [
  { time: 0, url: "/sales-nav/search", label: "Opening Sales Navigator", highlight: null },
  { time: 3, url: null, label: "Filtering: Financial Technology", highlight: 'button:nth-child(1)' },
  { time: 5, url: null, label: "Filtering: 51-200 employees", highlight: 'button:nth-child(2)' },
  { time: 7, url: null, label: "Filtering: Series A, B", highlight: 'button:nth-child(4)' },
  { time: 10, url: "/sales-nav/profile/sarah-chen", label: "Viewing Sarah Chen's profile", highlight: null },
  { time: 14, url: null, label: "Saving lead to list", highlight: '.save-lead-btn' },
  { time: 16, url: null, label: "Copying email address", highlight: '.copy-email-btn' },
  { time: 19, url: "/crunchbase/finflow", label: "Researching FinFlow on Crunchbase", highlight: null },
  { time: 23, url: null, label: "Reviewing Series B funding", highlight: '.funding-amount' },
  { time: 26, url: "/gmail/compose", label: "Composing cold email", highlight: null },
  { time: 30, url: null, label: "Drafting personalized email", highlight: '.send-btn' },
  { time: 33, url: null, label: "Email sent. Waiting for extraction...", highlight: null },
];

export function ScriptedDemo({
  isRunning,
}: {
  sessionId: string | null;
  isRunning: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentStep, setCurrentStep] = useState(-1);
  const [, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  // Drive the animation when running
  useEffect(() => {
    if (!isRunning) {
      setCurrentStep(-1);
      setElapsed(0);
      startTimeRef.current = null;
      return;
    }

    startTimeRef.current = Date.now();

    const interval = setInterval(() => {
      if (!startTimeRef.current) return;
      const secs = (Date.now() - startTimeRef.current) / 1000;
      setElapsed(secs);

      // Find current step
      let step = -1;
      for (let i = DEMO_STEPS.length - 1; i >= 0; i--) {
        if (secs >= DEMO_STEPS[i].time) {
          step = i;
          break;
        }
      }
      setCurrentStep(step);

      // Navigate iframe
      if (step >= 0 && DEMO_STEPS[step].url) {
        const iframe = iframeRef.current;
        if (iframe) {
          const newUrl = `/mock-gtm${DEMO_STEPS[step].url}`;
          try {
            if (iframe.contentWindow?.location.href !== newUrl) {
              iframe.src = newUrl;
            }
          } catch {
            iframe.src = newUrl;
          }
        }
      }

      // Send highlight command
      if (step >= 0 && DEMO_STEPS[step].highlight) {
        try {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "highlight", selector: DEMO_STEPS[step].highlight },
            "*"
          );
        } catch { /* cross-origin */ }
      }
    }, 500);

    return () => clearInterval(interval);
  }, [isRunning]);

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Step progress */}
      <div className="px-4 py-3 border-b border-rim shrink-0 bg-page">
        <div className="flex items-center gap-2 mb-2">
          {isRunning ? (
            <Loader2 className="w-3.5 h-3.5 text-brand animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5 text-ink-3" />
          )}
          <span className="text-xs font-medium text-ink">
            {isRunning
              ? currentStep >= 0
                ? DEMO_STEPS[currentStep].label
                : "Starting..."
              : "Click 'Start Demo' to begin"}
          </span>
        </div>
        {isRunning && (
          <div className="flex gap-1">
            {DEMO_STEPS.map((step, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= currentStep
                    ? "bg-brand"
                    : "bg-rim"
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Mock page iframe */}
      <div className="flex-1 relative">
        <iframe
          ref={iframeRef}
          src="/mock-gtm/sales-nav/search"
          className="w-full h-full border-0"
          title="Mock GTM Page"
        />
        {!isRunning && (
          <div className="absolute inset-0 bg-black/5 flex items-center justify-center">
            <div className="text-center text-ink-3">
              <Play className="w-12 h-12 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Ready to demo</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
