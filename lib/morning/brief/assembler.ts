// lib/morning/brief/assembler.ts
//
// Pure composition of the brief card from raw inputs. Produces everything
// except advice_md (that comes from the AI call in advice-prompt.ts).
// No I/O, fully deterministic, unit-testable in isolation.

import type {
  MorningBriefCard,
  MorningBriefCoachSuggestion,
  MorningBriefExercise,
  MorningBriefHydration,
  MorningBriefVariant,
  MorningBriefRecap,
  MorningBriefMacros,
  MorningBriefReadiness,
  MorningBriefTonight,
  CheckinRow,
  DailyLog,
  IntensityModifier,
  PrimaryLift,
  AthleteProfileDocument,
  MuscleVolumeFlag,
  TrainingWeek,
  WeeklyReviewRow,
  ThisWeekPlanBlock,
} from "@/lib/data/types";
import { SESSION_PLANS, type PlannedExercise, getEffectiveSessionPlan } from "@/lib/coach/sessionPlans";
import { annotateSession } from "@/lib/coach/session-structure";
import type { ExerciseOverrides } from "@/lib/data/types";
import { roundToValidWeight, minNonZeroIncrement } from "@/lib/coach/weight-rounding";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";
import { composeYesterdayVsPlan, type YesterdayWorkoutForBlock } from "@/lib/morning/brief/yesterday-vs-plan";

/** Yesterday's workout summary — pre-aggregated by the data source. */
export type YesterdayWorkoutSummary = {
  type: string | null;                         // "Legs" | "REST" | null
  top_e1rm: { lift: string; kg: number } | null;
};

/** WHOOP baselines from profiles.whoop_baselines. Shape may include other
 *  fields; we read only the SWC band fields here. */
export type WhoopBaselineForBand = {
  hrv_swc_low?: number | null;
  hrv_swc_high?: number | null;
};

export type BriefInputs = {
  today: string;                               // "YYYY-MM-DD"
  yesterday: string;                           // "YYYY-MM-DD"
  sessionType: string;                         // "Legs" | "Chest" | ... | "REST"
  sessionStartTime: string | null;             // "13:00" for training; null for rest
  intensityModifier: IntensityModifier;        // {} when no active block
  primaryLift: PrimaryLift | null;             // active block's primary lift if any
  todayTargets: TodayTargets | null;           // null when no active athlete profile
  yesterdayLog: DailyLog | null;
  yesterdayWorkout: YesterdayWorkoutSummary | null;
  todayCheckin: CheckinRow | null;
  todayLog: DailyLog | null;                   // for HRV / recovery
  whoopBaselines: WhoopBaselineForBand | null;
  activeProfile: AthleteProfileDocument | null;
  /** True iff a training_weeks row exists for the week containing today.
   *  Gates the coach_suggestion chip — if false, the chip's POST would 404. */
  hasTrainingWeek: boolean;
  /** Top-2 muscle-volume flags evaluated by evaluateMuscleVolumeGapsForBrief.
   *  Empty when the active plan has no muscle_volume or no flags fire. */
  muscleVolumeFlags?: MuscleVolumeFlag[];
  /** The committed training_weeks row + committed weekly_review for the
   *  current week. Populated by getThisWeekPrescription in data-sources.
   *  Null when either is missing — triggers the legacy 'training' fallback. */
  thisWeekPrescription: { trainingWeek: TrainingWeek; review: WeeklyReviewRow } | null;
  /** Yesterday's workout in the flat shape the yesterday-vs-plan composer
   *  consumes. Null when no workout logged. */
  yesterdayWorkoutForBlock: YesterdayWorkoutForBlock | null;
  /** True when yesterday's actual session type differs from
   *  training_weeks.original_session_plan for yesterday. Per migration 0012. */
  swapAppliedYesterday: boolean;
  /** True when this week's block_phase_now differs from last week's
   *  committed review. Drives the kickoff "phase changed this week"
   *  explainer in the AI prompt + the renderer's NEW PHASE chip. */
  phaseTransitionThisWeek: boolean;
};

