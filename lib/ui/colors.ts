// Color palette and field metadata — Apple system colors (dark variants).

export const WCOLORS: Record<string, string> = {
  Chest: "#ff9f0a",
  Back: "#0a84ff",
  Legs: "#30d158",
  Shoulders: "#bf5af2",
  Arms: "#ff453a",
  "Full Body": "#64d2ff",
  Cardio: "#ffd60a",
  Mobility: "#66d4cf",
  Other: "#98989d",
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
  l: string; // label
  u: string; // unit
  m: number; // max for bar normalisation
  c: string; // color
};

export const FIELDS: FieldMeta[] = [
  { k: "hrv", l: "HRV", u: "ms", m: 120, c: "#ff375f" },
  { k: "resting_hr", l: "Resting HR", u: "bpm", m: 90, c: "#ff453a" },
  { k: "spo2", l: "SpO2", u: "%", m: 100, c: "#64d2ff" },
  { k: "skin_temp_c", l: "Skin Temp", u: "C", m: 38, c: "#ff9f0a" },
  { k: "sleep_hours", l: "Sleep", u: "hrs", m: 10, c: "#5e5ce6" },
  { k: "sleep_score", l: "Sleep Score", u: "/100", m: 100, c: "#5e5ce6" },
  { k: "deep_sleep_hours", l: "Deep Sleep", u: "hrs", m: 4, c: "#0a84ff" },
  { k: "rem_sleep_hours", l: "REM Sleep", u: "hrs", m: 4, c: "#bf5af2" },
  { k: "strain", l: "Strain", u: "/21", m: 21, c: "#ff9f0a" },
  { k: "steps", l: "Steps", u: "", m: 15000, c: "#30d158" },
  { k: "calories", l: "Calories", u: "kcal", m: 4000, c: "#ffd60a" },
  { k: "weight_kg", l: "Weight", u: "kg", m: 150, c: "#af52de" },
  { k: "body_fat_pct", l: "Body Fat", u: "%", m: 40, c: "#ff9500" },
];

export function scoreColor(v: number | null | undefined): string {
  if (!v) return "#555";
  if (v >= 80) return "#30d158";
  if (v >= 60) return "#ffd60a";
  return "#ff453a";
}

export function scoreLabel(v: number | null | undefined): string {
  if (!v) return "No data";
  if (v >= 80) return "Optimal";
  if (v >= 60) return "Moderate";
  return "Poor";
}

export function priorityColor(level: "high" | "medium" | "low" | string): string {
  if (level === "high") return "#ff453a";
  if (level === "medium") return "#ffd60a";
  if (level === "low") return "#30d158";
  return "#98989d";
}
