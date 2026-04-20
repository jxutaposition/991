"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  advanceOnboardingStepIfProgress,
  clearOnboardingStorage,
  ONBOARDING_STORAGE,
  pauseOnboardingFlow,
  readKnowledgeSowReady,
  readOnboardingFlowActive,
  readOnboardingStep,
  readSeededExecuteOpened,
  readSuggestedIntegrationsFromStorage,
  setOnboardingActive,
  setOnboardingStep,
} from "@/lib/onboarding-storage";
import { ArrowRight, ChevronLeft, RotateCcw } from "lucide-react";

const STEPS = [
  {
    n: 1,
    short: "Client",
    title: "Add a client",
    body: "Create a client and pick an engagement stage from the sidebar or Settings. That scopes knowledge, credentials, and runs.",
    href: "/settings",
    cta: "Open Settings",
  },
  {
    n: 2,
    short: "SOW",
    title: "Upload contract / SOW",
    body: "Upload your agreement to Knowledge. When processing finishes, we build a suggested execution plan from the document.",
    href: "/knowledge?onboarding=1",
    cta: "Open Knowledge",
  },
  {
    n: 3,
    short: "Tools",
    title: "Connect tools",
    hrefKey: "integrations" as const,
    body: "Link the integrations your agents need. Matching cards are highlighted when we inferred tools from your SOW.",
    cta: "Open Integrations",
  },
  {
    n: 4,
    short: "Activate",
    title: "Activate the plan",
    hrefKey: "execute" as const,
    body: "Open your seeded session, review the node graph, then use Activate to start and send the onboarding prompt to chat.",
    cta: "Open Execute",
  },
] as const;

