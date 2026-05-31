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
  TargetMetric,
  WeekdayLong,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { evaluateBlockPhase, prescribePrimaryFromPhase } from "@/lib/coach/prescription/block-phase-rule";
import { currentComparisonValueForLift } from "@/lib/coach/prescription/current-comparison-value";
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule";
import { prescribeAccessoryFromVolumeBand, classifyVolumeBand, type VolumeBandPosition } from "@/lib/coach/prescription/volume-balance-rule";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { discoverEffectiveExercises } from "@/lib/coach/prescription/recent-workouts-discovery";
import type { BlockPhase, WorkoutSetSample } from "@/lib/coach/prescription/types";
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

  // Block phase is a whole-block signal — compute once using the focus lift's
  // signals, then apply uniformly to every exercise. Previously phase was
  // evaluated only inside the focus-lift branch, which meant secondaries and
  // accessories kept autoregulating during consolidation/off_pace/deload —
  // silently violating the user's mental model of "block focus = whole-system
  // discipline".
  const blockPhase: BlockPhase = isFocusBlock
    ? computeWholeBlockPhase({ block: block!, focusLift: focusLift!, week, recentSets, rirTarget, todayIso })
    : "pre_target";

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
        exercises.push(
          prescribePrimaryFromPhase({
            baseExercise: baseEx,
            phase: blockPhase,
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
            blockPhase,
          })
        );
      } else {
        // Accessory — volume-balance for sets; autoreg-derived load. The focus-
        // block clamp (and the phase gate) also apply here: accessories were
        // previously left unclamped via isFocusBlock:false, which let them
        // exceed 92% of maintenance baseline during a focus block.
        const accessoryWorkingKg =
          maintenanceLoadFor(baseEx.name, rirTarget, recentSets, todayIso) ??
          baseEx.baseKg ?? 0;
        const autoreg = prescribeSecondaryAutoregulated({
          baseExercise: baseEx,
          currentWorkingKg: accessoryWorkingKg,
          lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx),
          consecutiveRirMisses: 0,
          maintenanceBaselineKg: isFocusBlock ? accessoryWorkingKg : null,
          focusBlockClampMultiplier: isFocusBlock ? FOCUS_BLOCK_CLAMP : null,
          baselineSets: baseEx.sets ?? 3,
          baselineReps: baseEx.baseReps ?? 8,
          isFocusBlock,
          blockPhase,
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

    out[weekday] = augmentFirstLoadedCompoundWithWarmups(exercises);
  }

  return out;
}

/** Adds two ramped warmup entries before the first loaded compound of a
 *  lifting day. Encodes the rule from feedback memory `feedback-warmup-sets-
 *  rule`: Deadlift / Squat / Decline Bench / Arnold Press (the first non-
 *  warmup compound of each lifting day) get sets+2 warmups.
 *
 *  Why two entries rather than mutating `sets` on a single entry: warmup
 *  loads differ from working load (60% / 80% ramp), and PlannedExercise has
 *  one `baseKg` per entry. Emitting separate entries also lets the logger
 *  render warmup cards distinctly via `warmup: true` per memory's "logger
 *  marks 1-2 as warmup".
 *
 *  No-ops when the day has no loaded compound (e.g. Mobility days, where the
 *  first exercise is a foam-roll without baseKg) or when the first non-
 *  warmup entry already lacks baseKg. */
function augmentFirstLoadedCompoundWithWarmups(
  exercises: PlannedExercise[],
): PlannedExercise[] {
  const idx = exercises.findIndex(
    (e) => !e.warmup && e.baseKg != null && e.baseKg > 0,
  );
  if (idx === -1) return exercises;

  const compound = exercises[idx];
  const workingKg = compound.baseKg!;
  const step = compound.increment?.step ?? 2.5;

  const w1Kg = roundDownToStep(workingKg * 0.6, step);
  const w2Kg = roundDownToStep(workingKg * 0.8, step);

  // Skip warmup augmentation if the working weight is so low that the warmup
  // weights collapse to 0 — e.g. an empty-bar working set. The user's first
  // working set IS the warmup at that point.
  if (w1Kg <= 0 || w2Kg <= 0) return exercises;

  const warmup1: PlannedExercise = {
    ...compound,
    warmup: true,
    baseKg: w1Kg,
    baseReps: 5,
    sets: 1,
    note: "Warmup 1 — ramp to working set",
  };
  const warmup2: PlannedExercise = {
    ...compound,
    warmup: true,
    baseKg: w2Kg,
    baseReps: 3,
    sets: 1,
    note: "Warmup 2 — ramp to working set",
  };

  return [
    ...exercises.slice(0, idx),
    warmup1,
    warmup2,
    ...exercises.slice(idx),
  ];
}

