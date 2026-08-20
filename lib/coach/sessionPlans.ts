// Static training-plan constants — ported from the prototype.
// Stage 5 will move these into profiles.training_plan if you want per-week edits.

import { weekdayInUserTz } from "@/lib/time";
import { applyManualSessionEdits } from "@/lib/coach/manual-edits";
import { SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import type { ManualSessionEdits, WeekdayLong } from "@/lib/data/types";

export type PlannedExercise = {
  name: string;
  warmup?: boolean;
  /** Athlete-chosen rest between sets of THIS exercise, in seconds. Overrides
   *  the tier value from `restSecondsFor` wherever the plan is read — the
   *  logger, the morning brief and the strength card all show the same number.
   *
   *  Distinct from `ExerciseDraft.rest_override_seconds`, which is a
   *  session-scoped nudge that dies with the draft. This one is plan data and
   *  persists: it lives in `training_weeks.session_prescriptions` and survives
   *  until the athlete changes it again.
   *
   *  Deliberately NOT named `rest_seconds`: that is the resolved field on
   *  AnnotatedExercise, and SessionStructureBanner strips annotation fields
   *  before persisting a reorder — a same-named plan field would be eaten. */
  rest_seconds_override?: number;
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
  /** Superset tag. ADJACENT exercises sharing a tag are performed back-to-back
   *  as one round, with rest only after the last member — see
   *  lib/logger/superset-groups.ts, which defines a group as the maximal
   *  contiguous run of equal tags. Absent = performed alone.
   *
   *  Contiguity is the whole rule: a reorder that separates two members
   *  dissolves the group, and removing a member leaves the survivor solo, so
   *  there is no invalid state to validate against. */
  superset?: string;
  /** true → performed ONE LIMB AT A TIME, so `reps` / `baseReps` are PER SIDE
   *  and one set is one round of both sides. Carrier copy of the canonical
   *  `LibraryExercise.unilateral` — duplicated here for the same reason
   *  `increment` is: the plan flows through session_prescriptions into the
   *  logger, which must label the rep field "reps/side" without a library
   *  round-trip (and some planned exercises aren't in the library at all).
   *
   *  Total mechanical work is kg × reps × 2; mechanical-load.ts is the only
   *  consumer that sums total work and so the only one that reads this. */
  unilateral?: boolean;
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
  // ── Upper/Lower split (2026-08-20) ─────────────────────────────────────────
  // Accessory anchors are 10, not 15: the double-progression range is
  // bottom + width, so a 15 anchor topped out at 17-19 reps — above brzycki's
  // 12-rep cap, which left most accessory work generating no e1RM point at all.
  "Lower A": [
    // No heavy top set here. That belongs to the block's FOCUS lift only —
    // squat is a secondary in a bench block and sits under the 0.92 maintenance
    // clamp, so a heavy single would defeat the point of the focus block.
    { name: "Squat (Barbell)", baseKg: 80, baseReps: 8, sets: 3, key: "squat", increment: { step: 2.5 } },
    { name: "Romanian Deadlift (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "rdl", increment: { step: 2.5 },
      note: "Knees stay fixed, hips push BACK, bar drags the thighs to mid-shin. Never touches the floor — this is the continuous-tension hamstring lift, distinct from Thursday's deadlift. Start conservative; it is a new movement.",
      video_url: "https://www.youtube.com/watch?v=JCXUYuzwNrM" },
    { name: "Leg Extension (Machine)", baseKg: 45, baseReps: 10, sets: 3, key: "leg_ext", increment: { step: 5, intermediate: 2.5 } },
    { name: "Seated Leg Curl (Machine)", baseKg: 41, baseReps: 10, sets: 3, key: "leg_curl", increment: { step: 5, intermediate: 2.3 } },
    { name: "Seated Calf Raise (Machine)", baseKg: 50, baseReps: 10, sets: 3, key: "calf", increment: { step: 5 },
      note: "Pause 1s at full stretch. Measured tempo was ~1.8s/rep, which is bouncing out of the bottom — calves want the loaded stretch." },
    { name: "Dead Bug", baseReps: 10, sets: 2, key: "dead_bug", note: "Per side — arms relaxed at sides, opposite leg lowers, lumbar pressed to floor", video_url: "https://www.youtube.com/watch?v=bxn9FBrt4-A" },
  ],
  "Upper A": [
    // warmup:true is load-bearing, not cosmetic. Left as a working exercise the
    // engine ramps it (its own warmup sets at 4.5 kg), progresses it, and counts
    // it toward rear-delt volume as if it were a rowing set. It is prehab at a
    // warm-up dose and should be none of those things.
    { name: "Cable External Rotation", warmup: true, baseKg: 9, baseReps: 15, sets: 2, key: "cable_ext_rot", increment: { step: 4.5 }, unilateral: true,
      note: "Prehab warm-up. 15 per side, light — external rotation is structurally weaker than internal, so a light load here is expected." },
    // The heavy top set is PROSE, not prescription, and only ever on the focus
    // lift. PlannedExercise has one baseReps and one sets — there is no per-set
    // scheme in the model, and a second same-name entry would collide in
    // maintenanceLoadFor and double-progression (both key by name; warmup ramps
    // only get away with it because every rule filters warmups out). Engine
    // support for per-set schemes is a follow-up.
    { name: "Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "bench", increment: { step: 2.5 },
      note: "Block focus lift. Top set first: 4-6 reps at ~85%, then the two prescribed back-off sets. Flat, replacing decline — decline was the only barbell chest press and is the shortest-ROM angle. Weeks 1-2 re-baseline: there is one flat data point (81.3 e1RM, April) against a decline peak of 90, so start here and let the load find itself." },
    { name: "Seated Row (Machine)", baseKg: 50, baseReps: 10, sets: 4, key: "seated_row", increment: { step: 5 } },
    { name: "Incline Bench Press (Dumbbell)", baseKg: 40, baseReps: 10, sets: 3, key: "incline_db", increment: { step: 4 } },
    { name: "Lat Pulldown (Cable)", baseKg: 50, baseReps: 10, sets: 4, key: "lat_pulldown", increment: { step: 5 } },
    { name: "Face Pull (Cable)", baseKg: 25, baseReps: 15, sets: 3, key: "face_pull", increment: { step: 4.5 }, superset: "A" },
    { name: "Triceps Pushdown (Cable - Straight Bar)", baseKg: 22.5, baseReps: 10, sets: 3, key: "triceps_pushdown", increment: { step: 2.5 }, superset: "A" },
    { name: "Hammer Curl (Dumbbell)", baseKg: 24, baseReps: 10, sets: 3, key: "hammer_curl", increment: { step: 4 } },
  ],
  "Lower B": [
    { name: "Deadlift (Barbell)", baseKg: 77.5, baseReps: 6, sets: 3, key: "deadlift", increment: { step: 2.5 },
      note: "FULL range from the floor, unlike the shin-level partials logged before 2026-08-20. Expect this to feel harder at a lighter load — the floor break is the part that was being skipped. Re-baselined from 90 kg; the historical 121 e1RM is a partial-ROM number." },
    { name: "Leg Press", baseKg: 140, baseReps: 10, sets: 3, key: "leg_press", increment: { step: 5 } },
    { name: "Hip Thrust (Machine)", baseKg: 60, baseReps: 10, sets: 3, key: "hip_thrust_machine", increment: { step: 2.5 },
      note: "Restored 2026-08-20 — was in the template but discovery had dropped it from every prescription after 3 sessions in June." },
    { name: "Seated Leg Curl (Machine)", baseKg: 41, baseReps: 10, sets: 3, key: "leg_curl", increment: { step: 5, intermediate: 2.3 } },
    { name: "Seated Calf Raise (Machine)", baseKg: 50, baseReps: 10, sets: 3, key: "calf", increment: { step: 5 }, note: "Pause 1s at full stretch." },
    { name: "Back Extension", baseReps: 10, sets: 3, key: "back_ext" },
  ],
  "Upper B": [
    // The agreed drop-day when a week runs hot (padel twice, or HRV below
    // baseline). Its work is the most duplicated elsewhere in the week.
    { name: "Overhead Press (Barbell)", baseKg: 35, baseReps: 8, sets: 3, key: "ohp", increment: { step: 5 },
      note: "Anchors its own day now. It used to sit BETWEEN the two chest presses, pre-fatiguing front delts and triceps for the incline — which is part of why incline DB stalled at 40 kg." },
    { name: "Chest-Supported Row (Dumbbell)", baseKg: 40, baseReps: 10, sets: 4, key: "cs_row", increment: { step: 4 },
      note: "Second horizontal row. Chest supported, so the lower back contributes nothing two days after the deadlift." },
    { name: "Chest Fly", baseKg: 32, baseReps: 10, sets: 3, key: "chest_fly", increment: { step: 5, intermediate: 2.3 }, superset: "A" },
    { name: "Rear Delt Fly", baseKg: 29.3, baseReps: 10, sets: 3, key: "rear_delt_fly", increment: { step: 5, intermediate: 2.3 }, superset: "A" },
    { name: "Lateral Raise (Dumbbell)", baseKg: 20, baseReps: 10, sets: 3, key: "lateral_raise", increment: { step: 4 }, superset: "B" },
    { name: "Overhead Triceps Extension (Cable)", baseKg: 20, baseReps: 10, sets: 3, key: "oh_triceps", increment: { step: 4.5 }, superset: "B" },
    { name: "Bicep Curl (Dumbbell)", baseKg: 24, baseReps: 10, sets: 3, key: "bicep_curl", increment: { step: 4 } },
    { name: "Reverse Crunch", baseReps: 10, sets: 2, key: "reverse_crunch", note: "Supine, arms at sides, knees to chest with no momentum", video_url: "https://www.youtube.com/watch?v=fhrkw1aaP8k" },
  ],

  // ── Legacy body-part split (pre-2026-08-20) ────────────────────────────────
  // Retained: 73 historical workouts carry these `type` strings, and discovery,
  // adherence and the workout debrief all resolve against them. Mobility is
  // still live as an ad-hoc session.
  Chest: [
    { name: "Push Up", warmup: true, reps: "12×3" },
    { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench", increment: { step: 2.5 } },
    { name: "Overhead Press (Barbell)", baseKg: 30, baseReps: 7, sets: 3, key: "ohp", increment: { step: 5 } },
    { name: "Incline Bench Press (Dumbbell)", baseKg: 32, baseReps: 11, sets: 3, key: "incline_db", increment: { step: 4 } },
    { name: "Chest Fly", baseKg: 22, baseReps: 10, sets: 3, key: "chest_fly", increment: { step: 5, intermediate: 2.3 } },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 10, sets: 4, key: "lateral_raise", increment: { step: 4 } },
    { name: "Triceps Pushdown (Cable)", baseKg: 23, baseReps: 10, sets: 3, key: "triceps", increment: { step: 2.5 } },
    { name: "Dead Bug", baseReps: 6, sets: 2, key: "dead_bug", note: "Per side — arms relaxed at sides, opposite leg lowers, lumbar pressed to floor", video_url: "https://www.youtube.com/watch?v=bxn9FBrt4-A" },
  ],
  Legs: [
    { name: "Squat (Barbell)", baseKg: 62.5, baseReps: 6, sets: 3, key: "squat", increment: { step: 2.5 } },
    { name: "Leg Press", baseKg: 85, baseReps: 12, sets: 3, key: "leg_press", increment: { step: 5 } },
    { name: "Hip Thrust (Machine)", baseKg: 60, baseReps: 10, sets: 3, key: "hip_thrust_machine", note: "baseKg is a starting estimate — confirm on first session", increment: { step: 2.5 } },
    { name: "Leg Extension (Machine)", baseKg: 31, baseReps: 12, sets: 3, key: "leg_ext", increment: { step: 5, intermediate: 2.5 } },
    { name: "Seated Leg Curl (Machine)", baseKg: 30, baseReps: 12, sets: 3, key: "leg_curl", increment: { step: 5, intermediate: 2.3 } },
    { name: "Hip Abductor (Machine)", baseKg: 56, baseReps: 10, sets: 3, key: "abductor", increment: { step: 5, intermediate: 2 } },
    { name: "Seated Calf Raise", baseKg: 40, baseReps: 10, sets: 3, key: "calf", increment: { step: 5 } },
  ],
  Back: [
    { name: "Deadlift (Barbell)", baseKg: 82.5, baseReps: 6, sets: 3, key: "deadlift", increment: { step: 2.5 } },
    { name: "Lat Pulldown (Cable)", baseKg: 45, baseReps: 10, sets: 4, key: "lat_pulldown", increment: { step: 5 } },
    { name: "Seated Row (Machine)", baseKg: 38, baseReps: 12, sets: 3, key: "seated_row", increment: { step: 5 } },
    { name: "Pullover (Dumbbell)", baseKg: 18, baseReps: 12, sets: 3, key: "pullover", increment: { step: 2 } },
    { name: "Shrug (Barbell)", baseKg: 45, baseReps: 10, sets: 3, key: "shrug", increment: { step: 2.5 } },
    { name: "Back Extension", reps: "10×3", key: "back_ext" },
  ],
  Arms: [
    { name: "Arnold Press (Dumbbell)", baseKg: 24, baseReps: 10, sets: 3, key: "arnold_press", increment: { step: 4 }, superset: "A" },
    { name: "Bicep Curl (Dumbbell)", baseKg: 20, baseReps: 10, sets: 3, key: "bicep_curl", increment: { step: 4 }, superset: "A" },
    { name: "Front Raise (Dumbbell)", baseKg: 16, baseReps: 10, sets: 3, key: "front_raise", increment: { step: 4 }, superset: "B" },
    { name: "Hammer Curl (Dumbbell)", baseKg: 20, baseReps: 10, sets: 3, key: "hammer_curl", increment: { step: 4 }, superset: "B" },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 10, sets: 3, key: "lateral_raise", increment: { step: 4 }, superset: "C" },
    { name: "Triceps Pushdown (Cable - Straight Bar)", baseKg: 22.5, baseReps: 10, sets: 3, key: "triceps_pushdown", increment: { step: 2.5 }, superset: "C" },
    // Rotations: `unilateral` — baseReps is PER SIDE. 15/side is the same work
    // the athlete was already doing; the old 28/30 anchors were both sides
    // summed into one number, which the engine read as a single 30-rep set.
    { name: "Cable External Rotation", baseKg: 9, baseReps: 15, sets: 3, key: "cable_ext_rot", increment: { step: 4.5 }, unilateral: true },
    { name: "Cable Internal Rotation", baseKg: 18, baseReps: 15, sets: 3, key: "cable_int_rot", increment: { step: 4.5 }, unilateral: true },
    { name: "Rear Delt Fly", baseKg: 25, baseReps: 10, sets: 3, key: "rear_delt_fly", increment: { step: 5, intermediate: 2.3 } },
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

/**
 * Upper/Lower over four days, adopted 2026-08-20. Replaces the five-day
 * body-part split (Mon Legs / Tue Chest / Wed Mobility / Thu Back / Fri Arms).
 *
 * The split changed because PLANNED days were never the constraint — attendance
 * was. Actual cadence over Apr-Aug 2026 was 3.3 sessions/wk against a 5-day
 * plan, and under a body-part split hitting 3 of 5 means two muscle groups get
 * ZERO that week. That is exactly how lats reached 6.5 sets/wk (below MEV) and
 * how the deadlift went eight weeks with two sessions: Back day was the one
 * that got dropped, and it carried both. Upper/Lower makes a missed day cost a
 * muscle HALF its volume instead of all of it, and gives two exposures a week
 * at full attendance instead of one.
 *
 * Upper A deliberately carries the pull volume, not Upper B. Upper B is the
 * agreed drop-day when a week runs hot, and the first draft had it holding most
 * of the rows — so dropping it would have returned the week to a ~1.7 push:pull
 * ratio and silently undone the whole correction. As laid out, the week is
 * 0.88 push:pull intact and 0.64 with Upper B dropped.
 *
 * Saturday's Z1-Z2 ride is NOT a session_plan value: endurance work lives in
 * training_weeks.endurance_session_plan (keyed 0=Sun..6=Sat), which is the seam
 * the endurance pillar, the morning brief and adherence already read.
 *
 * The old Chest/Legs/Back/Arms SESSION_PLANS entries are retained below — 73
 * historical workouts carry those `type` strings, and discovery, adherence and
 * the debrief all resolve against them.
 */
export const WEEKLY_SESSIONS: Record<string, string> = {
  Monday: "Lower A",
  Tuesday: "Upper A",
  Wednesday: "REST",
  Thursday: "Lower B",
  Friday: "Upper B",
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
