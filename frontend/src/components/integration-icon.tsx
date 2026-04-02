"use client";

import { Globe, Zap, Search, Database, BookOpen, BarChart3, Megaphone, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const ICON_COLORS: Record<string, string> = {
  notion: "#000000",
  hubspot: "#FF7A59",
  clay: "#6C5CE7",
  n8n: "#EA4B71",
  supabase: "#3ECF8E",
  tolt: "#2563EB",
  tavily: "#F59E0B",
  meta: "#0668E1",
  google_ads: "#4285F4",
};

const ICON_LABELS: Record<string, string> = {
  notion: "N",
  hubspot: "H",
  clay: "C",
  n8n: "n8n",
  supabase: "S",
  tolt: "T",
  tavily: "Tv",
  meta: "M",
  google_ads: "G",
  http: "",
  generic: "",
};

const LUCIDE_FALLBACK: Record<string, LucideIcon> = {
  http: Globe,
  generic: Zap,
  tavily: Search,
  supabase: Database,
  notion: BookOpen,
  hubspot: Users,
  meta: Megaphone,
  google_ads: BarChart3,
};

interface IntegrationIconProps {
  slug: string;
  size?: number;
  className?: string;
}

export function IntegrationIcon({ slug, size = 16, className = "" }: IntegrationIconProps) {
  const color = ICON_COLORS[slug];
  const label = ICON_LABELS[slug];
  const FallbackIcon = LUCIDE_FALLBACK[slug];

  if (!color && FallbackIcon) {
    return <FallbackIcon style={{ width: size, height: size }} className={`text-ink-3 shrink-0 ${className}`} />;
  }

  if (!color) {
    return <Zap style={{ width: size, height: size }} className={`text-ink-3 shrink-0 ${className}`} />;
  }

  if (label && label.length <= 3) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded font-bold text-white shrink-0 ${className}`}
        style={{
          width: size,
          height: size,
          fontSize: size * 0.5,
          backgroundColor: color,
          lineHeight: 1,
        }}
      >
        {label}
      </span>
    );
  }

  if (FallbackIcon) {
    return <FallbackIcon style={{ width: size, height: size, color }} className={`shrink-0 ${className}`} />;
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold text-white shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.55,
        backgroundColor: color,
        lineHeight: 1,
      }}
    >
      {slug.charAt(0).toUpperCase()}
    </span>
  );
}
