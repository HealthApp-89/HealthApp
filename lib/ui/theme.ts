// Design tokens for the soft-light redesign.
// All colors light-theme calibrated. Kept as plain constants so they can be
// imported by both server and client components without bundler tax.

import type { DailyLogKey } from "./colors";

export const COLOR = {
  // Surfaces
  bg:         "#f1f2f6",  // page background — soft off-white-blue
  surface:    "#ffffff",  // cards, nav bar
  surfaceAlt: "#f5f6fa",  // input fields, inactive pills, sub-rows

  // Content
  textStrong: "#0f1430",  // primary text, big numbers
  textMid:    "#4a4d62",  // body text
  textMuted:  "#7a7e95",  // labels, secondary text
  textFaint:  "#9094a8",  // helper text, axis labels

  // Accent
  accent:     "#4f5dff",
  accentSoft: "#e7eaff",
  accentDeep: "#3a47e8",

  // Semantic
  success:     "#14b870",
  successSoft: "#d1fae5",
  warning:     "#f59e0b",
  warningSoft: "#fef3c7",
  danger:      "#ef4444",
  dangerSoft:  "#fee2e2",

  divider:    "#e8eaf3",
} as const;

export const RADIUS = {
  chip:      "6px",
  pill:      "10px",
  input:     "10px",
  cardSmall: "14px",  // sub-cards nested inside sections
  cardMid:   "16px",  // compact cards (/trends, /strength compact metric stack)
  card:      "20px",  // standard cards (dashboard, /log)
  cardHero:  "24px",  // readiness, /strength volume hero
  full:      "9999px",
} as const;

export const SHADOW = {
  card:       "0 2px 8px rgba(20,30,80,0.05)",
  cardHover:  "0 4px 12px rgba(20,30,80,0.08)",
  heroAccent: "0 12px 28px -8px rgba(79,93,255,0.4)",
  heroAmber:  "0 12px 24px -8px rgba(180,83,9,0.4)",
  bottomNav:  "0 4px 14px rgba(20,30,80,0.08)",
  fab:        "0 8px 20px -4px rgba(79,93,255,0.5)",
  floating:   "0 30px 60px -20px rgba(20,30,80,0.18)",
} as const;

// Per-metric line/icon colors. Light-theme calibrated.
// Keys must mirror DailyLogKey union from lib/ui/colors.ts.
export const METRIC_COLOR: Record<DailyLogKey, string> = {
  hrv:              "#e11d48", // rose
  resting_hr:       "#f97316", // orange
  spo2:             "#06b6d4", // cyan
  skin_temp_c:      "#ea580c", // orange-deep
  sleep_hours:      "#4f5dff", // indigo (= accent)
  sleep_score:      "#4f5dff",
  deep_sleep_hours: "#2563eb", // blue
  rem_sleep_hours:  "#a855f7", // violet
  strain:           "#b45309", // amber
  steps:            "#14b870", // emerald
  calories:         "#ca8a04", // mustard
  weight_kg:        "#8b5cf6", // purple
  body_fat_pct:     "#ea580c", // orange-deep
};

/**
 * Map an existing IntensityMode.color (dark-theme calibrated) to its
 * light-theme equivalent. Pure function — keeps lib/coach/readiness.ts
 * untouched so coach logic stays a pure module.
 */
export function modeColorLight(hex: string): string {
  switch (hex) {
    case "#30d158": return COLOR.success;       // ⚡ PUSH HARD
    case "#86efac": return "#34d399";           // 🟢 FULL SESSION
    case "#ffd60a": return COLOR.warning;       // 🟡 MODERATE
    case "#ff453a": return COLOR.danger;        // 🔴 LIGHT / RECOVERY
    case "#6b7280": return COLOR.textMuted;     // ⚫ REST DAY
    default:        return COLOR.accent;        // unknown — fall back to accent
  }
}
