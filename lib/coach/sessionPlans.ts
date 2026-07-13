// Static training-plan constants — ported from the prototype.
// Stage 5 will move these into profiles.training_plan if you want per-week edits.

import { weekdayInUserTz } from "@/lib/time";
import { applyManualSessionEdits } from "@/lib/coach/manual-edits";
import { SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import type { ManualSessionEdits, WeekdayLong } from "@/lib/data/types";

export type PlannedExercise = {
  name: string;
  warmup?: boolean;
  reps?: string;
  baseKg?: number;
  baseReps?: number;
  sets?: number;
  key?: string;
  note?: string;
  /** Per-exercise reps-in-reserve target. When set (e.g. by the activity-aware
   *  lighten), it overrides the tier-derived RPE string in annotateSession and
   *  is displayed on the brief + strength card. Absent = use the session-level
   *  rir_target / tier default. */
  rir?: number;
  /** Valid weight increments. Used by the morning brief and progressive-overload
   *  suggestions to round prescribed weights to physically-loadable values.
   *  `step` = base increment (e.g., 2.5kg barbell w/ 1.25 plates).
   *  `intermediate` = optional pin between base steps (e.g., 5kg stack with a 2.3kg
   *  intermediate pin → valid weights: 0, 2.3, 5, 7.3, 10, 12.3, ...).
   *  Absent = no rounding (e.g., bodyweight/duration exercises). */
  increment?: { step: number; intermediate?: number };
  /** Optional YouTube link to a form/technique tutorial. Surfaced in the
   *  morning brief and strength-card exercise lists so the user can review
   *  technique before the session. */
  video_url?: string;
  /** Marks the exercise as time-based instead of rep-based. The logger
   *  renders a countdown timer (start/stop) per set instead of kg/reps
   *  inputs. Actual seconds achieved persist to exercise_sets.duration_seconds.
   *  Applies to foam-roll holds, planks, dead hangs, breathing protocols,
   *  etc. — anything where "did you hit the prescribed seconds" is the
   *  unit of progress. */
  duration_seconds?: number;
};

// NOTE: `intermediate` on Chest Fly (2.3kg) and Seated Leg Curl (2.3kg) is a
// best-guess from observed machine data — pending user confirmation tomorrow.
// All other increment values are confirmed from the user's gym equipment.
//
// Bilateral-DB convention: `baseKg` is TOTAL load across both hands. The user's
// dumbbells step by 2kg per DB, so bilateral exercises (one DB per hand) step
// by 4kg total. Unilateral DB exercises (single DB held with both hands, e.g.
// Pullover) step by 2kg. See memory equipment-gym-dumbbells.
export const SESSION_PLANS: Record<string, PlannedExercise[]> = {
  Chest: [
    { name: "Push Up", warmup: true, reps: "12×3" },
    { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench", increment: { step: 2.5 } },
    { name: "Overhead Press (Barbell)", baseKg: 30, baseReps: 7, sets: 3, key: "ohp", increment: { step: 5 } },
    { name: "Incline Bench Press (Dumbbell)", baseKg: 32, baseReps: 11, sets: 3, key: "incline_db", increment: { step: 4 } },
    { name: "Chest Fly", baseKg: 22, baseReps: 15, sets: 3, key: "chest_fly", increment: { step: 5, intermediate: 2.3 } },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 12, sets: 4, key: "lateral_raise", increment: { step: 4 } },
    { name: "Triceps Pushdown (Cable)", baseKg: 23, baseReps: 15, sets: 3, key: "triceps", increment: { step: 2.5 } },
    { name: "Dead Bug", baseReps: 6, sets: 2, key: "dead_bug", note: "Per side — arms relaxed at sides, opposite leg lowers, lumbar pressed to floor", video_url: "https://www.youtube.com/watch?v=bxn9FBrt4-A" },
  ],
  Legs: [
    { name: "Squat (Barbell)", baseKg: 62.5, baseReps: 6, sets: 3, key: "squat", increment: { step: 2.5 } },
    { name: "Leg Press", baseKg: 85, baseReps: 12, sets: 3, key: "leg_press", increment: { step: 5 } },
    { name: "Hip Thrust (Machine)", baseKg: 60, baseReps: 10, sets: 3, key: "hip_thrust_machine", note: "baseKg is a starting estimate — confirm on first session", increment: { step: 2.5 } },
    { name: "Leg Extension (Machine)", baseKg: 31, baseReps: 12, sets: 3, key: "leg_ext", increment: { step: 5, intermediate: 2.5 } },
    { name: "Seated Leg Curl (Machine)", baseKg: 30, baseReps: 12, sets: 3, key: "leg_curl", increment: { step: 5, intermediate: 2.3 } },
    { name: "Hip Abductor (Machine)", baseKg: 56, baseReps: 15, sets: 3, key: "abductor", increment: { step: 5, intermediate: 2 } },
    { name: "Seated Calf Raise", baseKg: 40, baseReps: 15, sets: 3, key: "calf", increment: { step: 5 } },
  ],
  Back: [
    { name: "Deadlift (Barbell)", baseKg: 82.5, baseReps: 6, sets: 3, key: "deadlift", increment: { step: 2.5 } },
    { name: "Lat Pulldown (Cable)", baseKg: 45, baseReps: 10, sets: 4, key: "lat_pulldown", increment: { step: 5 } },
    { name: "Seated Row (Machine)", baseKg: 38, baseReps: 12, sets: 3, key: "seated_row", increment: { step: 5 } },
    { name: "Pullover (Dumbbell)", baseKg: 18, baseReps: 12, sets: 3, key: "pullover", increment: { step: 2 } },
    { name: "Shrug (Barbell)", baseKg: 45, baseReps: 15, sets: 3, key: "shrug", increment: { step: 2.5 } },
    { name: "Back Extension", reps: "10×3", key: "back_ext" },
  ],
  Arms: [
    { name: "Arnold Press (Dumbbell)", baseKg: 24, baseReps: 15, sets: 3, key: "arnold_press", increment: { step: 4 } },
    { name: "Bicep Curl (Dumbbell)", baseKg: 20, baseReps: 15, sets: 3, key: "bicep_curl", increment: { step: 4 } },
    { name: "Front Raise (Dumbbell)", baseKg: 16, baseReps: 15, sets: 3, key: "front_raise", increment: { step: 4 } },
    { name: "Hammer Curl (Dumbbell)", baseKg: 20, baseReps: 15, sets: 3, key: "hammer_curl", increment: { step: 4 } },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 15, sets: 3, key: "lateral_raise", increment: { step: 4 } },
    { name: "Triceps Pushdown (Cable - Straight Bar)", baseKg: 22.5, baseReps: 12, sets: 3, key: "triceps_pushdown", increment: { step: 2.5 } },
    { name: "Cable External Rotation", baseKg: 9, baseReps: 28, sets: 3, key: "cable_ext_rot", increment: { step: 4.5 } },
    { name: "Cable Internal Rotation", baseKg: 18, baseReps: 30, sets: 3, key: "cable_int_rot", increment: { step: 4.5 } },
    { name: "Rear Delt Fly", baseKg: 25, baseReps: 15, sets: 3, key: "rear_delt_fly", increment: { step: 5, intermediate: 2.3 } },
    { name: "Reverse Crunch", baseReps: 10, sets: 2, key: "reverse_crunch", note: "Supine, arms at sides, knees to chest with no momentum", video_url: "https://www.youtube.com/watch?v=fhrkw1aaP8k" },
  ],
  Mobility: [
    { name: "Diaphragmatic Breathing", reps: "5×2", video_url: "https://www.youtube.com/watch?v=UB3tSaiEbNY" },
    { name: "Foam Roll: T-spine Extension", reps: "8 passes×2", note: "Roller at bra-line, arms behind head, small reps — preps Wall Slides + Thread the Needle", video_url: "https://www.youtube.com/watch?v=qCrYe698zJU" },
    { name: "Foam Roll: Quads", reps: "60s each side", sets: 2, duration_seconds: 60, note: "Recovers Monday squats / leg press", video_url: "https://www.youtube.com/watch?v=fvVua1NNzC4" },
    { name: "Foam Roll: Lats", reps: "60s each side", sets: 2, duration_seconds: 60, note: "Recovers Thursday pulls; primes Shoulder CARs", video_url: "https://www.youtube.com/watch?v=1GaR-a9TWYM" },
    { name: "Foam Roll: Glutes / Piriformis", reps: "60s each side", sets: 2, duration_seconds: 60, note: "Primes 90/90 + Glute Bridge", video_url: "https://www.youtube.com/watch?v=DcnerMGjK_U" },
    { name: "Cat-Cow", reps: "8×2", video_url: "https://www.youtube.com/watch?v=xyNwxiuERXc" },
    { name: "90/90 Hip Mobility", reps: "6×3", video_url: "https://www.youtube.com/watch?v=t4Zz6-aG8Iw" },
    { name: "Wall Slides", reps: "10×3", video_url: "https://www.youtube.com/watch?v=rYcH0odwmHc" },
    { name: "Thread the Needle", reps: "8×2 each side", video_url: "https://www.youtube.com/watch?v=MfUx9FCOb1E" },
    { name: "Child's Pose", reps: "Hold 60s×2", sets: 2, duration_seconds: 60, video_url: "https://www.youtube.com/watch?v=LMiAZKDNh_Y" },
    { name: "Shoulder CARs", reps: "5 circles each×2", video_url: "https://www.youtube.com/watch?v=Ag1yVYbPXeg" },
    { name: "Glute Bridge", reps: "12×3", video_url: "https://www.youtube.com/watch?v=Q_Bpj91Yiis" },
    { name: "Side Plank", reps: "Hold 20s each side", sets: 2, duration_seconds: 20, key: "side_plank", note: "Each side — elbow under shoulder, hips stacked; build to 30s, then 45s before adding a second Wed exercise", video_url: "https://www.youtube.com/watch?v=1qcsRZhtMyo" },
  ],
};

