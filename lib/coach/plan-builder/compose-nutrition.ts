// lib/coach/plan-builder/compose-nutrition.ts
//
// Composes nutrition section of plan_payload. Protein expressed g/kg BW
// per user's clinical recommendation (floor 1.6 across all phases).
// Refeed cadence enforced for cuts. Hard rules typed.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeNutrition(
  intake: IntakePayload,
  current_bodyweight_kg: number,
): PlanPayload["nutrition"] {
  const phase = intake.nutrition.current_phase === "unsure"
    ? "maintain" // safe default when user is unsure
    : intake.nutrition.current_phase;

  const proteinPerKg = proteinTargetForPhase(phase);
  const proteinG = Math.round(current_bodyweight_kg * proteinPerKg);

  const kcalTarget = intake.nutrition.current_kcal;
  const kcalLow = Math.round(kcalTarget * 0.95);
  const kcalHigh = Math.round(kcalTarget * 1.05);

  // Remaining kcal after protein (4 kcal/g) goes to carb+fat split.
  const proteinKcal = proteinG * 4;
  const remainingKcal = Math.max(0, kcalTarget - proteinKcal);

  // Carb/fat split by phase:
  //   cut: 50/50 of remaining (more carbs to preserve training output)
  //   maintain: 60/40 carb/fat
  //   lean_bulk: 70/30 carb/fat
  //   recomp: 55/45 carb/fat
  const splits: Record<typeof phase, [number, number]> = {
    cut: [0.5, 0.5],
    maintain: [0.6, 0.4],
    lean_bulk: [0.7, 0.3],
    recomp: [0.55, 0.45],
  };
  const [carbRatio, fatRatio] = splits[phase];
  const carbG = Math.round((remainingKcal * carbRatio) / 4);
  const fatG = Math.round((remainingKcal * fatRatio) / 9);

  // Training day uplift: cut + intermediate or higher training_age → +150 kcal carb-led
  const trainingDayUplift =
    phase === "cut" &&
    (intake.training.training_age === "intermediate" ||
      intake.training.training_age === "advanced")
      ? { kcal: 150, carb_g: 35 }
      : null;

  // Refeed cadence: cuts → 6 days; otherwise null
  const refeedCadence = phase === "cut" ? 6 : null;
  const refeedUplift = phase === "cut" ? { kcal: 500, carb_g: 100 } : null;

  return {
    phase,
    kcal_target: kcalTarget,
    kcal_range: [kcalLow, kcalHigh],
    protein_g_per_kg_bw: proteinPerKg,
    protein_g: proteinG,
    carb_g: carbG,
    fat_g: fatG,
    training_day_uplift: trainingDayUplift,
    refeed_cadence_days: refeedCadence,
    refeed_uplift: refeedUplift,
    hard_rules: composeHardRules(intake),
    notes: null, // populated by AI narrative pass
  };
}

/** Phase-defaults protein target. Floor 1.6 g/kg BW for all per user's clinical
 *  guidance. Higher prescriptions are optional follow-ups via user feedback. */
function proteinTargetForPhase(
  phase: "cut" | "maintain" | "lean_bulk" | "recomp",
): number {
  return 1.6; // unified across all phases
}

function composeHardRules(
  intake: IntakePayload,
): PlanPayload["nutrition"]["hard_rules"] {
  const drinksPerWeek = intake.nutrition.alcohol_drinks_per_week;
  let alcoholPolicy: "none" | "training_day_only" | "weekend_allowed";
  if (drinksPerWeek === 0) alcoholPolicy = "none";
  else if (drinksPerWeek <= 5) alcoholPolicy = "training_day_only";
  else alcoholPolicy = "weekend_allowed";

  return {
    alcohol_policy: alcoholPolicy,
    caffeine_cap_mg_per_day: Math.min(400, intake.nutrition.caffeine_mg_per_day || 400),
    caffeine_last_dose_hours_before_bed: 8,
    tracking_tolerance_missed_days_per_week: 1,
  };
}
