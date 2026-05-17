// Design tokens for the soft-light redesign.
// All colors light-theme calibrated. Kept as plain constants so they can be
// imported by both server and client components without bundler tax.

import type { DailyLogKey, BodyMeasurementKey } from "./colors";

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
  warningDeep: "#92400e",  // amber-800 — text on warningSoft backgrounds
  danger:      "#ef4444",
  dangerSoft:  "#fee2e2",
  dangerDeep:  "#991b1b",  // red-800 — text on dangerSoft backgrounds

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

export const MEASUREMENT_COLOR: Record<BodyMeasurementKey, string> = {
  waist:  "#0ea5e9", // sky
  hip:    "#8b5cf6", // purple
  chest:  "#10b981", // emerald
  arms:   "#f59e0b", // amber
  thighs: "#ef4444", // rose
  calves: "#06b6d4", // cyan
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

// Hero card gradients — used by MorningBriefCard hero band and the
// intensity-mode-mapped session heroes. Defined once, referenced everywhere.
export const GRADIENT = {
  heroAccent:      "linear-gradient(140deg, #4f5dff 0%, #6b78ff 100%)",
  heroAmber:       "linear-gradient(140deg, #b45309 0%, #d97706 100%)",
  heroSuccess:     "linear-gradient(140deg, #14b870 0%, #34d399 100%)",
  heroSuccessSoft: "linear-gradient(140deg, #34d399 0%, #6ee7b7 100%)",
  heroDanger:      "linear-gradient(140deg, #ef4444 0%, #f87171 100%)",
  heroMuted:       "linear-gradient(140deg, #7a7e95 0%, #9094a8 100%)",
} as const;

// Chat-surface layout constants
export const CHAT = {
  feedMaxWidth:    "640px",   // chat column on desktop
  turnGap:         "12px",
  metaRowHeight:   "16px",
  composerHeight:  "56px",
  composerPad:     "12px",
} as const;

// Muscle-map fills (light theme) — replaces dark-theme hex values in
// MuscleMap/MuscleOverlay/BodyView. Apply via inline style or CSS variable.
export const MUSCLE_COLOR = {
  idle:        "#e8eaf3",   // unworked — matches divider, low contrast
  worked:      "#b45309",   // worked today — METRIC_COLOR.strain (amber)
  workedSoft:  "#fcd34d",   // worked recently (1–3 days)
  highlighted: "#4f5dff",   // click-to-select from exercise list — accent
  soreness:    "#ef4444",   // user-reported soreness area (morning intake) — danger
} as const;

/**
 * Map an IntensityMode hex to a hero gradient. Mirrors modeColorLight() —
 * use this when you need the gradient form (full hero band) instead of the
 * flat color. Falls back to GRADIENT.heroAccent for unknown inputs.
 */
export function modeGradient(hex: string): string {
  switch (hex) {
    case "#30d158": return GRADIENT.heroSuccess;
    case "#86efac": return GRADIENT.heroSuccessSoft;
    case "#ffd60a": return GRADIENT.heroAmber;
    case "#ff453a": return GRADIENT.heroDanger;
    case "#6b7280": return GRADIENT.heroMuted;
    default:        return GRADIENT.heroAccent;
  }
}
