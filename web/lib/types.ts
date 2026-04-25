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

  // Enriched fields
  portfolio: string[];
  writings: Writing[];
  network_signals: string[];
  testimonials: Testimonial[];
  sector_focus: string[];
  stage_focus: string[];
  check_size?: string;
  thesis_blurb?: string;
  enriched: boolean;
  confidence?: "high" | "medium" | "low";

  // Raw extras
  angel_signal?: string;
  warm_priority?: number;
  sub_bucket?: string;
  firm_partner_role?: string;
};

export type Decision = "keep" | "cut";

export type DecisionMap = Record<string, Decision>;
