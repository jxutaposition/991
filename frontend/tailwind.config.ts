import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    fontFamily: {
      sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
    },
    extend: {
      colors: {
        page:    "var(--page)",
        surface: "var(--surface)",
        raised:  "var(--raised)",
        rim: {
          DEFAULT: "var(--rim)",
          strong:  "var(--rim-strong)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          2:       "var(--ink-2)",
          3:       "var(--ink-3)",
        },
        brand: {
          DEFAULT: "var(--brand)",
          hover:   "var(--brand-hover)",
          subtle:  "var(--brand-subtle)",
          rim:     "var(--brand-rim)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          subtle:  "var(--danger-subtle)",
          rim:     "var(--danger-rim)",
        },
        success: {
          DEFAULT: "var(--success)",
          subtle:  "var(--success-subtle)",
          rim:     "var(--success-rim)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          subtle:  "var(--warning-subtle)",
          rim:     "var(--warning-rim)",
        },
        info: {
          DEFAULT: "var(--info)",
          subtle:  "var(--info-subtle)",
          rim:     "var(--info-rim)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          subtle:  "var(--muted-subtle)",
          rim:     "var(--muted-rim)",
        },
      },
    },
  },
  plugins: [typography],
} satisfies Config;
