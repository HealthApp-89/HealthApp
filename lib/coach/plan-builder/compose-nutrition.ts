// lib/coach/plan-builder/compose-nutrition.ts
//
// Composes nutrition section of plan_payload.
//
// Two modes, branched on intake.health.glp1_status:
//
//   GLP-1 mode (status present and expected_end not past):
//     → emits `glp1` config (medication, dose, protein floor, TDEE estimate,
//       hydration/sodium training-day targets, deficit-alarm thresholds);
//     → top-level kcal/protein/carb/fat reflect today's GLP-1 resolution;
//     → classical_phases/rest_day_delta/training_day_uplift/refeed all null —
//       GLP-1 + uplifts/refeeds would fight the medication's suppression.
//
//   Classical mode (no glp1_status, or past expected_end):
//     → emits `classical_phases` sequence (8-week cut blocks separated by
//       2-week diet breaks, 4-week reverse, open-ended maintain);
//     → top-level fields mirror classical_phases[0] (today's phase);
//     → training_day_uplift + refeed_cadence preserved for cuts;
//     → rest_day_delta populated per phase + training_age.

import type {
  IntakePayload,
  PlanPayload,
  Glp1Status,
  Glp1Config,
  PhaseStep,
  RestDayDelta,
} from "@/lib/data/types";

export function composeNutrition(args: {
  intake: IntakePayload;
  goal: PlanPayload["goal"];
  bodyweight_kg: number;
  acknowledged_on: string | null;
}): PlanPayload["nutrition"] {
  const { intake, goal, bodyweight_kg, acknowledged_on } = args;
  const status = intake.health.glp1_status ?? null;
  const phase = intake.nutrition.current_phase;
  const resolvedPhase = phase === "unsure" ? "maintain" : phase;

  // ── GLP-1 branch ─────────────────────────────────────────────────────────
  if (status && !isPastEnd(status.expected_end)) {
    const glp1 = composeGlp1Config(status, intake, bodyweight_kg);
    const kcalTarget = deriveTodayKcalGlp1(glp1, phase);
    const kcalRange = deriveKcalRangeGlp1(glp1, phase);
    const carbG = derivePhaseCarbsGlp1(phase, bodyweight_kg, glp1);
    const fatG = derivePhaseFatGlp1(bodyweight_kg);

    return {
      phase: resolvedPhase,
      kcal_target: kcalTarget,
      kcal_range: kcalRange,
      protein_g_per_kg_bw: glp1.protein_g_per_kg_bw,
      protein_g: Math.round(bodyweight_kg * glp1.protein_g_per_kg_bw),
      carb_g: carbG,
      fat_g: fatG,
      training_day_uplift: null,   // GLP-1 mode does not uplift
      refeed_cadence_days: null,
      refeed_uplift: null,
      hard_rules: composeHardRules(intake),
      notes: null,
      glp1,
      classical_phases: null,
      rest_day_delta: null,
    };
  }

  // ── Classical branch ─────────────────────────────────────────────────────
  const classical_phases = composePhaseSequence({
    current_phase: phase,
    goal_target_date: goal.target_date,
    acknowledged_on,
    bodyweight_kg,
    bodyweight_kg_protein_factor: 1.6,
  });

  const today = classical_phases?.[0] ?? null;
  const fallbackKcal = estimateMaintenance(bodyweight_kg);
  const fallbackProtein = Math.round(bodyweight_kg * 1.6);

  return {
    phase: resolvedPhase,
    kcal_target: today?.kcal ?? fallbackKcal,
    kcal_range: today
      ? [Math.round(today.kcal * 0.95), Math.round(today.kcal * 1.05)]
      : [Math.round(fallbackKcal * 0.95), Math.round(fallbackKcal * 1.05)],
    protein_g_per_kg_bw: 1.6,
    protein_g: today?.protein_g ?? fallbackProtein,
    carb_g: today?.carb_g ?? 200,
    fat_g: today?.fat_g ?? 60,
    training_day_uplift: composeTrainingUplift(phase, intake.training.training_age),
    refeed_cadence_days: phase === "cut" ? 6 : null,
    refeed_uplift: phase === "cut" ? { kcal: 400, carb_g: 100 } : null,
    hard_rules: composeHardRules(intake),
    notes: null,
    glp1: null,
    classical_phases,
    rest_day_delta: composeRestDayDelta(phase, intake.training.training_age),
  };
}

