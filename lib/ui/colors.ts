// Color palette and field metadata — light-theme calibrated.
// For per-metric chart colors, lib/ui/theme.ts:METRIC_COLOR is the canonical
// source. The `c` values here mirror it for backward compatibility with any
// caller still reading FIELDS[].c directly.

import { COLOR, METRIC_COLOR } from "./theme";

export const WCOLORS: Record<string, string> = {
  Chest:      "#f97316",  // orange
  Back:       "#4f5dff",  // indigo (accent)
  Legs:       "#14b870",  // emerald
  Shoulders:  "#a855f7",  // violet
  Arms:       "#ef4444",  // red
  "Full Body":"#06b6d4",  // cyan
  Cardio:     "#ca8a04",  // mustard
  Mobility:   "#0ea5e9",  // sky
  Other:      "#9094a8",  // muted
};

export type DailyLogKey =
  | "hrv"
  | "resting_hr"
  | "spo2"
  | "skin_temp_c"
  | "sleep_hours"
  | "sleep_score"
  | "deep_sleep_hours"
  | "rem_sleep_hours"
  | "strain"
  | "steps"
  | "calories"
  | "weight_kg"
  | "body_fat_pct";

export type FieldMeta = {
  k: DailyLogKey;
  l: string;  // label
  u: string;  // unit
  m: number;  // max for bar normalisation
  c: string;  // color (mirrors METRIC_COLOR[k])
};

export const FIELDS: FieldMeta[] = [
  { k: "hrv",              l: "HRV",         u: "ms",   m: 120,   c: METRIC_COLOR.hrv },
  { k: "resting_hr",       l: "Resting HR",  u: "bpm",  m: 90,    c: METRIC_COLOR.resting_hr },
  { k: "spo2",             l: "SpO2",        u: "%",    m: 100,   c: METRIC_COLOR.spo2 },
  { k: "skin_temp_c",      l: "Skin Temp",   u: "C",    m: 38,    c: METRIC_COLOR.skin_temp_c },
  { k: "sleep_hours",      l: "Sleep",       u: "hrs",  m: 10,    c: METRIC_COLOR.sleep_hours },
  { k: "sleep_score",      l: "Sleep Score", u: "/100", m: 100,   c: METRIC_COLOR.sleep_score },
  { k: "deep_sleep_hours", l: "Deep Sleep",  u: "hrs",  m: 4,     c: METRIC_COLOR.deep_sleep_hours },
  { k: "rem_sleep_hours",  l: "REM Sleep",   u: "hrs",  m: 4,     c: METRIC_COLOR.rem_sleep_hours },
  { k: "strain",           l: "Strain",      u: "/21",  m: 21,    c: METRIC_COLOR.strain },
  { k: "steps",            l: "Steps",       u: "",     m: 15000, c: METRIC_COLOR.steps },
  { k: "calories",         l: "Calories",    u: "kcal", m: 4000,  c: METRIC_COLOR.calories },
  { k: "weight_kg",        l: "Weight",      u: "kg",   m: 150,   c: METRIC_COLOR.weight_kg },
  { k: "body_fat_pct",     l: "Body Fat",    u: "%",    m: 40,    c: METRIC_COLOR.body_fat_pct },
];

export function scoreColor(v: number | null | undefined): string {
  if (!v) return COLOR.textMuted;
  if (v >= 80) return COLOR.success;
  if (v >= 60) return COLOR.warning;
  return COLOR.danger;
}

export function scoreLabel(v: number | null | undefined): string {
  if (!v) return "No data";
  if (v >= 80) return "Optimal";
  if (v >= 60) return "Moderate";
  return "Poor";
}

export function priorityColor(level: "high" | "medium" | "low" | string): string {
  if (level === "high")   return COLOR.danger;
  if (level === "medium") return COLOR.warning;
  if (level === "low")    return COLOR.success;
  return COLOR.textMuted;
}
