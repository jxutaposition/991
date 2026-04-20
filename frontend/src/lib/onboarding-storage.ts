/** Session keys for guided client onboarding (SOW → integrations → execute). */

export const ONBOARDING_STORAGE = {
  ACTIVE: "lele_onboarding_active",
  STEP: "lele_onboarding_step",
  SESSION_ID: "lele_onboarding_session_id",
  SUGGESTED_INTEGRATIONS: "lele_onboarding_suggested_integrations",
  MENTIONS_CLAY: "lele_onboarding_mentions_clay",
  /** Set when user opens the seeded session on Execute while onboarding is active. */
  SEEDED_EXECUTE_OPENED: "lele_onboarding_seeded_execute_opened",
  /** Set when at least one Knowledge doc finished processing (SOW step done) even if seed-session API failed. */
  KNOWLEDGE_SOW_READY: "lele_onboarding_sow_ready",
} as const;

/**
 * First incomplete wizard step (1–4) from durable progress signals.
 * Does not read the stored STEP — use with {@link readOnboardingStep} to advance only when this is greater.
 */
export function computeRecommendedOnboardingStep(
  clientsLength: number,
  sessionId: string | null,
  seededExecuteOpened: boolean,
  knowledgeSowReady: boolean
): number {
  if (clientsLength < 1) return 1;
  const pastSowStep = Boolean(sessionId) || knowledgeSowReady;
  if (!pastSowStep) return 2;
  if (seededExecuteOpened) return 4;
  return 3;
}

/** If flow is active and stored step lags behind progress, bump STEP in sessionStorage and return the new step; otherwise null. */
export function advanceOnboardingStepIfProgress(
  flowActive: boolean,
  clientsLength: number,
  sessionId: string | null,
  seededExecuteOpened: boolean,
  knowledgeSowReady: boolean
): number | null {
  if (typeof window === "undefined" || !flowActive) return null;
  const recommended = computeRecommendedOnboardingStep(
    clientsLength,
    sessionId,
    seededExecuteOpened,
    knowledgeSowReady
  );
  const current = readOnboardingStep();
  if (recommended > current) {
    setOnboardingStep(recommended);
    return recommended;
  }
  return null;
}

export function readSeededExecuteOpened(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(ONBOARDING_STORAGE.SEEDED_EXECUTE_OPENED) === "1";
}

export function markSeededExecuteOpened(): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(ONBOARDING_STORAGE.SEEDED_EXECUTE_OPENED, "1");
}

export function readKnowledgeSowReady(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(ONBOARDING_STORAGE.KNOWLEDGE_SOW_READY) === "1";
}

export function markKnowledgeSowReady(): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(ONBOARDING_STORAGE.KNOWLEDGE_SOW_READY, "1");
}

export function clearOnboardingStorage(): void {
  if (typeof window === "undefined") return;
  Object.values(ONBOARDING_STORAGE).forEach((k) => sessionStorage.removeItem(k));
}

export function setOnboardingActive(step: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(ONBOARDING_STORAGE.ACTIVE, "1");
  sessionStorage.setItem(ONBOARDING_STORAGE.STEP, step);
}

/** Whether the user turned on the guided fullscreen flow (this browser tab). */
export function readOnboardingFlowActive(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(ONBOARDING_STORAGE.ACTIVE) === "1";
}

/** Current wizard step 1–4 (defaults to 1). */
export function readOnboardingStep(): number {
  if (typeof window === "undefined") return 1;
  const raw = sessionStorage.getItem(ONBOARDING_STORAGE.STEP);
  const n = parseInt(raw ?? "1", 10);
  return n >= 1 && n <= 4 ? n : 1;
}

export function setOnboardingStep(step: number): void {
  if (typeof window === "undefined") return;
  const clamped = Math.min(4, Math.max(1, Math.floor(step)));
  sessionStorage.setItem(ONBOARDING_STORAGE.STEP, String(clamped));
}

/** Leave fullscreen wizard but keep seeded session / integration hints in sessionStorage. */
export function pauseOnboardingFlow(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(ONBOARDING_STORAGE.ACTIVE);
  sessionStorage.removeItem(ONBOARDING_STORAGE.STEP);
  sessionStorage.removeItem(ONBOARDING_STORAGE.SEEDED_EXECUTE_OPENED);
  sessionStorage.removeItem(ONBOARDING_STORAGE.KNOWLEDGE_SOW_READY);
}

export function readSuggestedIntegrationsFromStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(ONBOARDING_STORAGE.SUGGESTED_INTEGRATIONS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function readOnboardingMentionsClay(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(ONBOARDING_STORAGE.MENTIONS_CLAY) === "1";
}
