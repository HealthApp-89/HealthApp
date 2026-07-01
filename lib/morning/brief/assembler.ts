// lib/morning/brief/assembler.ts
//
// Pure composition of the brief card from raw inputs. Produces everything
// except advice_md (that comes from the AI call in advice-prompt.ts).
// No I/O, fully deterministic, unit-testable in isolation.

import type {
  MorningBriefCard,
  MorningBriefCoachSuggestion,
  MorningBriefEndurance,
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
import type { EnduranceSessionPlan } from "@/lib/coach/endurance/types";
import { SESSION_PLANS, type PlannedExercise, getEffectiveSessionPlan } from "@/lib/coach/sessionPlans";
import { annotateSession } from "@/lib/coach/session-structure";
import type { ExerciseOverrides } from "@/lib/data/types";
import { roundToValidWeight, minNonZeroIncrement } from "@/lib/coach/weight-rounding";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";
import { composeYesterdayVsPlan, type YesterdayWorkoutForBlock } from "@/lib/morning/brief/yesterday-vs-plan";
import type { MuscleRegion } from "@/lib/coach/activity/types";
import type { RecentActivitySignal } from "@/lib/coach/activity/reactive-ladder";
import { selectReactiveRung } from "@/lib/coach/activity/reactive-ladder";
import { SESSION_REGION_MAP } from "@/lib/coach/activity/sequence-week";
import { deriveReadiness } from "@/lib/ui/score";

/** Yesterday's workout summary — pre-aggregated by the data source. */
export type YesterdayWorkoutSummary = {
  type: string | null;                         // "Legs" | "REST" | null
  top_e1rm: { lift: string; kg: number } | null;
};

/** WHOOP baselines from profiles.whoop_baselines. We read:
 *  - rolling_30d.hrv.{mean,sd,status} — live anchor; SWC = ±0.5×sd
 *  - legacy hrv_swc_low / hrv_swc_high — pre-existing seed keys (typically
 *    null in practice). Kept as a fallback for resilience.
 *  See lib/whoop/baselines.ts and the 2026-05-30 baselines spec. */
export type WhoopBaselineForBand = {
  hrv_swc_low?: number | null;
  hrv_swc_high?: number | null;
  rolling_30d?: {
    hrv?: {
      mean: number | null;
      sd: number | null;
      status: "establishing" | "partial" | "stable";
    };
  };
  /** 6-month HRV average — the ratio denominator for the readiness composite,
   *  matching the dashboard ring. Falls back to 33 when absent. */
  hrv_6mo_avg?: number | null;
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
  /** HRV ratio denominator for deriveReadiness (profiles.whoop_baselines.hrv_6mo_avg
   *  ?? 33). Kept as a plain number so the brief and dashboard compute identical
   *  HRV ratios. */
  hrvBaseline: number;
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
  /** This week's endurance plan, read directly from training_weeks for the
   *  current Monday — independent of weekly_reviews state. Populated by
   *  getThisWeekEndurancePlan in data-sources. Null when no training_weeks
   *  row exists for the week or its endurance_session_plan is null.
   *  Decoupled from thisWeekPrescription because commit_endurance_week
   *  doesn't touch weekly_reviews. */
  thisWeekEndurancePlan: EnduranceSessionPlan | null;
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
  /** Recent activities still inside their recovery window, used by the
   *  reactive ladder (selectReactiveRung) to pick the graded suggestion
   *  rung. Empty array when no training_weeks row exists for today's week
   *  or when the activity load could not be fetched (graceful degradation). */
  recentActivity: RecentActivitySignal[];
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
    endurance: composeEndurance(inputs),
    macros: composeMacros(inputs),
    tonight: composeTonight(inputs),
    coach_suggestion: pickCoachSuggestion({
      band: readiness.band,
      sessionType: inputs.sessionType,
      hasTrainingWeek: inputs.hasTrainingWeek,
      intake: {
        soreness_areas: inputs.todayCheckin?.soreness_areas ?? null,
        soreness_severity: inputs.todayCheckin?.soreness_severity ?? null,
        fatigue: inputs.todayCheckin?.fatigue ?? null,
      },
      recovery: inputs.todayLog?.recovery ?? null,
      recentActivity: inputs.recentActivity,
    }),
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

/** Today's recovery signals + YESTERDAY's lifestyle (steps/calories/protein/carbs),
 *  mirroring the dashboard ring's scoreLog per the readiness-uses-yesterday rule. */
function readinessLog(inputs: BriefInputs): DailyLog | null {
  const t = inputs.todayLog;
  if (!t) return null;
  const y = inputs.yesterdayLog;
  return {
    ...t,
    steps: y?.steps ?? null,
    calories_eaten: y?.calories_eaten ?? null,
    protein_g: y?.protein_g ?? null,
    carbs_g: y?.carbs_g ?? null,
  };
}

function composeReadiness(inputs: BriefInputs): MorningBriefReadiness {
  const r = deriveReadiness({
    log: readinessLog(inputs),
    checkin: inputs.todayCheckin,
    hrvBaseline: inputs.hrvBaseline,
    weightKg: inputs.todayLog?.weight_kg ?? inputs.yesterdayLog?.weight_kg ?? null,
    calorieTarget: inputs.todayTargets?.kcal ?? null,
  });
  return {
    score: r.score,
    recovery_sub_score: r.recoverySubScore,
    feel: r.feel,
    hrv: inputs.todayLog?.hrv ?? null,
    recovery: inputs.todayLog?.recovery ?? null,
    band: r.band,
  };
}

/** Maps soreness_areas strings (intake vocabulary) to MuscleRegion[].
 *  The intake vocabulary is a subset of MuscleRegion; direct cast is safe
 *  for the common values. Unrecognised strings are silently dropped. */
function sorenessAreasToRegions(areas: string[] | null): MuscleRegion[] {
  if (!areas) return [];
  const VALID: ReadonlySet<MuscleRegion> = new Set([
    "legs", "lower_back", "shoulders", "chest", "back", "arms", "core",
  ] as MuscleRegion[]);
  return areas.filter((a): a is MuscleRegion => VALID.has(a as MuscleRegion));
}

/** Deterministic trigger for the morning brief's coach_suggestion chip.
 *  Returns null when:
 *  - No training_weeks row for today (the swap POST would 404).
 *  - Today's session is REST / Mobility / Sick (already a recovery day).
 *  - No rule fires.
 *
 *  Rule priority (highest → lowest):
 *   1. Reactive ladder (soreness + recent activity) — graded load_down /
 *      volume_down / swap_exercise / swap_day suggestions.
 *   2. Low readiness band (existing rule) — swap_to_mobility.
 *   3. Recovery crash + heavy fatigue (existing rule) — reduce_intensity.
 *
 *  GRACE RULE: no soreness + no recent overlapping activity → reactive
 *  ladder returns "none" → existing fallback rules run as before.
 */
export function pickCoachSuggestion(args: {
  band: "low" | "moderate" | "high";
  sessionType: string;
  hasTrainingWeek: boolean;
  intake: {
    soreness_areas: string[] | null;
    soreness_severity: "mild" | "sharp" | null;
    fatigue: "none" | "some" | "heavy" | null;
  };
  recovery: number | null;
  recentActivity: RecentActivitySignal[];
}): MorningBriefCoachSuggestion {
  if (!args.hasTrainingWeek) return null;
  const lower = args.sessionType.toLowerCase().trim();
  if (lower === "rest" || lower === "mobility" || lower === "sick") return null;

  // ── Reactive ladder (Task 8) ───────────────────────────────────────────────
  // Build the selectReactiveRung inputs from intake soreness + recentActivity.
  // SESSION_REGION_MAP gives today's loaded regions; first element is primary.
  const sessionRegions: MuscleRegion[] = SESSION_REGION_MAP[args.sessionType] ?? [];
  const soreRegions = sorenessAreasToRegions(args.intake.soreness_areas);

  const ladderResult = selectReactiveRung({
    sessionRegions,
    soreRegions,
    soreSeverity: args.intake.soreness_severity ?? null,
    fatigue: args.intake.fatigue ?? null,
    recentActivity: args.recentActivity,
  });

  if (ladderResult.rung !== "none") {
    // Map reactive-ladder rungs to the MorningBriefCoachSuggestion union.
    // swap_day → swap_to_mobility (full session replacement by the chip).
    switch (ladderResult.rung) {
      case "load_down":
        return {
          kind: "load_down",
          rationale: "activity_fatigue",
          detail: ladderResult.rationale,
        };
      case "volume_down":
        return {
          kind: "volume_down",
          rationale: "activity_fatigue",
          detail: ladderResult.rationale,
        };
      case "swap_exercise":
        return {
          kind: "swap_exercise",
          rationale: "activity_muscle_overlap",
          // Surface the first affected exercise name as the target when
          // available; falls back to a generic placeholder. The chip UI
          // uses target_exercise as a display hint only.
          target_exercise: ladderResult.regions[0] ?? "affected exercise",
          detail: ladderResult.rationale,
        };
      case "swap_day":
        // swap_day from the ladder takes precedence over all other rules.
        return {
          kind: "swap_to_mobility",
          rationale: ladderResult.regions.length > 0 ? "high_soreness" : "low_readiness",
          detail: ladderResult.rationale,
        };
    }
  }

  // ── Fallback rules (preserved from pre-Task-8) ─────────────────────────────
  // These only run when the reactive ladder returns "none" (no overlapping
  // soreness AND no in-window overlapping activity).

  // Fallback Rule 1: low readiness band.
  if (args.band === "low") {
    return { kind: "swap_to_mobility", rationale: "low_readiness" };
  }

  // Fallback Rule 2: WHOOP recovery crash combined with heavy fatigue.
  if (
    args.recovery !== null &&
    args.recovery < 40 &&
    args.intake.fatigue === "heavy"
  ) {
    return {
      kind: "reduce_intensity",
      rationale: "recovery_crash",
      detail: `recovery ${Math.round(args.recovery)} + heavy fatigue`,
    };
  }

  return null;
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
    note: "Your protocol can suppress thirst — front-load water & sodium around session.",
  };
}

/** Pulls today's prescribed endurance session from
 *  training_weeks.endurance_session_plan. Null when:
 *   - no training_weeks row for this week (no thisWeekEndurancePlan), or
 *   - the plan has no entry for today's weekday, or
 *   - the entry is type="rest".
 *  Keys on the plan are 0..6 matching Date#getDay() (0=Sun..6=Sat).
 *
 *  Reads thisWeekEndurancePlan (decoupled from weekly_reviews) rather than
 *  thisWeekPrescription, because commit_endurance_week only writes to
 *  training_weeks — gating on a committed weekly_review would silently drop
 *  Carter's prescriptions for any week without one. */
function composeEndurance(inputs: BriefInputs): MorningBriefEndurance | null {
  const plan = inputs.thisWeekEndurancePlan;
  if (!plan) return null;
  const weekday = new Date(`${inputs.today}T12:00:00Z`).getUTCDay() as 0|1|2|3|4|5|6;
  const entry = plan[weekday];
  if (!entry || entry.type === "rest") return null;
  const result: MorningBriefEndurance = {
    session_type: entry.type,
    sport: entry.sport,
    duration_min: entry.duration_min,
    description: entry.description,
    intent: enduranceIntentFor(entry.type),
  };
  if (entry.hr_cap !== undefined) result.hr_cap = entry.hr_cap;
  if (entry.hr_target_range !== undefined) result.hr_target_range = entry.hr_target_range;
  return result;
}

/** Per-session-type intent line for the endurance block. Phase 1 only ships
 *  the Z2 composer (z2_ride / z2_run); the others are pre-wired for future
 *  Phase 2 composers (build/race_prep). Falls back to the aerobic-base line
 *  for unknown types. */
function enduranceIntentFor(
  type: NonNullable<MorningBriefEndurance>["session_type"],
): string {
  switch (type) {
    case "z2_ride":
    case "z2_run":
      return "Fat oxidation + aerobic base";
    case "long":
      return "Aerobic capacity + durability";
    case "tempo":
      return "Lactate threshold work";
    case "intervals":
      return "VO2max + top-end power";
    case "brick":
      return "Discipline transition under fatigue";
    default:
      return "Fat oxidation + aerobic base";
  }
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
  const sessionPrescriptions =
    inputs.thisWeekPrescription?.trainingWeek?.session_prescriptions ?? null;
  const weekday = weekdayFromDate(inputs.today);
  const effectivePlan = getEffectiveSessionPlan(
    inputs.sessionType,
    weekday,
    sessionPrescriptions,
    overrides,
  );
  // Build the soreness context for the session annotator.
  // Only provide it when the reactive ladder would produce a non-none rung
  // on this session — avoids touching exercises when nothing is relevant.
  const sessionRegionsForAnnotation: MuscleRegion[] = SESSION_REGION_MAP[inputs.sessionType] ?? [];
  const soreRegionsForAnnotation = sorenessAreasToRegions(
    inputs.todayCheckin?.soreness_areas ?? null,
  );
  const ladderForAnnotation =
    sessionRegionsForAnnotation.length > 0 && soreRegionsForAnnotation.length > 0
      ? selectReactiveRung({
          sessionRegions: sessionRegionsForAnnotation,
          soreRegions: soreRegionsForAnnotation,
          soreSeverity: inputs.todayCheckin?.soreness_severity ?? null,
          fatigue: inputs.todayCheckin?.fatigue ?? null,
          recentActivity: inputs.recentActivity,
        })
      : null;

  const annotateCtx =
    ladderForAnnotation && ladderForAnnotation.rung !== "none"
      ? { soreRegions: ladderForAnnotation.regions, rung: ladderForAnnotation.rung }
      : undefined;

  const structure =
    effectivePlan.length === 0 ? null : annotateSession(effectivePlan, annotateCtx);

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
      if (p.video_url) result.video_url = p.video_url;
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
