// lib/coach/plan-builder/compose-strength.ts
//
// Composes strength TEMPLATE section of plan_payload. Per-block weights
// remain in training_blocks; per-week schedule in training_weeks. This
// section is the durable contract for what the user's strength practice
// looks like at the plan level.

import type {
  IntakePayload,
  PlanPayload,
  TrainingBlock,
  StrengthMuscleVolume,
  MuscleVolumeBand,
  TargetedMuscleGroup,
} from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
import {
  literatureBand,
  DEFAULT_RAMP_RECIPE,
  DEFAULT_COUNTING_RULES,
} from "@/lib/coach/volume-landmarks";
import {
  computeWeeklyMuscleVolume,
  type Workout,
} from "@/lib/coach/muscle-volume";
import type { ConstraintPayload, IdentityPayload } from "@/lib/coach/intelligence/types";
import {
  applyConstraintAwareSelection,
  type ExerciseAdjustment,
} from "@/lib/coach/plan-builder/constraint-aware-exercises";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";

export type RecentE1RMsForStrength = {
  squat: number | null;
  bench: number | null;
  deadlift: number | null;
  ohp: number | null;
};

/** Optional intelligence-layer inputs for composeStrengthTemplate.
 *  All optional → backward-compatible: absent = today's behavior, zero adjustments. */
export type StrengthTemplateOptions = {
  /** Multiplier applied to weekly_volume_targets reps/sets.
   *  1.0 (default) = full prescribed volume.
   *  <1.0 = trimmed (e.g. 0.8 when goal_vs_recovery flag accepted). */
  strengthVolumeMultiplier?: number;
  /** Constraint payload from intelligence layer. When present + non-empty,
   *  exercises in each session type are run through constraint-aware selection. */
  constraints?: ConstraintPayload | null;
  /** Identity payload from intelligence layer. When present, latitude accessories
   *  are swapped to identity-preferred alternatives. */
  identity?: IdentityPayload | null;
};

export type StrengthTemplateResult = {
  strength: PlanPayload["strength"];
  /** Exercise substitutions applied. Empty when no constraints/identity present
   *  or no substitutions were needed. Caller puts these on plan_payload.adjustments. */
  adjustments: ExerciseAdjustment[];
};

export function composeStrengthTemplate(
  intake: IntakePayload,
  activeBlock: Pick<TrainingBlock, "primary_lift"> | null,
  recentE1RMs: RecentE1RMsForStrength,
  recentWorkouts: Workout[],
  options?: StrengthTemplateOptions,
): StrengthTemplateResult {
  const strengthVolumeMultiplier = options?.strengthVolumeMultiplier ?? 1.0;
  const constraints = options?.constraints ?? null;
  const identity = options?.identity ?? null;

  const sessionsPerWeek = intake.training.sessions_per_week;
  const dayPattern = composeDayPattern(intake, sessionsPerWeek);
  const sessionTypes = Array.from(new Set(Object.values(dayPattern))) as Array<
    "Chest" | "Legs" | "Back" | "Mobility" | "REST"
  >;

  const muscle_volume = composeMuscleVolume(
    intake.training.training_age,
    recentWorkouts,
  );

  // ── Constraint-aware + identity-favoring exercise selection ──────────────
  // For each session type in the plan, run applyConstraintAwareSelection over
  // its exercises. Adjustments are accumulated across all session types.
  // When constraints + identity both absent, this is a no-op.
  const allAdjustments: ExerciseAdjustment[] = [];

  if (constraints || identity) {
    for (const sessionType of sessionTypes) {
      if (sessionType === "REST" || sessionType === "Mobility") continue;
      const planned = SESSION_PLANS[sessionType];
      if (!planned || planned.length === 0) continue;

      const { adjustments } = applyConstraintAwareSelection({
        exercises: planned,
        constraints,
        identity,
      });
      allAdjustments.push(...adjustments);
    }
  }

  const strength: PlanPayload["strength"] = {
    sessions_per_week: sessionsPerWeek,
    day_pattern: dayPattern,
    template_session_types: sessionTypes,
    weekly_volume_targets: composeVolumeTargets(
      intake,
      activeBlock?.primary_lift ?? null,
      strengthVolumeMultiplier,
    ),
    progression_rule: composeProgressionRule(intake.training.training_age),
    notes: null, // populated by AI narrative pass
    muscle_volume,
  };

  return { strength, adjustments: allAdjustments };
}

/** Builds a Mon-Sun map of session types from intake.lifestyle.days_available.
 *  Defaults to a Chest/Legs/Back/Mobility rotation when the user has 4 available
 *  days, scaled up/down by sessions_per_week. */
function composeDayPattern(
  intake: IntakePayload,
  sessions: number,
): { [weekday: string]: string } {
  const days = intake.lifestyle.days_available;
  const orderedDays: Array<[keyof typeof days, string]> = [
    ["mon", "Monday"],
    ["tue", "Tuesday"],
    ["wed", "Wednesday"],
    ["thu", "Thursday"],
    ["fri", "Friday"],
    ["sat", "Saturday"],
    ["sun", "Sunday"],
  ];

  // Session-type rotation: prioritize Legs (primary lift goal often hinges on this),
  // then Back, then Chest, then Mobility for the 4-day case.
  const rotation = ["Legs", "Chest", "Back", "Mobility"];
  const pattern: { [weekday: string]: string } = {};

  let sessionIdx = 0;
  for (const [key, weekday] of orderedDays) {
    if (days[key] && sessionIdx < sessions) {
      pattern[weekday] = rotation[sessionIdx % rotation.length];
      sessionIdx++;
    } else {
      pattern[weekday] = "REST";
    }
  }
  return pattern;
}

