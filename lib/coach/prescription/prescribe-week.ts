// lib/coach/prescription/prescribe-week.ts
//
// Orchestrator: given a user, a block, the proposed week's session_plan +
// intensity_modifier, and prior workout history, produce the full
// session_prescriptions[weekday] payload for commit. Combines block-phase,
// autoregulation, volume-balance, maintenance-baseline, and
// recent-workouts discovery. Pattern-conflict validation happens
// downstream in validate-week.ts (Task 12).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  TrainingBlock,
  TrainingWeek,
  SessionPrescriptions,
  PrimaryLift,
  WeekdayLong,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { evaluateBlockPhase, prescribePrimaryFromPhase } from "@/lib/coach/prescription/block-phase-rule";
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule";
import { prescribeAccessoryFromVolumeBand, classifyVolumeBand, type VolumeBandPosition } from "@/lib/coach/prescription/volume-balance-rule";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { discoverEffectiveExercises } from "@/lib/coach/prescription/recent-workouts-discovery";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import { fetchMuscleVolumeServer } from "@/lib/query/fetchers/muscleVolume";
import {
  getExerciseMuscles,
  TARGET_GROUP_FOR_MUSCLE,
} from "@/lib/coach/exercise-muscles";
import { literatureBand } from "@/lib/coach/volume-landmarks";
import type { TargetedMuscleGroup, MuscleVolumeSnapshot } from "@/lib/data/types";

const FOCUS_BLOCK_CLAMP = 0.92;

/** Exercise-name patterns that identify a primary-lift instance. DB stores
 *  free-form exercise names ("Deadlift (Barbell)"), not keys — we use case-
 *  insensitive substring match. List ordering doesn't matter; first match wins. */
const PRIMARY_LIFT_NAME_PATTERNS: Record<PrimaryLift, string[]> = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

/** Reverse map: case-insensitive lookup from exercise name → primary lift. */
function inferPrimaryLiftFromName(name: string): PrimaryLift | null {
  const n = name.toLowerCase();
  for (const [lift, patterns] of Object.entries(PRIMARY_LIFT_NAME_PATTERNS) as Array<[PrimaryLift, string[]]>) {
    if (patterns.some((p) => n === p.toLowerCase())) return lift;
  }
  return null;
}

