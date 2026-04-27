export type Bucket = "warm" | "cold_angel" | "cold_partner";

export type Writing = {
  type: "podcast" | "blog" | "substack" | "tweet" | "talk" | "video" | "article";
  title: string;
  url?: string;
};

export type Testimonial = {
  author: string;
  quote: string;
  source_url?: string;
};

export type Investor = {
  id: string;
  name: string;
  firm: string;
  role: string;
  bucket: Bucket;
  priority_tier: number;
  sf_based: boolean;
  sf_uncertain?: boolean;
  linkedin?: string;
  notes?: string;
  score: number;

  // Enriched fields — INDIVIDUAL to this person
  portfolio: string[];
  writings: Writing[];
  network_signals: string[];
  testimonials: Testimonial[]; // deprecated
  sector_focus: string[];
  stage_focus: string[];
  check_size?: string;
  thesis_blurb?: string;
  co_investors?: string[];
  leads_rounds?: "lead" | "follow" | "both" | "unknown";
  enriched: boolean;
  confidence?: "high" | "medium" | "low";

  // Raw extras
  angel_signal?: string;
  warm_priority?: number;
  sub_bucket?: string;
  firm_partner_role?: string;

  // Firm AUM and metadata (from vc_top_targets.csv)
  aum_usd?: number;
  firm_stages?: string;
  firm_website?: string;

  // LinkedIn connection signal (from your 1st-degree network)
  connection_degree?: "1st" | "2nd";
  connection_via?: { name: string; occupation: string }[];

  israeli?: boolean;
};

export type Decision = "keep" | "cut" | "skip" | "more";

export type DecisionMap = Record<string, Decision>;