export default function OnboardingPage() {
  const { activeClient, token, clients, refreshClients } = useAuth();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [integrationsHref, setIntegrationsHref] = useState("/integrations");
  const [flowActive, setFlowActive] = useState(false);
  const [step, setStep] = useState(1);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const resetMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshFromStorage = useCallback(() => {
    if (typeof window === "undefined") return;
    const sid = sessionStorage.getItem(ONBOARDING_STORAGE.SESSION_ID);
    setSessionId(sid);
    const active = readOnboardingFlowActive();
    setFlowActive(active);
    let displayStep = readOnboardingStep();
    if (active) {
      const next = advanceOnboardingStepIfProgress(
        true,
        clients.length,
        sid,
        readSeededExecuteOpened(),
        readKnowledgeSowReady()
      );
      if (next !== null) displayStep = next;
    }
    setStep(displayStep);
    const slugs = readSuggestedIntegrationsFromStorage();
    if (slugs.length > 0) {
      setIntegrationsHref(
        `/integrations?highlight=${encodeURIComponent(slugs.join(","))}`
      );
    } else {
      setIntegrationsHref("/integrations");
    }
  }, [clients.length]);

  useLayoutEffect(() => {
    refreshFromStorage();
  }, [activeClient, refreshFromStorage]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshClients();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshClients]);

  const flashResetMessage = useCallback((text: string) => {
    if (resetMsgTimer.current) clearTimeout(resetMsgTimer.current);
    setResetMessage(text);
    resetMsgTimer.current = setTimeout(() => {
      setResetMessage(null);
      resetMsgTimer.current = null;
    }, 5000);
  }, []);

  const begin = useCallback(() => {
    setOnboardingActive("1");
    setFlowActive(true);
    setStep(1);
    setResetMessage(null);
    if (resetMsgTimer.current) {
      clearTimeout(resetMsgTimer.current);
      resetMsgTimer.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    pauseOnboardingFlow();
    setFlowActive(false);
    setStep(1);
  }, []);

  const reset = useCallback(() => {
    clearOnboardingStorage();
    setSessionId(null);
    setFlowActive(false);
    setStep(1);
    setIntegrationsHref("/integrations");
    flashResetMessage("Onboarding was reset. Stored session and hints in this browser were cleared.");
  }, [flashResetMessage]);

  const goStep = useCallback(
    (next: number) => {
      if (!flowActive) return;
      const clamped = Math.min(4, Math.max(1, next));
      setOnboardingStep(clamped);
      setStep(clamped);
    },
    [flowActive]
  );

  const stepHref = useCallback(
    (s: (typeof STEPS)[number]) => {
      if ("hrefKey" in s && s.hrefKey === "integrations") return integrationsHref;
      if ("hrefKey" in s && s.hrefKey === "execute") {
        return sessionId ? `/execute/${sessionId}` : "/execute";
      }
      return s.href;
    },
    [integrationsHref, sessionId]
  );

  const current = flowActive ? STEPS[step - 1] : null;
  const progressPct = flowActive ? (step / STEPS.length) * 100 : 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full overflow-hidden bg-page">
      {/* Top: status + all steps (always visible) */}
      <header className="shrink-0 border-b border-rim bg-surface/90 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3">
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-ink tracking-tight">Get started</h1>
            <p className="text-[11px] text-ink-3 mt-0.5">
              {activeClient ? (
                <>
                  Client <span className="font-mono text-ink">{activeClient}</span>
                </>
              ) : (
                "Pick or create a client from the sidebar first."
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full border ${
                flowActive
                  ? "border-brand/40 bg-brand-subtle text-brand"
                  : "border-rim bg-page text-ink-3"
              }`}
            >
              {flowActive ? "In progress" : "Not started"}
            </span>
            {flowActive && (
              <button
                type="button"
                onClick={pause}
                className="rounded-lg border border-rim px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-raised"
              >
                Pause
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1 rounded-lg border border-rim px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-raised"
              title="Clear all onboarding data in this browser tab"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
          </div>
        </div>

        <div className="px-4 sm:px-6 pb-3">
          <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
            {STEPS.map((s) => {
              const isCurrent = flowActive && step === s.n;
              const isPast = flowActive && step > s.n;
              return (
                <button
                  key={s.n}
                  type="button"
                  disabled={!flowActive}
                  onClick={() => goStep(s.n)}
                  className={`rounded-lg border px-1.5 py-2 sm:px-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    isCurrent
                      ? "border-brand bg-brand-subtle ring-1 ring-brand/30"
                      : isPast
                        ? "border-green-200/80 bg-green-50/50 dark:bg-green-950/20 dark:border-green-900"
                        : "border-rim bg-page hover:bg-raised"
                  }`}
                >
                  <span className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide">
                    Step {s.n}
                  </span>
                  <span className="block text-xs sm:text-sm font-semibold text-ink truncate">{s.short}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-rim overflow-hidden">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {resetMessage && (
          <div className="px-4 sm:px-6 pb-2">
            <p className="text-xs font-medium text-green-800 dark:text-green-200 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-lg px-3 py-2">
              {resetMessage}
            </p>
          </div>
        )}
      </header>

      {/* Main area: idle vs active step */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 sm:px-12 py-10 overflow-y-auto">
        {!token && (
          <p className="text-sm text-amber-700 dark:text-amber-400 mb-6 text-center max-w-md">
            <Link href="/login" className="underline font-medium">
              Sign in
            </Link>{" "}
            to create a client and run the flow.
          </p>
        )}

        {flowActive && current ? (
          <div className="w-full max-w-xl text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand mb-2">
              Step {step} of {STEPS.length}
            </p>
            <h2 className="text-2xl sm:text-4xl font-bold text-ink tracking-tight">{current.title}</h2>
            <p className="mt-5 text-sm sm:text-base text-ink-3 leading-relaxed">{current.body}</p>
            <Link
              href={stepHref(current)}
              className="mt-12 inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-10 py-4 text-base font-semibold text-white hover:bg-brand-hover transition-colors w-full sm:w-auto min-w-[240px]"
            >
              {current.cta}
              <ArrowRight className="w-5 h-5" />
            </Link>
            {sessionId && step === 4 && (
              <p className="mt-6 text-xs text-ink-3">
                Seeded session:{" "}
                <Link href={`/execute/${sessionId}`} className="font-mono text-brand hover:underline">
                  {sessionId.slice(0, 8)}…
                </Link>
              </p>
            )}
          </div>
        ) : (
          <div className="w-full max-w-xl text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">Onboarding</p>
            <h2 className="text-2xl sm:text-4xl font-bold text-ink tracking-tight">
              {sessionId ? "You have a saved plan" : "Ready when you are"}
            </h2>
            <p className="mt-5 text-sm sm:text-base text-ink-3 leading-relaxed">
              {sessionId
                ? "A seeded execution session exists in this browser. Start the checklist to walk through integrations and activation, or open it directly."
                : "Start the guided flow to add a client, upload your SOW, connect tools, and activate your plan. Progress stays in this tab until you reset."}
            </p>
            <div className="mt-12 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3">
              <button
                type="button"
                onClick={begin}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-10 py-4 text-base font-semibold text-white hover:bg-brand-hover transition-colors"
              >
                Start onboarding
                <ArrowRight className="w-5 h-5" />
              </button>
              {sessionId && (
                <Link
                  href={`/execute/${sessionId}`}
                  className="inline-flex items-center justify-center rounded-xl border border-rim px-8 py-4 text-sm font-semibold text-ink hover:bg-raised transition-colors"
                >
                  Open seeded session
                </Link>
              )}
            </div>
          </div>
        )}
      </div>

      {flowActive && (
        <footer className="shrink-0 flex items-center justify-between gap-4 px-4 sm:px-6 py-4 border-t border-rim bg-surface/90">
          <button
            type="button"
            disabled={step <= 1}
            onClick={() => goStep(step - 1)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rim px-4 py-2.5 text-sm font-medium text-ink hover:bg-raised disabled:opacity-40 disabled:pointer-events-none"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>
          <p className="text-[11px] text-ink-3 text-center flex-1 hidden sm:block">
            Use the step buttons above to jump between stages.
          </p>
          <button
            type="button"
            disabled={step >= STEPS.length}
            onClick={() => goStep(step + 1)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rim px-4 py-2.5 text-sm font-medium text-ink hover:bg-raised disabled:opacity-40 disabled:pointer-events-none"
          >
            Next
            <ArrowRight className="w-4 h-4" />
          </button>
        </footer>
      )}
    </div>
  );
}
