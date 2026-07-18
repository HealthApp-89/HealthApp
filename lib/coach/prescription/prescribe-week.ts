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
  Weekday,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { evaluateBlockPhase, prescribePrimaryFromPhase } from "@/lib/coach/prescription/block-phase-rule";
import { currentComparisonValueForLift } from "@/lib/coach/prescription/current-comparison-value";
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule";
import { prescribeAccessoryDoubleProgression } from "@/lib/coach/prescription/double-progression-rule";
import { prescribeAccessoryFromVolumeBand, classifyVolumeBand, type VolumeBandPosition } from "@/lib/coach/prescription/volume-balance-rule";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { roundToStep } from "@/lib/coach/prescription/calibrate-target";
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
import { resolveExercise } from "@/lib/coach/exercise-library";
import { loadPlannedActivities } from "@/lib/coach/activity/read-planned";
import { proposeActivityAwareLayout, SESSION_REGION_MAP } from "@/lib/coach/activity/sequence-week";
import type { MuscleRegion } from "@/lib/coach/activity/types";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { BIG_FOUR_SET } from "@/lib/coach/session-structure/tiers";
import { applyStructureOverrides } from "@/lib/coach/prescription/structure-overrides";

const FOCUS_BLOCK_CLAMP = 0.92;

// ── Activity-aware lighten helpers ─────────────────────────────────────────────

/** Map from long weekday name → short Weekday (used by proposeActivityAwareLayout). */
const LONG_TO_SHORT: Record<string, Weekday> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

/** TargetedMuscleGroup → MuscleRegion mapping for per-exercise lighten gating.
 *  Exercises whose primary targeted muscle falls in an affected region should
 *  have their volume trimmed. Falls back to session-level gating when unknown. */
const TARGETED_GROUP_TO_REGION: Partial<Record<TargetedMuscleGroup, MuscleRegion>> = {
  Quads: "legs",
  Hams: "legs",
  Glutes: "legs",
  Calves: "legs",
  Chest: "chest",
  Lats: "back",
  Traps: "back",
  RearDelts: "shoulders",
  Biceps: "arms",
  Triceps: "arms",
};

/**
 * Determine the primary MuscleRegion for an exercise by name.
 * Uses getExerciseMuscles → TARGET_GROUP_FOR_MUSCLE → TARGETED_GROUP_TO_REGION.
 * Returns null when the exercise is unmapped or targets non-regional muscles.
 */
export function exerciseRegion(name: string): MuscleRegion | null {
  const mapping = getExerciseMuscles(name);
  if (!mapping) return null;
  for (const mid of mapping.primary) {
    const group = TARGET_GROUP_FOR_MUSCLE[mid];
    if (group) {
      const region = TARGETED_GROUP_TO_REGION[group];
      if (region) return region;
    }
  }
  return null;
}

export type LightenTier =
  | "primary_compound"
  | "eccentric_accessory"
  | "other_accessory";

/**
 * Classify an exercise for activity-aware lightening. Drives the magnitude of
 * the volume cut and the RIR bump (evidence-based: hold the compound as a
 * low-volume primer, gut the eccentric accessory volume that drives DOMS).
 *   - primary_compound:     a known primary lift OR a BIG_FOUR member.
 *   - eccentric_accessory:  not primary, region overlaps the affected set, and
 *                           it's high-rep/isolation (baseReps ≥ 10).
 *   - other_accessory:      everything else that reaches the lighten path.
 */
export function classifyLightenTier(
  ex: PlannedExercise,
  affectedRegions: MuscleRegion[],
): LightenTier {
  const isPrimary = inferPrimaryLiftFromName(ex.name) != null || BIG_FOUR_SET.has(ex.name);
  if (isPrimary) return "primary_compound";
  const region = exerciseRegion(ex.name);
  const inAffected = region != null && affectedRegions.includes(region);
  const highRepOrIsolation = (ex.baseReps ?? 0) >= 10;
  if (inAffected && highRepOrIsolation) return "eccentric_accessory";
  return "other_accessory";
}