// ── GLP-1 config composer ───────────────────────────────────────────────────

export function composeGlp1Config(
  status: Glp1Status,
  intake: IntakePayload,
  currentBodyweightKg: number,
): Glp1Config {
  // Protein floor by medication:
  //   semaglutide → 1.8 g/kg actual BW
  //   tirzepatide → 2.0 g/kg actual BW
  //   compounded  → 1.8 (conservative — assume semaglutide-like)
  const proteinFloor = status.medication === "tirzepatide" ? 2.0 : 1.8;

  return {
    medication: status.medication,
    dose_mg: status.dose_mg,
    injection_day: status.injection_day,
    injection_time: status.injection_time,
    started_on: status.started_on,
    expected_taper_start: status.expected_taper_start,
    taper_started_on: null,
    expected_end: status.expected_end,
    deficit_alarm_pct: 0.25,
    deficit_alarm_kcal: 700,
    protein_g_per_kg_bw: proteinFloor,
    per_meal_protein_floor_g: 25,
    hydration_training_day_ml: 3500,
    sodium_training_day_mg: 1000,
    tdee_estimate_kcal: estimateTdeeKcal(intake, currentBodyweightKg),
  };
}

// ── Classical phase sequence composer ───────────────────────────────────────

export function composePhaseSequence(args: {
  current_phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
  goal_target_date: string;
  acknowledged_on: string | null;
  bodyweight_kg: number;
  bodyweight_kg_protein_factor: number;
}): PhaseStep[] | null {
  // Only cut gets a phase sequence; other phases stay single-state.
  if (args.current_phase !== "cut") return null;

  const ackDate = args.acknowledged_on
    ? new Date(args.acknowledged_on)
    : new Date();
  const targetDate = new Date(args.goal_target_date);
  const weeksToGoal = Math.max(
    4,
    Math.floor((targetDate.getTime() - ackDate.getTime()) / (7 * 86_400_000)),
  );

  // Baseline cut macros (1.6 g/kg BW protein for classical mode).
  const proteinG = Math.round(args.bodyweight_kg * args.bodyweight_kg_protein_factor);
  const cutKcal = Math.round(estimateMaintenance(args.bodyweight_kg) * 0.80);  // 20% deficit
  const cutFatG = 55;
  const cutCarbG = Math.max(0, Math.round((cutKcal - proteinG * 4 - cutFatG * 9) / 4));

  // Build sequence: 8-week cut blocks separated by 2-week diet breaks,
  // ending in a 4-week reverse, then maintain.
  const out: PhaseStep[] = [];
  let week = 0;
  let cutBlockNo = 0;

  // Reserve last 4 weeks for reverse + open-ended maintain.
  const cuttingWindow = Math.max(0, weeksToGoal - 4);

  while (week < cuttingWindow) {
    const cutEnd = Math.min(week + 8, cuttingWindow);
    out.push({
      start_week: week,
      end_week: cutEnd,
      mode: "cut",
      kcal: cutKcal,
      protein_g: proteinG,
      carb_g: cutCarbG,
      fat_g: cutFatG,
      rationale: cutBlockNo === 0
        ? "Cut phase — 20% deficit, protein floor 1.6 g/kg BW"
        : `Cut block ${cutBlockNo + 1} — sustained deficit after diet break`,
    });
    cutBlockNo += 1;
    week = cutEnd;

    // Insert a diet break if there's enough runway for another cut block.
    if (week + 2 < cuttingWindow) {
      out.push({
        start_week: week,
        end_week: week + 2,
        mode: "diet_break",
        kcal: cutKcal + 400,                  // entirely to carbs
        protein_g: proteinG,
        carb_g: cutCarbG + 100,
        fat_g: cutFatG,
        rationale: "Diet break — leptin/T3 restoration, +400 kcal to carbs, 2 weeks",
      });
      week += 2;
    }
  }

  // Reverse phase (4 weeks at +75 kcal/wk).
  if (week < weeksToGoal) {
    const maintenanceKcal = estimateMaintenance(args.bodyweight_kg);
    out.push({
      start_week: week,
      end_week: week + 4,
      mode: "reverse",
      kcal: Math.round((cutKcal + maintenanceKcal) / 2),
      protein_g: proteinG,
      carb_g: cutCarbG + 50,
      fat_g: cutFatG + 5,
      rationale: "Reverse diet — gradual +75 kcal/wk over 4 weeks to maintenance",
    });
    week += 4;
  }

  // Open-ended maintenance from end of reverse onward.
  out.push({
    start_week: week,
    end_week: 999,
    mode: "maintain",
    kcal: estimateMaintenance(args.bodyweight_kg),
    protein_g: proteinG,
    carb_g: cutCarbG + 100,
    fat_g: cutFatG + 10,
    rationale: "Maintenance — protein floor preserved, calories at TDEE",
  });

  return out;
}