function roundDownToStep(kg: number, step: number): number {
  return Math.floor(kg / step) * step;
}

/** Whole-block phase: find the focus lift somewhere in the upcoming week's
 *  session plan, derive its currentWorkingKg + progression rate from recent
 *  sets, then evaluate the block phase once. Phases not requiring exercise
 *  data (deload_week from calendar, consolidation from target_hit_at_week)
 *  fall through correctly even when the focus lift isn't in this week's plan. */
function computeWholeBlockPhase(opts: {
  block: TrainingBlock;
  focusLift: PrimaryLift;
  week: TrainingWeek;
  recentSets: WorkoutSetSample[];
  rirTarget: number;
  todayIso: string;
}): BlockPhase {
  const { block, focusLift, week, recentSets, rirTarget, todayIso } = opts;

  // Find the first occurrence of the focus lift across the week's session plan.
  const sessionTypes = Object.values(week.session_plan ?? {});
  let focusEx: PlannedExercise | null = null;
  for (const sessionType of sessionTypes) {
    if (sessionType === "REST" || sessionType === "Mobility") continue;
    const exs = SESSION_PLANS[sessionType] ?? [];
    for (const ex of exs) {
      if (inferPrimaryLiftFromName(ex.name) === focusLift) {
        focusEx = ex;
        break;
      }
    }
    if (focusEx) break;
  }

  // If the focus lift isn't in this week's plan, calendar/target signals still
  // determine deload_week and consolidation. off_pace requires the exercise
  // signals so it cannot fire here — that's the safe failure mode.
  if (!focusEx) {
    return evaluateBlockPhase({
      block,
      currentWorkingKg: null,
      recentProgressionRatePerWeek: null,
      todayIso,
    });
  }

  // Comparison value is metric-aware: working_weight blocks compare max kg;
  // e1rm blocks compare max Brzycki e1RM. The same value also drives the
  // progression-rate estimate so the off_pace check is internally consistent.
  const metric: TargetMetric = (block.target_metric as TargetMetric | null) ?? "working_weight";
  const currentValue =
    currentComparisonValueForLift({
      lift: focusLift,
      metric,
      recentSets,
      rirTarget,
      todayIso,
    }) ?? focusEx.baseKg ?? 0;
  return evaluateBlockPhase({
    block,
    currentWorkingKg: currentValue,
    recentProgressionRatePerWeek: estimateProgressionRate(recentSets, focusEx, metric),
    todayIso,
  });
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

/** Estimate weekly progression rate (kg/week OR e1RM/week, depending on
 *  metric) from the user's recent non-warmup sets for this exercise. Used by
 *  evaluateBlockPhase to detect off_pace. Returns 0 when fewer than 2 sets
 *  exist. For e1rm metric, sets whose reps fall outside the 1..12 Brzycki
 *  window are skipped — the slope is computed in the same value-space as
 *  the target comparison so the "required vs observed" math is consistent. */
function estimateProgressionRate(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  metric: TargetMetric,
): number {
  const matching = setsForExercise(sets, ex).slice(0, 8);
  if (matching.length < 2) return 0;
  // Convert each candidate set to its comparison value; skip sets that
  // produce null (rep out of e1RM window).
  const samples = matching
    .map((s) => {
      const v =
        metric === "e1rm"
          ? bestComparisonValue([{ kg: s.kg, reps: s.reps, warmup: false }], "e1rm")
          : s.kg;
      return v == null ? null : { v, performed_on: s.performed_on };
    })
    .filter((x): x is { v: number; performed_on: string } => x != null);
  if (samples.length < 2) return 0;
  const newest = samples[0].v;
  const oldest = samples[samples.length - 1].v;
  const weeks = Math.max(
    1,
    Math.round(dateDiffDays(samples[samples.length - 1].performed_on, samples[0].performed_on) / 7),
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
