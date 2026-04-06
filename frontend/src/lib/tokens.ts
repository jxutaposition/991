/**
 * Centralized color token maps for status badges, pills, and indicators.
 *
 * All status-related styling lives here so that every page renders
 * consistent colors. When adding a new status value, update ONE file.
 *
 * Naming convention for badge classes:
 *   bg-{token}-subtle  text-{token}           — simple badge
 *   bg-{token}-subtle  text-{token}  border-{token}-rim  — bordered pill
 */

/* ------------------------------------------------------------------ */
/*  Session / execution status                                        */
/* ------------------------------------------------------------------ */

/** Badge classes for session-level statuses (planning → completed). */
export const SESSION_STATUS_BADGE: Record<string, string> = {
  awaiting_approval: "bg-warning-subtle text-warning",
  executing:         "bg-info-subtle text-info",
  completed:         "bg-success-subtle text-success",
  failed:            "bg-danger-subtle text-danger",
  planning:          "bg-muted-subtle text-muted",
  cancelled:         "bg-muted-subtle text-muted",
};

/** Bordered pill variant — includes border color for tighter chips. */
export const SESSION_STATUS_PILL: Record<string, string> = {
  awaiting_approval: "bg-warning-subtle text-warning border-warning-rim",
  executing:         "bg-info-subtle text-info border-info-rim",
  completed:         "bg-success-subtle text-success border-success-rim",
  failed:            "bg-danger-subtle text-danger border-danger-rim",
  planning:          "bg-muted-subtle text-muted border-muted-rim",
  cancelled:         "bg-muted-subtle text-muted border-muted-rim",
};

/** Text-only status color (for inline labels, not badges). */
export const SESSION_STATUS_TEXT: Record<string, string> = {
  planning:          "text-muted",
  awaiting_approval: "text-warning",
  executing:         "text-brand",
  completed:         "text-success",
  failed:            "text-danger",
};

/* ------------------------------------------------------------------ */
/*  Node / task execution status (DAG canvas)                         */
/* ------------------------------------------------------------------ */

/** Full node-box styling: background + border + text (+ optional effects). */
export const NODE_STATUS_BOX: Record<string, string> = {
  passed:          "bg-success-subtle border-success-rim text-success",
  running:         "bg-info-subtle border-info text-info shadow-lg shadow-info-subtle ring-1 ring-info-rim",
  ready:           "bg-info-subtle border-info-rim text-info",
  waiting:         "bg-warning-subtle border-warning-rim text-warning",
  failed:          "bg-danger-subtle border-danger text-danger",
  skipped:         "bg-surface border-rim text-ink-3 line-through",
  pending:         "bg-surface border-rim text-ink-3",
  preview:         "bg-purple-50/50 border-dashed border-purple-200 text-purple-400",
  queued:          "bg-muted-subtle border-muted-rim text-muted",
  awaiting_reply:  "bg-warning-subtle border-warning text-warning shadow-lg shadow-warning-subtle",
};

/** Small dot indicator per node status. */
export const NODE_STATUS_DOT: Record<string, string> = {
  passed:          "bg-success",
  running:         "bg-info animate-pulse",
  ready:           "bg-info/70",
  waiting:         "bg-warning",
  failed:          "bg-danger",
  skipped:         "bg-muted-rim",
  pending:         "bg-muted-rim",
  preview:         "bg-purple-300",
  queued:          "bg-muted",
  awaiting_reply:  "bg-warning animate-pulse",
};

/* ------------------------------------------------------------------ */
/*  Issue / error status                                              */
/* ------------------------------------------------------------------ */

export const ISSUE_STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  open:      { bg: "bg-danger-subtle",  border: "border-danger-rim",  text: "text-danger" },
  resolved:  { bg: "bg-success-subtle", border: "border-success-rim", text: "text-success" },
  dismissed: { bg: "bg-muted-subtle",   border: "border-muted-rim",   text: "text-muted" },
};

/* ------------------------------------------------------------------ */
/*  Observation session status                                        */
/* ------------------------------------------------------------------ */

export const OBSERVE_STATUS_BADGE: Record<string, string> = {
  recording: "bg-danger-subtle text-danger",
  completed: "bg-success-subtle text-success",
  flagged:   "bg-warning-subtle text-warning",
  archived:  "bg-surface text-ink-3",
};