/**
 * Apply a tiered, RIR-aware volume lighten to one exercise. Load (baseKg) is
 * always held — the research lever is volume + RIR, never intensity on the
 * main lift. Warmups and target-less exercises are untouched. Region gating is
 * preserved: an exercise whose region doesn't overlap the affected set (and
 * whose session has no fallback overlap) is returned unchanged.
 */
export function lightenExercise(
  ex: PlannedExercise,
  sessionType: string,
  affectedRegions: MuscleRegion[],
): PlannedExercise {
  if (ex.warmup) return ex;
  if (ex.sets == null && ex.baseReps == null) return ex;

  const exRegion = exerciseRegion(ex.name);
  if (exRegion !== null) {
    if (!affectedRegions.includes(exRegion)) return ex;
  } else {
    const sessionRegs = SESSION_REGION_MAP[sessionType] ?? [];
    if (!sessionRegs.some((r) => affectedRegions.includes(r))) return ex;
  }

  const baseRir = ex.rir ?? 2; // week default rir_target is 2
  const trim = (n: number | undefined, by: number, floor: number) =>
    n != null ? Math.max(floor, n - by) : n;

  const tier = classifyLightenTier(ex, affectedRegions);
  if (tier === "primary_compound") {
    return { ...ex, sets: trim(ex.sets, 1, 2), baseReps: trim(ex.baseReps, 1, 1), rir: Math.min(5, baseRir + 1) };
  }
  if (tier === "eccentric_accessory") {
    return { ...ex, sets: trim(ex.sets, 2, 1), baseReps: trim(ex.baseReps, 2, 1), rir: Math.min(5, baseRir + 2) };
  }
  return { ...ex, sets: trim(ex.sets, 1, 1), baseReps: trim(ex.baseReps, 1, 1), rir: Math.min(5, baseRir + 1) };
}

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

  // ── Activity-aware lighten: load planned activities for the week and detect
  //    which days should have their volume trimmed due to sport/activity overlap.
  //
  //    GRACEFUL: any failure (fetch error, empty profile, missing columns) →
  //    lightenDays stays empty → prescriptions are byte-identical to today's
  //    behavior. Users with no activities see zero change.
  let lightenDays: Record<string, MuscleRegion[]> = {};
  try {
    const plannedActivities = await loadPlannedActivities(supabase, userId, week, todayIso);
    if (plannedActivities.length > 0) {
      // Build a DaysAvailable from session_plan: a day is "available" when it
      // already has a training session (not REST/Mobility/unset). This tells
      // the planner which days the athlete is willing to train on.
      const sessionPlan = week.session_plan ?? {};
      // Use readSessionForDay for key-agnostic lookups: production data uses
      // full weekday names ("Monday") but short-keyed plans ("Mon") are also
      // valid. Direct indexing by short key silently returns undefined on prod data.
      const daysAvailable = {
        mon: !!(readSessionForDay(sessionPlan, "Mon") && readSessionForDay(sessionPlan, "Mon") !== "REST"),
        tue: !!(readSessionForDay(sessionPlan, "Tue") && readSessionForDay(sessionPlan, "Tue") !== "REST"),
        wed: !!(readSessionForDay(sessionPlan, "Wed") && readSessionForDay(sessionPlan, "Wed") !== "REST"),
        thu: !!(readSessionForDay(sessionPlan, "Thu") && readSessionForDay(sessionPlan, "Thu") !== "REST"),
        fri: !!(readSessionForDay(sessionPlan, "Fri") && readSessionForDay(sessionPlan, "Fri") !== "REST"),
        sat: !!(readSessionForDay(sessionPlan, "Sat") && readSessionForDay(sessionPlan, "Sat") !== "REST"),
        sun: !!(readSessionForDay(sessionPlan, "Sun") && readSessionForDay(sessionPlan, "Sun") !== "REST"),
      };
      const result = proposeActivityAwareLayout({
        sessionPlan,
        plannedActivities,
        daysAvailable,
        block: block ?? undefined,
        today: todayIso,
      });
      lightenDays = result.lightenDays;
    }
  } catch {
    // Graceful: activity load or layout proposal failed → no lighten applied.
    lightenDays = {};
  }

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
            lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, rirTarget),
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
            lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, rirTarget),
            consecutiveRirMisses: consecutiveMisses(recentSets, baseEx, rirTarget),
            maintenanceBaselineKg: isFocusBlock ? currentWorkingKg : null,
            focusBlockClampMultiplier: isFocusBlock ? FOCUS_BLOCK_CLAMP : null,
            baselineSets: baseEx.sets ?? 3,
            baselineReps: baseEx.baseReps ?? 6,
            isFocusBlock,
            blockPhase,
          })
        );
      } else {
        // Accessory — double progression owns LOAD + REPS (rep range derived
        // from library loadability; rung re-derived from 28d history), while
        // volume-balance owns SETS — except deload_week, where the rule's
        // hold-load/half-sets output is final (see double-progression-rule.ts).
        const accessoryWorkingKg =
          maintenanceLoadFor(baseEx.name, rirTarget, recentSets, todayIso) ??
          baseEx.baseKg ?? 0;
        const lib = resolveExercise(baseEx.name);
        const staticEx = (SESSION_PLANS[sessionType] ?? []).find(
          (e) => !e.warmup && e.name === baseEx.name,
        );
        const dp = prescribeAccessoryDoubleProgression({
          baseExercise: baseEx,
          currentWorkingKg: accessoryWorkingKg,
          recentSets,
          rirTarget,
          blockPhase,
          loadability: lib?.loadability ?? "moderate",
          bottomReps: staticEx?.baseReps ?? baseEx.baseReps ?? 8,
        });
        if (blockPhase === "deload_week") {
          exercises.push(dp);
        } else {
          const band: VolumeBandPosition = classifyVolumeBandForMuscle(baseEx, volumeContext);
          exercises.push(
            prescribeAccessoryFromVolumeBand({
              baseExercise: dp,
              currentSets: baseEx.sets ?? 3,
              bandPosition: band,
            }),
          );
        }
      }
    }

    // Apply block-scope structure overrides (athlete-owned order + set counts)
    // BEFORE warmup post-processing so warmups derive from the post-override
    // structure: new first exercise gets the warmups, overridden set counts
    // are what the warmup "+2 sets" rule stacks on top of.
    const structured = applyStructureOverrides(exercises, sessionType, block?.session_structure_overrides ?? null);
    const augmented = augmentFirstLoadedCompoundWithWarmups(structured);

    // Apply lighten: if this weekday has affected regions (from activity
    // overlap), trim volume on exercises that target those regions.
    // lightenDays uses Weekday short-form keys ("Mon"); weekday here is
    // WeekdayLong ("Monday") — convert to short for the lookup.
    const weekdayShort = LONG_TO_SHORT[weekday];
    const affectedRegions = weekdayShort ? lightenDays[weekdayShort] : undefined;

    if (affectedRegions && affectedRegions.length > 0) {
      out[weekday] = augmented.map((ex) =>
        lightenExercise(ex, sessionType, affectedRegions),
      );
    } else {
      out[weekday] = augmented;
    }
  }

  return out;
}

