/** Must match backend `ENGAGEMENT_STAGES` validation. */

export const ENGAGEMENT_STAGE_OPTIONS = [
  { value: "initial_discovery", label: "Initial discovery" },
  { value: "proposal_scoping", label: "Proposal / scoping" },
  { value: "onboarded", label: "Onboarded" },
  { value: "offboarded", label: "Offboarded" },
] as const;

export type EngagementStageValue = (typeof ENGAGEMENT_STAGE_OPTIONS)[number]["value"];

export const DEFAULT_ENGAGEMENT_STAGE: EngagementStageValue = "initial_discovery";