export async function prescribeWeek(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  week: TrainingWeek;
  todayIso: string;
}): Promise<SessionPrescriptions> {
  const { supabase, userId, block, week, todayIso } = opts;
  const out: SessionPrescriptions = {};

  // rir_target is nullable on the row; default to 2 (the RP/Helms hypertrophy
  // default) so downstream rule modules — whose params are non-null number —
  // get a defined value. Carter renegotiates the rir_target upstream when needed.
  const rirTarget: number = week.rir_target ?? 2;

  // Fetch recent sets once for all maintenance-baseline + autoreg lookups.
  const recentSets = await fetchRecentSets(supabase, userId, todayIso);

  // Per-muscle weekly-volume snapshot for accessory band classification.
  // null on fetch failure → callers fall back to "in_band" (no-op).
  const volumeContext = await fetchVolumeContext(supabase, userId, todayIso);

  const isFocusBlock = block != null && block.primary_lift != null;
  const focusLift: PrimaryLift | null = isFocusBlock ? block!.primary_lift : null;

  for (const [weekdayStr, sessionType] of Object.entries(week.session_plan ?? {})) {
    const weekday = weekdayStr as WeekdayLong;
    if (sessionType === "REST" || sessionType === "Mobility") continue;

    const effective =
      (await discoverEffectiveExercises({ supabase, userId, sessionType })) ??
      SESSION_PLANS[sessionType] ??
      [];

    const exercises: PlannedExercise[] = [];

    for (const baseEx of effective) {
      const liftKey = inferPrimaryLiftFromName(baseEx.name);
      const isPrimary = liftKey != null;
      const isFocusLiftExercise = isFocusBlock && liftKey === focusLift;

      if (isFocusLiftExercise) {
        const currentWorkingKg =
          maintenanceLoadFor(baseEx.name, rirTarget, recentSets, todayIso) ??
          baseEx.baseKg ?? 0;
        const phase = evaluateBlockPhase({
          block: block!,
          currentWorkingKg,
          recentProgressionRatePerWeek: estimateProgressionRate(recentSets, baseEx),
          todayIso,
        });
        exercises.push(
          prescribePrimaryFromPhase({
            baseExercise: baseEx,
            phase,
            currentWorkingKg,
            lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx),
            rirTarget,
            baselineSets: baseEx.sets ?? 3,
            baselineReps: baseEx.baseReps ?? 6,
          })
        );
      } else if (isPrimary) {
        const currentWorkingKg =
          maintenanceLoadFor(baseEx.name, rirTarget, recentSets, todayIso) ??
          baseEx.baseKg ?? 0;
        exercises.push(
          prescribeSecondaryAutoregulated({
            baseExercise: baseEx,
            currentWorkingKg,
            lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx),
            consecutiveRirMisses: consecutiveMisses(recentSets, baseEx),
            maintenanceBaselineKg: isFocusBlock ? currentWorkingKg : null,
            focusBlockClampMultiplier: isFocusBlock ? FOCUS_BLOCK_CLAMP : null,
            baselineSets: baseEx.sets ?? 3,
            baselineReps: baseEx.baseReps ?? 6,
            isFocusBlock,
          })
        );
      } else {
        // Accessory — volume-balance for sets; autoreg-derived load. Muscle-volume
        // context wiring lands in Task 11; for now use a sensible default band.
        const autoreg = prescribeSecondaryAutoregulated({
          baseExercise: baseEx,
          currentWorkingKg:
            maintenanceLoadFor(baseEx.name, rirTarget, recentSets, todayIso) ??
            baseEx.baseKg ?? 0,
          lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx),
          consecutiveRirMisses: 0,
          maintenanceBaselineKg: null,
          focusBlockClampMultiplier: null,
          baselineSets: baseEx.sets ?? 3,
          baselineReps: baseEx.baseReps ?? 8,
          isFocusBlock: false,
        });
        const band: VolumeBandPosition = classifyVolumeBandForMuscle(baseEx, volumeContext);
        exercises.push(
          prescribeAccessoryFromVolumeBand({
            baseExercise: autoreg,
            currentSets: autoreg.sets ?? baseEx.sets ?? 3,
            bandPosition: band,
          })
        );
      }
    }

    out[weekday] = exercises;
  }

  return out;
}

// ── data adapter ──────────────────────────────────────────────────────────

async function fetchRecentSets(
  supabase: SupabaseClient,
  userId: string,
  todayIso: string,
): Promise<WorkoutSetSample[]> {
  const cutoff = subtractDaysIso(todayIso, 28);
  const { data, error } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", userId)
    .gte("date", cutoff)
    .order("date", { ascending: false });
  if (error || !data) return [];

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
  type RawExercise = { name: string; exercise_sets: RawSet[] | null };
  type RawWorkout = { date: string; exercises: RawExercise[] | null };

  const rows = data as unknown as RawWorkout[];
  const out: WorkoutSetSample[] = [];
  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      for (const s of ex.exercise_sets ?? []) {
        if (s.kg == null || s.reps == null) continue;
        out.push({
          exercise_name: ex.name,
          exercise_key: null,
          kg: s.kg,
          reps: s.reps,
          warmup: !!s.warmup,
          failure: !!s.failure,
          performed_on: w.date,
        });
      }
    }
  }
  return out;
}

/** Fetch the 8-week rolling per-muscle volume snapshot. Returns null on
 *  failure — callers degrade gracefully to "in_band" (no-op). */
async function fetchVolumeContext(
  supabase: SupabaseClient,
  userId: string,
  todayIso: string,
): Promise<MuscleVolumeSnapshot | null> {
  try {
    return await fetchMuscleVolumeServer(supabase, userId, todayIso);
  } catch {
    return null;
  }
}

// ── pure inference helpers ─────────────────────────────────────────────────

/** Returns true if the most-recent non-warmup set for this exercise was a
 *  clean working set (not failure, hit or exceeded prescribed reps). */