export const WEEKLY_SESSIONS: Record<string, string> = {
  Monday: "Legs",
  Tuesday: "Chest",
  Wednesday: "Mobility",
  Thursday: "Back",
  Friday: "Arms",
  Saturday: "REST",
  Sunday: "REST",
};

export function getTodaySession(tz: string): string {
  return WEEKLY_SESSIONS[weekdayInUserTz(new Date(), tz)] ?? "REST";
}

import type { ExerciseOverrides, SessionPrescriptions } from "@/lib/data/types";

/** Re-sequence `base` to follow the name order in `orderNames`, preserving each
 *  exercise's fields (loads/reps/sets stay engine-owned). Exercises whose names
 *  aren't present in `orderNames` keep their original relative order, appended
 *  after the ranked ones. This is how a user reorder (exercise_overrides) layers
 *  on top of an engine-owned prescription without masking its loads — the
 *  override carries ordering only. Single source of truth, mirrored verbatim by
 *  the async server resolver in lib/logger/resolve-plan.ts. */
export function applyOrderingOverride(
  base: PlannedExercise[],
  orderNames: string[],
): PlannedExercise[] {
  const rank = new Map(orderNames.map((n, i) => [n, i] as const));
  const UNRANKED = Number.MAX_SAFE_INTEGER;
  return base
    .map((ex, i) => ({ ex, i }))
    .sort((a, b) => {
      const ra = rank.get(a.ex.name) ?? UNRANKED;
      const rb = rank.get(b.ex.name) ?? UNRANKED;
      return ra !== rb ? ra - rb : a.i - b.i;
    })
    .map((x) => x.ex);
}

