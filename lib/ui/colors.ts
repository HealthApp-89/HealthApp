// Color palette and field metadata, ported from the prototype.

export const WCOLORS: Record<string, string> = {
  Chest: "#ff9f43",
  Back: "#4fc3f7",
  Legs: "#6bcb77",
  Shoulders: "#a29bfe",
  Arms: "#ff6b6b",
  "Full Body": "#00f5c4",
  Cardio: "#ffd93d",
  Mobility: "#b2f7ef",
  Other: "#888",
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
  { k: "hrv", l: "HRV", u: "ms", m: 120, c: "#00f5c4" },
  { k: "resting_hr", l: "Resting HR", u: "bpm", m: 90, c: "#ff6b6b" },
  { k: "spo2", l: "SpO2", u: "%", m: 100, c: "#00f5c4" },
  { k: "skin_temp_c", l: "Skin Temp", u: "C", m: 38, c: "#ffd93d" },
  { k: "sleep_hours", l: "Sleep", u: "hrs", m: 10, c: "#a29bfe" },
  { k: "sleep_score", l: "Sleep Score", u: "/100", m: 100, c: "#a29bfe" },
  { k: "deep_sleep_hours", l: "Deep Sleep", u: "hrs", m: 4, c: "#4fc3f7" },
  { k: "rem_sleep_hours", l: "REM Sleep", u: "hrs", m: 4, c: "#7c6af7" },
  { k: "strain", l: "Strain", u: "/21", m: 21, c: "#ff9f43" },
  { k: "steps", l: "Steps", u: "", m: 15000, c: "#00f5c4" },
  { k: "calories", l: "Calories", u: "kcal", m: 4000, c: "#ffd93d" },
  { k: "weight_kg", l: "Weight", u: "kg", m: 150, c: "#4fc3f7" },
  { k: "body_fat_pct", l: "Body Fat", u: "%", m: 40, c: "#ff9f43" },
];

export function scoreColor(v: number | null | undefined): string {
  if (!v) return "#555";
  if (v >= 80) return "#00f5c4";
  if (v >= 60) return "#ffd93d";
  return "#ff6b6b";
}

export function scoreLabel(v: number | null | undefined): string {
  if (!v) return "No data";
  if (v >= 80) return "Optimal";
  if (v >= 60) return "Moderate";
  return "Poor";
}

export function priorityColor(level: "high" | "medium" | "low" | string): string {
  if (level === "high") return "#ff6b6b";
  if (level === "medium") return "#ffd93d";
  if (level === "low") return "#6bcb77";
  return "#888";
}