function lastWeekClean(sets: WorkoutSetSample[], ex: PlannedExercise): boolean {
  const matching = setsForExercise(sets, ex);
  const top = matching[0]; // recent-first
  if (top == null) return false;
  if (top.failure) return false;
  if (ex.baseReps != null && top.reps < ex.baseReps) return false;
  return true;
}

/** Count consecutive recent non-warmup sets that were dirty (failure or
 *  fell short of prescribed reps). Walks newest-first; stops at first clean. */
function consecutiveMisses(sets: WorkoutSetSample[], ex: PlannedExercise): number {
  const matching = setsForExercise(sets, ex);
  let misses = 0;
  for (const s of matching) {
    const clean = !s.failure && (ex.baseReps == null || s.reps >= ex.baseReps);
    if (clean) break;
    misses++;
  }
  return misses;
}

/** Estimate weekly load-progression rate (kg/week) from the user's recent
 *  non-warmup sets for this exercise. Used by evaluateBlockPhase to detect
 *  off_pace. Returns 0 when fewer than 2 sets exist. */
function estimateProgressionRate(sets: WorkoutSetSample[], ex: PlannedExercise): number {
  const matching = setsForExercise(sets, ex).slice(0, 8);
  if (matching.length < 2) return 0;
  const newest = matching[0].kg;
  const oldest = matching[matching.length - 1].kg;
  const weeks = Math.max(
    1,
    Math.round(dateDiffDays(matching[matching.length - 1].performed_on, matching[0].performed_on) / 7),
  );
  return (newest - oldest) / weeks;
}

function setsForExercise(sets: WorkoutSetSample[], ex: PlannedExercise): WorkoutSetSample[] {
  const target = ex.name.toLowerCase();
  return sets.filter((s) => !s.warmup && s.exercise_name.toLowerCase() === target);
}

// ── volume-band classification ─────────────────────────────────────────────

/** Resolve the accessory's primary targeted-muscle group from its name.
 *  Walks the static EXERCISE_MUSCLES → first primary MuscleId → collapse via
 *  TARGET_GROUP_FOR_MUSCLE. Returns null when the exercise is unmapped or
 *  maps only to non-targeted muscles (Abs / Obliques / FrontDelts / Serratus). */
function inferPrimaryTargetedMuscle(baseEx: PlannedExercise): TargetedMuscleGroup | null {
  const mapping = getExerciseMuscles(baseEx.name);
  if (!mapping) return null;
  for (const mid of mapping.primary) {
    const group = TARGET_GROUP_FOR_MUSCLE[mid];
    if (group) return group;
  }
  return null;
}

/** Classify the accessory's muscle into a VolumeBandPosition using the
 *  user's 8-week rolling volume vs literature-default MEV/MAV/MRV bands.
 *  Falls back to "in_band" (no-op) when context is missing or the exercise
 *  isn't mapped to one of the 10 targeted groups. */
function classifyVolumeBandForMuscle(
  baseEx: PlannedExercise,
  ctx: MuscleVolumeSnapshot | null,
): VolumeBandPosition {
  if (ctx == null) return "in_band";
  const group = inferPrimaryTargetedMuscle(baseEx);
  if (!group) return "in_band";
  const actualWeeklySets = ctx.rolling_avg_8wk[group];
  if (actualWeeklySets == null) return "in_band";
  // No per-user training-age tier is plumbed through prescribeWeek; use the
  // intermediate literature default (matches the INTERMEDIATE baseline that
  // compose-strength.ts scales from). Tier-aware bands are a future upgrade
  // once plan_payload is available here.
  const band = literatureBand(group, "intermediate");
  return classifyVolumeBand({
    actualWeeklySets,
    mev: band.mev,
    // classifyVolumeBand expects a scalar mav; use the upper bound of the
    // MAV tuple — the function only references mev/mrv operationally so the
    // mav field is informational, but we pass the meaningful endpoint.
    mav: band.mav[1],
    mrv: band.mrv,
  });
}

// ── date helpers ───────────────────────────────────────────────────────────

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(db - da) / (24 * 60 * 60 * 1000);
}