/** Returns the effective exercise list for a given session type + weekday.
 *  Resolution chain (matches lib/logger/resolve-plan.ts): per-weekday Sunday
 *  prescription in training_weeks.session_prescriptions → per-weekday override
 *  in training_weeks.exercise_overrides → per-user persistent template in
 *  user_session_templates → static SESSION_PLANS code default. Returns []
 *  when no source has exercises (e.g. an unknown session type with no
 *  override and no template).
 *
 *  When a prescription AND an override both exist for the weekday, the override
 *  is treated as an ordering layer over the prescription (see
 *  applyOrderingOverride) — the engine still owns loads, the user owns order.
 *
 *  This is the synchronous variant used by client components that already
 *  fetch override + template via TanStack hooks. The async server-side
 *  variant in lib/logger/resolve-plan.ts queries Supabase directly. */
export function getEffectiveSessionPlan(
  sessionType: string,
  weekday: string,
  sessionPrescriptions: SessionPrescriptions | null | undefined,
  overrides: ExerciseOverrides | null | undefined,
  userTemplate?: PlannedExercise[] | null,
  manualEdits?: ManualSessionEdits | null,
): PlannedExercise[] {
  // Normalize weekday to long form for manual_session_edits lookup (keys are
  // always WeekdayLong). Short-form callers ("Mon") are normalized here;
  // long-form callers ("Monday") pass through unchanged.
  const weekdayLong: WeekdayLong = (
    weekday.length === 3 ? (SHORT_TO_FULL[weekday as keyof typeof SHORT_TO_FULL] ?? weekday) : weekday
  ) as WeekdayLong;

  const presc = sessionPrescriptions?.[weekday as keyof SessionPrescriptions];
  const override = overrides?.[weekday];
  let result: PlannedExercise[];
  if (presc && presc.length > 0) {
    if (override && override.length > 0) {
      result = applyOrderingOverride(presc, override.map((e) => e.name));
    } else {
      result = presc;
    }
  } else if (override && override.length > 0) {
    result = override;
  } else if (userTemplate && userTemplate.length > 0) {
    result = userTemplate;
  } else {
    result = SESSION_PLANS[sessionType] ?? [];
  }

  if (manualEdits) {
    const { exercises } = applyManualSessionEdits(result, manualEdits[weekdayLong]);
    return exercises;
  }
  return result;
}