export function assembleBriefExceptAdvice(
  inputs: BriefInputs,
): Omit<MorningBriefCard, "advice_md"> {
  const variant: MorningBriefVariant = pickVariant(
    inputs.sessionType,
    inputs.today,
    inputs.thisWeekPrescription,
  );
  const readiness = composeReadiness(inputs);

  const thisWeekPlan =
    variant === "kickoff" && inputs.thisWeekPrescription
      ? composeThisWeekPlan(inputs.thisWeekPrescription, inputs.phaseTransitionThisWeek)
      : null;

  const yesterdayVsPlan =
    variant === "analytical" && inputs.thisWeekPrescription
      ? composeYesterdayVsPlan({
          yesterdayWeekday: shortWeekdayFromDate(inputs.yesterday),
          trainingWeek: inputs.thisWeekPrescription.trainingWeek,
          review: inputs.thisWeekPrescription.review,
          yesterdayWorkout: inputs.yesterdayWorkoutForBlock,
          swapApplied: inputs.swapAppliedYesterday,
        })
      : null;

  return {
    variant,
    readiness,
    recap: composeRecap(inputs),
    session: composeSession(variant, inputs),
    hydration: composeHydration(inputs),
    macros: composeMacros(inputs),
    tonight: composeTonight(inputs),
    coach_suggestion: pickCoachSuggestion(
      readiness.band,
      inputs.sessionType,
      inputs.hasTrainingWeek,
    ),
    this_week_plan: thisWeekPlan,
    yesterday_vs_plan: yesterdayVsPlan,
  };
}

function pickVariant(
  sessionType: string,
  today: string,
  thisWeekPrescription: BriefInputs["thisWeekPrescription"],
): MorningBriefVariant {
  if (/^rest$/i.test(sessionType)) return "rest";
  if (!thisWeekPrescription) return "training"; // legacy fallback

  const weekday = weekdayFromDate(today);
  if (weekday === "Monday") return "kickoff";
  // Sunday is the last day of the week. Kickoff is Mon-only; analytical
  // is the Tue-Sat window. A non-REST Sunday session (rare) falls to the
  // legacy training variant so the existing brief renders correctly without
  // forcing an end-of-week "yesterday vs plan" comparison.
  if (weekday === "Sunday") return "training";
  return "analytical";
}

function weekdayFromDate(yyyyMmDd: string): string {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
}

function shortWeekdayFromDate(
  yyyyMmDd: string,
): "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  return (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const)[d.getUTCDay()];
}

function composeReadiness(inputs: BriefInputs): MorningBriefReadiness {
  const score = inputs.todayCheckin?.readiness ?? null;
  const hrv = inputs.todayLog?.hrv ?? null;
  const recovery = inputs.todayLog?.recovery ?? null;
  return {
    score,
    hrv,
    recovery,
    band: deriveReadinessBand(score, hrv, inputs.whoopBaselines),
  };
}

/** Deterministic trigger for the morning brief's coach_suggestion chip.
 *  Fires only when:
 *  - A training_weeks row exists for today (so the swap POST can target it).
 *  - Readiness band is 'low'.
 *  - Today's session is not already REST or Mobility.
 *  All other cases return null and no chip renders.
 */
export function pickCoachSuggestion(
  band: "low" | "moderate" | "high",
  sessionType: string,
  hasTrainingWeek: boolean,
): MorningBriefCoachSuggestion {
  if (!hasTrainingWeek) return null;
  if (band !== "low") return null;
  const lower = sessionType.toLowerCase().trim();
  if (lower === "rest" || lower === "mobility") return null;
  return { kind: "swap_to_mobility", rationale: "low_readiness" };
}

/** Two-signal triangulation. Mirrors the convention in
 *  lib/coach/autoregulation.ts — surface, never auto-apply. */