/** Volume targets per primary lift, scaled by training_age and strengthVolumeMultiplier.
 *  multiplier = 1.0 → full prescribed volume (default, unchanged from prior behavior).
 *  multiplier < 1.0 → trimmed volume (e.g. 0.8 when goal_vs_recovery flag accepted). */
function composeVolumeTargets(
  intake: IntakePayload,
  primaryLift: "squat" | "bench" | "deadlift" | "ohp" | null,
  multiplier: number = 1.0,
): { [lift: string]: { reps_per_week: number; sets_per_week: number } } {
  const targets: { [lift: string]: { reps_per_week: number; sets_per_week: number } } = {};
  const lifts = primaryLift
    ? [primaryLift]
    : (["squat", "bench", "deadlift", "ohp"] as const);
  const profile = volumeProfileForAge(intake.training.training_age);
  for (const lift of lifts) {
    targets[lift] = {
      reps_per_week: Math.round(profile.reps_per_week * multiplier),
      sets_per_week: Math.round(profile.sets_per_week * multiplier),
    };
  }
  return targets;
}

function volumeProfileForAge(
  age: "beginner" | "intermediate" | "advanced",
): { reps_per_week: number; sets_per_week: number } {
  switch (age) {
    case "beginner":
      return { reps_per_week: 50, sets_per_week: 10 };
    case "intermediate":
      return { reps_per_week: 70, sets_per_week: 14 };
    case "advanced":
      return { reps_per_week: 90, sets_per_week: 18 };
  }
}

function composeProgressionRule(
  age: "beginner" | "intermediate" | "advanced",
): string {
  switch (age) {
    case "beginner":
      return "Add 2.5kg to primary lifts every session when all working reps are clean.";
    case "intermediate":
      return "Add 2.5kg to primary lifts when last set ≥ target RIR + 2 reps for 2 consecutive sessions.";
    case "advanced":
      return "Wave loading per block; reassess at block end against e1RM trajectory.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// composeMuscleVolume — per-muscle MEV/MAV/MRV with history-adjustment.
//
// Adjustment rule per spec L39:
//   - history > MAV upper → raise band proportionally; source "literature_adjusted_up"
//   - history < MEV       → keep literature band as target, source "literature_with_ramp_floor"
//   - else                → literature defaults, source "literature_default"
//
// Sparseness fallback: if fewer than 12 workouts in window (~ 4 weeks),
// use literature defaults regardless of history.
// ─────────────────────────────────────────────────────────────────────────────

export function composeMuscleVolume(
  trainingAge: "beginner" | "intermediate" | "advanced",
  recentWorkouts: Workout[],
): StrengthMuscleVolume {
  const { volumes: history, unmapped_exercises } = computeWeeklyMuscleVolume(
    recentWorkouts,
    56, // 8 weeks
  );

  const sparseHistory = recentWorkouts.length < 12;

  const bands = {} as Record<TargetedMuscleGroup, MuscleVolumeBand>;

  for (const group of TARGETED_MUSCLE_GROUPS) {
    const lit = literatureBand(group, trainingAge);
    const h = history[group];

    if (sparseHistory) {
      bands[group] = {
        ...lit,
        history_8wk_avg: h,
        source: "literature_default",
        rationale: `${h} sets/wk over ${recentWorkouts.length} sessions — history sparse, using ${trainingAge} literature defaults pending more data.`,
      };
      continue;
    }

    if (h > lit.mav[1]) {
      const k = h / lit.mav[1];
      bands[group] = {
        mev: Math.round(lit.mev * k),
        mav: [Math.round(lit.mav[0] * k), Math.round(lit.mav[1] * k)],
        mrv: Math.round(lit.mrv * k),
        history_8wk_avg: h,
        source: "literature_adjusted_up",
        rationale: `8wk avg ${h} sets/wk exceeds literature MAV upper (${lit.mav[1]}); band raised ${Math.round((k - 1) * 100)}% from defaults.`,
      };
    } else if (h < lit.mev) {
      bands[group] = {
        ...lit,
        history_8wk_avg: h,
        source: "literature_with_ramp_floor",
        rationale: `8wk avg ${h} sets/wk is below ${trainingAge} MEV (${lit.mev}); coach will ramp gradually rather than jumping straight to MEV.`,
      };
    } else {
      bands[group] = {
        ...lit,
        history_8wk_avg: h,
        source: "literature_default",
        rationale: `8wk avg ${h} sets/wk in band; ${trainingAge} literature defaults apply.`,
      };
    }
  }

  return {
    counting_rules: DEFAULT_COUNTING_RULES,
    ramp_recipe: DEFAULT_RAMP_RECIPE,
    bands,
    unmapped_exercises,
  };
}
