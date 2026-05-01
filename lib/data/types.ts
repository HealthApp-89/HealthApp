// Database row shapes — snake_case, mirrors supabase/schema.sql.

export type DailyLog = {
  user_id: string;
  date: string; // YYYY-MM-DD
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  spo2: number | null;
  skin_temp_c: number | null;
  strain: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  rem_sleep_hours: number | null;
  weight_kg: number | null;
  body_fat_pct: number | null;
  fat_mass_kg: number | null;
  fat_free_mass_kg: number | null;
  muscle_mass_kg: number | null;
  bone_mass_kg: number | null;
  hydration_kg: number | null;
  steps: number | null;
  calories: number | null;
  active_calories: number | null;
  distance_km: number | null;
  exercise_min: number | null;
  calories_eaten: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  respiratory_rate: number | null;
  notes: string | null;
  source: string | null;
  updated_at: string;
};

export type Profile = {
  user_id: string;
  name: string | null;
  age: number | null;
  height_cm: number | null;
  goal: string | null;
  whoop_baselines: Record<string, unknown> | null;
  training_plan: Record<string, unknown> | null;
};

export type WhoopTokensRow = {
  user_id: string;
  whoop_user_id: string | null;
  updated_at: string;
};

export type WithingsTokensRow = {
  user_id: string;
  withings_user_id: string | null;
  updated_at: string;
};

export type IngestTokenRow = {
  user_id: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  last_used_source: "apple_health" | "strong" | "yazio" | null;
};