function deriveReadinessBand(
  score: number | null,
  hrv: number | null,
  baselines: WhoopBaselineForBand | null,
): "low" | "moderate" | "high" {
  if (score === null) return "moderate";
  const hrvLow = baselines?.hrv_swc_low ?? null;
  const hrvHigh = baselines?.hrv_swc_high ?? null;
  if (score <= 5 || (hrv !== null && hrvLow !== null && hrv < hrvLow)) {
    return "low";
  }
  if (score >= 8 && (hrv === null || hrvHigh === null || hrv >= hrvHigh)) {
    return "high";
  }
  return "moderate";
}

function composeRecap(inputs: BriefInputs): MorningBriefRecap {
  const t = inputs.todayTargets;
  // Sleep source: TODAY's daily_log row (not yesterday's). PR #50 keys WHOOP
  // cycles by the *waking* day, so last-night's sleep lives on today's row.
  // Yesterday's row holds the night BEFORE last — which would render as a
  // 24h-stale number in the "yesterday" recap block. Falls back to yesterday's
  // row if today's hasn't been populated yet (early morning, pre-WHOOP-sync).
  const sleepHours =
    inputs.todayLog?.sleep_hours ?? inputs.yesterdayLog?.sleep_hours ?? null;
  return {
    yesterday_date: inputs.yesterday,
    sleep_hours: sleepHours,
    kcal_actual: inputs.yesterdayLog?.calories_eaten ?? null,
    kcal_target: t?.kcal ?? 0,
    protein_actual_g: inputs.yesterdayLog?.protein_g ?? null,
    protein_target_g: t?.protein_g ?? 0,
    trained_yesterday: inputs.yesterdayWorkout?.type ?? null,
    top_e1rm_yesterday: inputs.yesterdayWorkout?.top_e1rm ?? null,
  };
}

function composeHydration(inputs: BriefInputs): MorningBriefHydration | null {
  const t = inputs.todayTargets;
  if (t?.hydration_target_ml == null || !t.is_training_day) return null;
  return {
    water_ml: t.hydration_target_ml,
    sodium_mg: t.sodium_target_mg ?? 0,
    note: "GLP-1 can suppress thirst — front-load water & sodium around session.",
  };
}

function composeMacros(inputs: BriefInputs): MorningBriefMacros {
  const t = inputs.todayTargets;
  return {
    kcal_target: t?.kcal ?? 0,
    protein_target_g: t?.protein_g ?? 0,
    carb_target_g: t?.carb_g ?? 0,
    fat_target_g: t?.fat_g ?? 0,
  };
}

function composeTonight(inputs: BriefInputs): MorningBriefTonight {
  const t = inputs.todayTargets;
  return {
    sleep_target_hours: t?.sleep_hours_target ?? 7.5,
    bedtime_target: t?.bedtime ?? "22:30",
  };
}

function composeSession(
  variant: MorningBriefVariant,
  inputs: BriefInputs,
): MorningBriefCard["session"] {
  const volume_gaps = buildVolumeGaps(inputs.muscleVolumeFlags);

  if (variant === "rest") {
    return {
      type: inputs.sessionType,
      start_time: null,
      exercises: [],
      ...(volume_gaps !== undefined ? { volume_gaps } : {}),
    };
  }
  const overrides =
    (inputs.thisWeekPrescription?.trainingWeek?.exercise_overrides as
      | ExerciseOverrides
      | null
      | undefined) ?? null;
  const weekday = weekdayFromDate(inputs.today);
  const effectivePlan = getEffectiveSessionPlan(
    inputs.sessionType,
    weekday,
    overrides,
  );
  const structure =
    effectivePlan.length === 0 ? null : annotateSession(effectivePlan);

  return {
    type: inputs.sessionType,
    start_time: inputs.sessionStartTime ?? "13:00", // default 1pm per spec
    exercises: composeExercises(
      inputs.sessionType,
      inputs.intensityModifier,
      inputs.primaryLift,
      effectivePlan,
    ),
    structure,
    ...(volume_gaps !== undefined ? { volume_gaps } : {}),
  };
}