/* ------------------------------------------------------------------ */
/*  PR / review status                                                */
/* ------------------------------------------------------------------ */

export const PR_STATUS_BADGE: Record<string, string> = {
  open:        "bg-warning-subtle text-warning",
  approved:    "bg-success-subtle text-success",
  merged:      "bg-purple-100 text-purple-700",
  auto_merged: "bg-purple-100 text-purple-700",
  rejected:    "bg-danger-subtle text-danger",
};

/* ------------------------------------------------------------------ */
/*  Categorical badges (PR types, authorities, scopes, severities)    */
/*  These need distinct hues for visual differentiation, not status.  */
/* ------------------------------------------------------------------ */

export const PR_TYPE_BADGE: Record<string, string> = {
  enhancement:      "bg-info-subtle text-info",
  new_agent:        "bg-success-subtle text-success",
  example_addition: "bg-purple-100 text-purple-700",
  rubric_update:    "bg-warning-subtle text-warning",
  prompt_amendment: "bg-purple-100 text-purple-700",
  reclassification: "bg-warning-subtle text-warning",
};

export const AUTHORITY_BADGE: Record<string, string> = {
  ground_truth:     "bg-success-subtle text-success",
  inferred:         "bg-warning-subtle text-warning",
  user:             "bg-info-subtle text-info",
  automated:        "bg-purple-100 text-purple-700",
  agent_self_report: "bg-muted-subtle text-muted",
};

export const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-danger-subtle text-danger",
  high:     "bg-warning-subtle text-warning",
  medium:   "bg-warning-subtle text-warning",
};

export const SCOPE_BADGE: Record<string, string> = {
  base:    "bg-purple-100 text-purple-700",
  expert:  "bg-purple-100 text-purple-700",
  client:  "bg-info-subtle text-info",
  project: "bg-success-subtle text-success",
};

/* ------------------------------------------------------------------ */
/*  Error category badges (inspector panel)                           */
/* ------------------------------------------------------------------ */

export const ERROR_CATEGORY_BADGE: Record<string, string> = {
  preflight_error:  "bg-warning-subtle text-warning",
  auth_error:       "bg-warning-subtle text-warning",
  validation_error: "bg-danger-subtle text-danger",
  timeout:          "bg-warning-subtle text-warning",
  api_error:        "bg-info-subtle text-info",
  internal_error:   "bg-muted-subtle text-muted",
};

/* ------------------------------------------------------------------ */
/*  Change-source badges (document header)                            */
/* ------------------------------------------------------------------ */

export const CHANGE_SOURCE_BADGE: Record<string, string> = {
  planner:          "bg-purple-50 text-purple-700 border-purple-200",
  user_edit:        "bg-info-subtle text-info border-info-rim",
  chat_agent:       "bg-success-subtle text-success border-success-rim",
  execution_result: "bg-warning-subtle text-warning border-warning-rim",
};

/* ------------------------------------------------------------------ */
/*  Generic result status (catalog runs, test results)                */
/* ------------------------------------------------------------------ */

export const RESULT_STATUS_BADGE: Record<string, string> = {
  passed:  "bg-success-subtle text-success",
  failed:  "bg-danger-subtle text-danger",
  skipped: "bg-warning-subtle text-warning",
  open:    "bg-info-subtle text-info",
};

/* ------------------------------------------------------------------ */
/*  Model cost tiers                                                  */
/* ------------------------------------------------------------------ */

export const MODEL_COST_LABEL: Record<string, string> = {
  low:       "Low",
  medium:    "Medium",
  high:      "High",
  very_high: "Very High",
};

export const MODEL_COST_COLOR: Record<string, string> = {
  low:       "text-success",
  medium:    "text-warning",
  high:      "text-danger",
  very_high: "text-danger",
};

/* ------------------------------------------------------------------ */
/*  Live / polling indicators                                         */
/* ------------------------------------------------------------------ */

export const LIVE_STATUS = {
  active:   "bg-success-subtle text-success",
  inactive: "bg-surface text-ink-3",
  recording: "bg-danger-subtle text-danger",
} as const;