// ── Activity layout proposal (exported for Sunday cron + weekly review) ─────────

/**
 * Compute the activity-aware layout proposal for a given week.
 *
 * Returns `proposedPlan` (day moves), `lightenDays` (volume-trim signals),
 * and `flags` (unresolvable conflicts for athlete review). Graceful: any
 * fetch failure → empty result (same as "no activities").
 *
 * Callers that want to surface the proposal to the athlete:
 *   - Compare `proposedPlan` vs `week.session_plan` to find moved days
 *   - Present moved days + flag rationale strings to the athlete
 *   - On Approve, call POST /api/training-weeks/[week_start]/apply-activity-layout
 *     with `proposedPlan` to apply via the existing swap engine
 */
export async function computeActivityLayoutProposal(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  week: TrainingWeek;
  todayIso: string;
}): Promise<{
  proposedPlan: import("@/lib/data/types").SessionPlan;
  lightenDays: Record<string, MuscleRegion[]>;
  flags: import("@/lib/coach/activity/sequence-week").ActivityConflictFlag[];
  hasMoves: boolean;
  hasFlags: boolean;
}> {
  const { supabase, userId, block, week, todayIso } = opts;
  const sessionPlan = week.session_plan ?? {};

  const empty = {
    proposedPlan: sessionPlan,
    lightenDays: {},
    flags: [],
    hasMoves: false,
    hasFlags: false,
  };

  try {
    const plannedActivities = await loadPlannedActivities(supabase, userId, week, todayIso);
    if (plannedActivities.length === 0) return empty;

    // Use readSessionForDay for key-agnostic lookups (same rationale as above).
    const daysAvailable = {
      mon: !!(readSessionForDay(sessionPlan, "Mon") && readSessionForDay(sessionPlan, "Mon") !== "REST"),
      tue: !!(readSessionForDay(sessionPlan, "Tue") && readSessionForDay(sessionPlan, "Tue") !== "REST"),
      wed: !!(readSessionForDay(sessionPlan, "Wed") && readSessionForDay(sessionPlan, "Wed") !== "REST"),
      thu: !!(readSessionForDay(sessionPlan, "Thu") && readSessionForDay(sessionPlan, "Thu") !== "REST"),
      fri: !!(readSessionForDay(sessionPlan, "Fri") && readSessionForDay(sessionPlan, "Fri") !== "REST"),
      sat: !!(readSessionForDay(sessionPlan, "Sat") && readSessionForDay(sessionPlan, "Sat") !== "REST"),
      sun: !!(readSessionForDay(sessionPlan, "Sun") && readSessionForDay(sessionPlan, "Sun") !== "REST"),
    };

    const result = proposeActivityAwareLayout({
      sessionPlan,
      plannedActivities,
      daysAvailable,
      block: block ?? undefined,
      today: todayIso,
    });

    // Detect whether the proposed plan differs from the committed plan.
    const { plansEqual } = await import("@/lib/training-weeks/apply-swap");
    const hasMoves = !plansEqual(sessionPlan, result.proposedPlan);

    return {
      proposedPlan: result.proposedPlan,
      lightenDays: result.lightenDays,
      flags: result.flags,
      hasMoves,
      hasFlags: result.flags.length > 0,
    };
  } catch {
    return empty;
  }
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
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure, rir))")
    .eq("user_id", userId)
    .gte("date", cutoff)
    .order("date", { ascending: false });
  if (error || !data) return [];

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null; rir: number | null };
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
          rir: s.rir ?? null,
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
 *  clean working set: not failure, hit or exceeded prescribed reps, AND —
 *  when the set carries a recorded RIR — met the prescribed RIR
 *  (`ex.rir ?? rirTarget`). A set ground out below the prescribed RIR is
 *  dirty: the load was too heavy relative to plan, so the engine holds
 *  instead of stepping. `rir == null` collapses to the legacy verdict.
 *  Exported for scripts/audit-prescription-rules.mjs. */
export function lastWeekClean(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  rirTarget: number,
): boolean {
  const matching = setsForExercise(sets, ex);
  const top = matching[0]; // recent-first
  if (top == null) return false;
  if (top.failure) return false;
  if (ex.baseReps != null && top.reps < ex.baseReps) return false;
  const prescribedRir = ex.rir ?? rirTarget;
  if (top.rir != null && top.rir < prescribedRir) return false;
  return true;
}

/** Count consecutive recent non-warmup sets that were dirty (failure, fell
 *  short of prescribed reps, or ground below the prescribed RIR when RIR was
 *  recorded). Walks newest-first; stops at first clean.
 *  Exported for scripts/audit-prescription-rules.mjs. */
export function consecutiveMisses(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  rirTarget: number,
): number {
  const matching = setsForExercise(sets, ex);
  const prescribedRir = ex.rir ?? rirTarget;
  let misses = 0;
  for (const s of matching) {
    const clean =
      !s.failure &&
      (ex.baseReps == null || s.reps >= ex.baseReps) &&
      (s.rir == null || s.rir >= prescribedRir);
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
