// Static training-plan constants — ported from the prototype.
// Stage 5 will move these into profiles.training_plan if you want per-week edits.

import { weekdayInUserTz } from "@/lib/time";

export type PlannedExercise = {
  name: string;
  warmup?: boolean;
  reps?: string;
  baseKg?: number;
  baseReps?: number;
  sets?: number;
  key?: string;
  note?: string;
  /** Valid weight increments. Used by the morning brief and progressive-overload
   *  suggestions to round prescribed weights to physically-loadable values.
   *  `step` = base increment (e.g., 2.5kg barbell w/ 1.25 plates).
   *  `intermediate` = optional pin between base steps (e.g., 5kg stack with a 2.3kg
   *  intermediate pin → valid weights: 0, 2.3, 5, 7.3, 10, 12.3, ...).
   *  Absent = no rounding (e.g., bodyweight/duration exercises). */
  increment?: { step: number; intermediate?: number };
};

// NOTE: `intermediate` on Chest Fly (2.3kg) and Seated Leg Curl (2.3kg) is a
// best-guess from observed machine data — pending user confirmation tomorrow.
// All other increment values are confirmed from the user's gym equipment.
export const SESSION_PLANS: Record<string, PlannedExercise[]> = {
  Chest: [
    { name: "Push Up", warmup: true, reps: "12×3" },
    { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench", increment: { step: 2.5 } },
    { name: "Overhead Press (Barbell)", baseKg: 30, baseReps: 7, sets: 3, key: "ohp", increment: { step: 5 } },
    { name: "Incline Bench Press (Dumbbell)", baseKg: 32, baseReps: 11, sets: 3, key: "incline_db", increment: { step: 2 } },
    { name: "Chest Fly", baseKg: 22, baseReps: 15, sets: 3, key: "chest_fly", increment: { step: 5, intermediate: 2.3 } },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 12, sets: 4, key: "lateral_raise", note: "Jump from 8kg — next DB is 12kg", increment: { step: 2 } },
    { name: "Triceps Pushdown (Cable)", baseKg: 23, baseReps: 15, sets: 3, key: "triceps", increment: { step: 2.5 } },
  ],
  Legs: [
    { name: "Squat (Barbell)", baseKg: 62.5, baseReps: 6, sets: 3, key: "squat", increment: { step: 2.5 } },
    { name: "Leg Press", baseKg: 85, baseReps: 12, sets: 3, key: "leg_press", increment: { step: 5 } },
    { name: "Leg Extension (Machine)", baseKg: 31, baseReps: 12, sets: 3, key: "leg_ext", increment: { step: 5, intermediate: 2.5 } },
    { name: "Romanian Deadlift (Barbell)", baseKg: 65, baseReps: 6, sets: 4, key: "rdl", increment: { step: 2.5 } },
    { name: "Seated Leg Curl (Machine)", baseKg: 30, baseReps: 12, sets: 3, key: "leg_curl", increment: { step: 5, intermediate: 2.3 } },
    { name: "Seated Calf Raise", baseKg: 40, baseReps: 15, sets: 3, key: "calf", increment: { step: 5 } },
    { name: "Hip Abductor (Machine)", baseKg: 56, baseReps: 15, sets: 3, key: "abductor", increment: { step: 5, intermediate: 2 } },
  ],
  Back: [
    { name: "Deadlift (Barbell)", baseKg: 82.5, baseReps: 6, sets: 2, key: "deadlift", increment: { step: 2.5 } },
    { name: "Lat Pulldown (Cable)", baseKg: 45, baseReps: 10, sets: 4, key: "lat_pulldown", increment: { step: 5 } },
    { name: "Seated Row (Machine)", baseKg: 38, baseReps: 12, sets: 3, key: "seated_row", increment: { step: 5 } },
    { name: "Pullover (Dumbbell)", baseKg: 18, baseReps: 12, sets: 3, key: "pullover", increment: { step: 2 } },
    { name: "Shrug (Barbell)", baseKg: 45, baseReps: 15, sets: 3, key: "shrug", increment: { step: 2.5 } },
    { name: "Back Extension", reps: "10×3", key: "back_ext" },
  ],
  Mobility: [
    { name: "Diaphragmatic Breathing", reps: "5×2" },
    { name: "Cat-Cow", reps: "8×2" },
    { name: "90/90 Hip Mobility", reps: "6×3" },
    { name: "Wall Slides", reps: "10×3" },
    { name: "Thread the Needle", reps: "8×2 each side" },
    { name: "Glute Bridge", reps: "12×3" },
    { name: "Child's Pose", reps: "Hold 60s×2" },
    { name: "Shoulder CARs", reps: "5 circles each×2" },
  ],
};

export const WEEKLY_SESSIONS: Record<string, string> = {
  Monday: "Chest",
  Tuesday: "Legs",
  Wednesday: "Mobility",
  Thursday: "Back",
  Friday: "Legs",
  Saturday: "REST",
  Sunday: "REST",
};

export function getTodaySession(): string {
  return WEEKLY_SESSIONS[weekdayInUserTz()] ?? "REST";
}

import type { ExerciseOverrides } from "@/lib/data/types";

/** Returns the effective exercise list for a given session type + weekday.
 *  Resolution chain (matches lib/logger/resolve-plan.ts): per-weekday override
 *  in training_weeks.exercise_overrides → per-user persistent template in
 *  user_session_templates → static SESSION_PLANS code default. Returns []
 *  when no source has exercises (e.g. an unknown session type with no
 *  override and no template).
 *
 *  This is the synchronous variant used by client components that already
 *  fetch override + template via TanStack hooks. The async server-side
 *  variant in lib/logger/resolve-plan.ts queries Supabase directly. */
export function getEffectiveSessionPlan(
  sessionType: string,
  weekday: string,
  overrides: ExerciseOverrides | null | undefined,
  userTemplate?: PlannedExercise[] | null,
): PlannedExercise[] {
  const override = overrides?.[weekday];
  if (override && override.length > 0) return override;
  if (userTemplate && userTemplate.length > 0) return userTemplate;
  return SESSION_PLANS[sessionType] ?? [];
}