/** Collapses the MuscleVolumeFlag union into the flat volume_gaps render shape.
 *  Returns undefined (not empty array) when no flags are provided so the field
 *  is omitted from the card entirely (keeps JSON lean). */
function buildVolumeGaps(
  flags: MuscleVolumeFlag[] | undefined,
): MorningBriefCard["session"]["volume_gaps"] {
  if (!flags || flags.length === 0) return undefined;

  return flags.map((f) => {
    if (f.kind === "near_mrv") {
      return {
        group: f.group,
        actual: f.actual_wtd,
        target: f.mrv,
        label: "near_mrv" as const,
      };
    }
    if (f.kind === "below_mev_persistent") {
      return {
        group: f.group,
        actual: f.actual_8wk,
        target: f.mev,
        label: "below_mev" as const,
      };
    }
    // below_mev_recent
    return {
      group: f.group,
      actual: f.actual_wtd,
      target: f.target_this_week,
      label: "below_mev" as const,
    };
  });
}

function composeExercises(
  sessionType: string,
  modifier: IntensityModifier,
  primaryLift: PrimaryLift | null,
  planOverride?: PlannedExercise[],
): MorningBriefExercise[] {
  const plan: PlannedExercise[] = planOverride ?? SESSION_PLANS[sessionType] ?? [];
  return plan
    .filter((p) => !p.warmup)
    .map((p): MorningBriefExercise => {
      const liftFromKey = inferLiftFromKey(p.key);
      const liftModifier =
        liftFromKey !== null && liftFromKey === primaryLift
          ? (modifier[liftFromKey] ?? 1.0)
          : 1.0;
      let scaledKg: number | null = null;
      if (p.baseKg != null) {
        const target = p.baseKg * liftModifier;
        scaledKg = p.increment ? roundToValidWeight(target, p.increment) : Math.round(target * 2) / 2;
      }
      const result: MorningBriefExercise = {
        name: p.name,
        sets: p.sets ?? 3,
        reps: p.baseReps ?? 8,
        kg: scaledKg,
      };
      if (p.note) result.note = p.note;
      if (p.increment) result.min_increment_kg = minNonZeroIncrement(p.increment);
      return result;
    });
}

/** Maps SESSION_PLANS exercise.key strings to the canonical PrimaryLift enum.
 *  Only the four primary lifts get intensity-modifier scaling; everything else
 *  uses baseKg as-is. */
function inferLiftFromKey(key: string | undefined): PrimaryLift | null {
  if (!key) return null;
  if (key === "squat") return "squat";
  if (key === "decline_bench" || key === "incline_db" || key === "bench") return "bench";
  if (key === "deadlift") return "deadlift";
  if (key === "ohp") return "ohp";
  return null;
}

/** Builds the kickoff-variant THIS WEEK PLAN block from the committed
 *  weekly_review's prescription + volume payload. phase_changed_this_week
 *  is authoritative from upstream flag computation (flags.ts) — the assembler
 *  threads it via BriefInputs rather than re-deriving it here. */
function composeThisWeekPlan(
  prescription: NonNullable<BriefInputs["thisWeekPrescription"]>,
  phaseTransitionThisWeek: boolean,
): ThisWeekPlanBlock {
  const { review } = prescription;
  const header = review.payload.header;
  const presc = review.payload.prescription;
  const volumeFromPayload = review.payload.volume?.per_muscle ?? [];

  return {
    schema_version: 1,
    week_n: header.week_n,
    total_weeks: header.total_weeks,
    phase_now: header.block_phase_now,
    phase_changed_this_week: phaseTransitionThisWeek,
    per_lift: presc.per_lift.map((p) => ({
      lift: p.lift,
      load_kg: p.weight_kg,
      sets: p.sets,
      reps: p.reps,
      rir_target: presc.rir_target,
      delta_from_last_week_pct: p.delta_pct_from_last_week,
    })),
    volume_summary: volumeFromPayload.map((v) => ({
      muscle: v.muscle,
      sets: v.next_week_sets,
      tier: v.tier,
    })),
    weekly_focus: presc.weekly_focus ?? null,
  };
}
