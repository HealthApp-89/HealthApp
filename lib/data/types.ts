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
  steps: number | null;
  calories: number | null;
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