// ── Rest-day delta composer ─────────────────────────────────────────────────

export function composeRestDayDelta(
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  training_age: "beginner" | "intermediate" | "advanced",
): RestDayDelta | null {
  if (phase !== "cut") return null;
  if (training_age === "beginner") {
    return { kcal: -50, carb_g: -15, fat_g: 0 };
  }
  return { kcal: -100, carb_g: -25, fat_g: 0 };
}

// ── Training-day uplift composer ────────────────────────────────────────────

export function composeTrainingUplift(
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  training_age: "beginner" | "intermediate" | "advanced",
): { kcal: number; carb_g: number } | null {
  if (phase !== "cut") return null;
  if (training_age === "beginner") return null;
  return { kcal: 200, carb_g: 50 };
}

// ── Hard rules (classical + GLP-1 share these) ──────────────────────────────

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

// ── GLP-1 derivers ──────────────────────────────────────────────────────────

function deriveTodayKcalGlp1(
  glp1: Glp1Config,
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
): number {
  if (phase === "cut") {
    return Math.round(glp1.tdee_estimate_kcal * 0.80); // 20% deficit
  }
  if (phase === "lean_bulk") {
    return Math.round(glp1.tdee_estimate_kcal * 1.05);
  }
  return glp1.tdee_estimate_kcal;
}

function deriveKcalRangeGlp1(
  glp1: Glp1Config,
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
): [number, number] {
  const target = deriveTodayKcalGlp1(glp1, phase);
  return [Math.round(target * 0.95), Math.round(target * 1.05)];
}

function derivePhaseCarbsGlp1(
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  bw: number,
  glp1: Glp1Config,
): number {
  const proteinG = bw * glp1.protein_g_per_kg_bw;
  const proteinKcal = proteinG * 4;
  const fatKcal = bw * 0.8 * 9;        // ~0.8 g/kg fat as baseline floor
  const target = deriveTodayKcalGlp1(glp1, phase);
  return Math.max(0, Math.round((target - proteinKcal - fatKcal) / 4));
}

function derivePhaseFatGlp1(bw: number): number {
  return Math.round(bw * 0.8);
}

// ── Internals ───────────────────────────────────────────────────────────────

function isPastEnd(expected_end: string | null): boolean {
  if (!expected_end) return false;
  return new Date(expected_end).getTime() < Date.now();
}

function estimateMaintenance(bodyweight_kg: number): number {
  // Conservative single-input maintenance estimate when full TDEE inputs absent.
  // 32 kcal/kg × bw is a reasonable intermediate-lifter average.
  return Math.round(32 * bodyweight_kg);
}

function estimateTdeeKcal(intake: IntakePayload, currentBodyweightKg: number): number {
  // Mifflin-St Jeor RMR for males:
  //   RMR = 10 × kg + 6.25 × cm − 5 × age + 5
  // Activity factor 1.5 (intermediate lifter, 3-4×/wk).
  // age and height_cm live on Profile, not IntakePayload — defensive lookup
  // here (Task 4 may thread them through args). Fallback: 32 × kg.
  const age = (intake as { age?: number }).age ?? null;
  const heightCm = (intake.lifestyle as { height_cm?: number }).height_cm ?? null;
  if (age == null || heightCm == null) {
    return estimateMaintenance(currentBodyweightKg);
  }
  const rmr = 10 * currentBodyweightKg + 6.25 * heightCm - 5 * age + 5;
  return Math.round(rmr * 1.5);
}
