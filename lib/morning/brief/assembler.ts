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
} from "@/lib/data/types";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import { roundToValidWeight, minNonZeroIncrement } from "@/lib/coach/weight-rounding";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

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
};

export function assembleBriefExceptAdvice(
  inputs: BriefInputs,
): Omit<MorningBriefCard, "advice_md"> {
  const variant: MorningBriefVariant = pickVariant(inputs.sessionType);
  const readiness = composeReadiness(inputs);

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
  };
}

function pickVariant(sessionType: string): MorningBriefVariant {
  return sessionType === "REST" ? "rest" : "training";
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
  return {
    yesterday_date: inputs.yesterday,
    sleep_hours: inputs.yesterdayLog?.sleep_hours ?? null,
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
): { type: string; start_time: string | null; exercises: MorningBriefExercise[] } {
  if (variant === "rest") {
    return {
      type: inputs.sessionType,
      start_time: null,
      exercises: [],
    };
  }
  return {
    type: inputs.sessionType,
    start_time: inputs.sessionStartTime ?? "13:00", // default 1pm per spec
    exercises: composeExercises(
      inputs.sessionType,
      inputs.intensityModifier,
      inputs.primaryLift,
    ),
  };
}

function composeExercises(
  sessionType: string,
  modifier: IntensityModifier,
  primaryLift: PrimaryLift | null,
): MorningBriefExercise[] {
  const plan: PlannedExercise[] = SESSION_PLANS[sessionType] ?? [];
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
