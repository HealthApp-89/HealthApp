// lib/coach/plan-builder/sanity-check.ts
//
// Deterministic sanity checks run BEFORE the chat narrative deepening.
// Surfaces findings in Beat 1 of the intake chat with proposed corrections.
// User can Accept (apply_* tool fires) or Override (set_sanity_override fires).
//
// All checks are pure functions over IntakePayload + supporting data.
// No I/O inside the check functions themselves; the orchestrator loads
// supporting data and passes it in.

import type { IntakePayload, SanityFinding } from "@/lib/data/types";

const PRIMARY_LIFT_REGEX: Record<"squat" | "bench" | "deadlift" | "ohp", RegExp> = {
  squat: /\b(back\s+squat|squat)\b/i,
  bench: /\b(bench\s+press|bench)\b/i,
  deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
  ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
};

export type SanityCheckInputs = {
  intake: IntakePayload;
  current_bodyweight_kg: number | null;
  rolling_7d_kcal: number | null;
  today: string; // YYYY-MM-DD in user tz
};

export function runSanityChecks(inputs: SanityCheckInputs): SanityFinding[] {
  const findings: SanityFinding[] = [];
  const goal = checkGoalContradiction(inputs);
  if (goal) findings.push(goal);
  const sleep = checkSleepEfficiency(inputs);
  if (sleep) findings.push(sleep);
  const macros = checkMacrosGap(inputs);
  if (macros) findings.push(macros);
  const protein = checkProteinFloor(inputs);
  if (protein) findings.push(protein);
  return findings;
}

// ── 1. Goal contradiction ────────────────────────────────────────────────────

function checkGoalContradiction(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake } = inputs;
  // Skip if already overridden
  if (intake.sanity_overrides?.goal_kept_despite_low_target === true) return null;
  if (intake.goals.primary_type !== "strength") return null;

  // Infer the lift from primary_metric
  const lift = inferLiftFromMetric(intake.goals.primary_metric);
  if (!lift) return null;

  const currentE1rm = intake.training.current_e1rm[lift];
  if (currentE1rm === null || currentE1rm === undefined) return null;

  // Fires when target_value <= current_e1rm
  if (intake.goals.target_value > currentE1rm) return null;

  // Compute proposed target: current × (1 + months × 0.04)
  const targetDate = new Date(intake.goals.target_date);
  const today = new Date(inputs.today);
  const days = Math.max(0, (targetDate.getTime() - today.getTime()) / 86_400_000);
  const months = days / 30.4;
  const proposedRaw = currentE1rm * (1 + months * 0.04);
  // Round to nearest 2.5kg (plate-loadable)
  const proposed = Math.round(proposedRaw / 2.5) * 2.5;

  return {
    type: "goal_contradiction",
    current_e1rm: currentE1rm,
    target_value: intake.goals.target_value,
    proposed_target: proposed,
    target_unit: intake.goals.target_unit,
    lift,
    months_to_target: Math.round(months * 10) / 10,
    rationale: `Current e1RM ${currentE1rm}${intake.goals.target_unit} already meets or exceeds the stated target ${intake.goals.target_value}${intake.goals.target_unit}. Suggested ${proposed}${intake.goals.target_unit} = current × (1 + ${months.toFixed(1)}mo × 4%/mo), a conservative intermediate-lifter progression.`,
  };
}

function inferLiftFromMetric(metric: string): "squat" | "bench" | "deadlift" | "ohp" | null {
  for (const lift of ["squat", "bench", "deadlift", "ohp"] as const) {
    if (PRIMARY_LIFT_REGEX[lift].test(metric)) return lift;
  }
  return null;
}

// ── 2. Sleep efficiency ──────────────────────────────────────────────────────

function checkSleepEfficiency(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake } = inputs;
  if (intake.sanity_overrides?.sleep_efficiency_acknowledged === true) return null;

  const bedtime = intake.sleep_recovery.typical_bedtime;
  const wake = intake.sleep_recovery.typical_wake_time;
  const avgSleep = intake.sleep_recovery.avg_sleep_hours;

  const timeInBed = computeTimeInBed(bedtime, wake);
  if (timeInBed === null || avgSleep <= 0) return null;

  const gap = timeInBed - avgSleep;
  if (gap <= 1) return null;

  const efficiency = avgSleep / timeInBed;
  // Propose bedtime that closes the gap: same wake time, bedtime shifted later
  // to reduce time-in-bed to (avgSleep + 0.5h buffer)
  const desiredTimeInBed = avgSleep + 0.5;
  const proposedBedtime = subtractHoursFromHHmm(wake, desiredTimeInBed);

  return {
    type: "sleep_efficiency",
    time_in_bed_h: Math.round(timeInBed * 10) / 10,
    avg_sleep_h: avgSleep,
    current_efficiency: Math.round(efficiency * 100) / 100,
    proposed_bedtime: proposedBedtime,
    rationale: `${timeInBed.toFixed(1)}h in bed but only ${avgSleep}h asleep (efficiency ${(efficiency * 100).toFixed(0)}%). Either push bedtime to ${proposedBedtime} to align time-in-bed with actual sleep, or address sleep latency separately.`,
  };
}

function computeTimeInBed(bedtime: string, wake: string): number | null {
  const bParts = bedtime.split(":");
  const wParts = wake.split(":");
  if (bParts.length !== 2 || wParts.length !== 2) return null;
  const bh = Number(bParts[0]);
  const bm = Number(bParts[1]);
  const wh = Number(wParts[0]);
  const wm = Number(wParts[1]);
  if ([bh, bm, wh, wm].some((n) => !Number.isFinite(n))) return null;
  let minutes = wh * 60 + wm - (bh * 60 + bm);
  if (minutes < 0) minutes += 24 * 60;
  return minutes / 60;
}

function subtractHoursFromHHmm(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  let totalMinutes = h * 60 + m - Math.round(hours * 60);
  while (totalMinutes < 0) totalMinutes += 24 * 60;
  const newH = Math.floor(totalMinutes / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

// ── 3. Macros gap ────────────────────────────────────────────────────────────

function checkMacrosGap(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake, rolling_7d_kcal } = inputs;
  if (intake.sanity_overrides?.macros_gap_acknowledged === true) return null;
  if (rolling_7d_kcal === null) return null;

  const target = intake.nutrition.current_kcal;
  if (target <= 0) return null;

  // Sign convention: gap is (actual - target) / target, so undershooting the
  // target yields a NEGATIVE pct and overshooting yields a POSITIVE pct.
  // Matches the convention in the design spec ("gap_pct: -13% for undershoot").
  const gap = (rolling_7d_kcal - target) / target;
  if (Math.abs(gap) <= 0.1) return null; // within 10% — close enough

  return {
    type: "macros_gap",
    target_kcal: target,
    actual_7d_kcal: Math.round(rolling_7d_kcal),
    gap_pct: Math.round(gap * 1000) / 10, // e.g., -12.5 (undershoot)
    options: ["match_actual", "hit_target"],
    rationale: `Stated target ${target} kcal, but rolling 7d actual ${Math.round(rolling_7d_kcal)} kcal (${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(0)}%). Either lower target to match reality, or commit to hitting the stated target as a behavior change.`,
  };
}

// ── 4. Protein floor (cuts only) ─────────────────────────────────────────────

function checkProteinFloor(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake, current_bodyweight_kg } = inputs;
  if (intake.sanity_overrides?.protein_floor_acknowledged === true) return null;
  if (intake.nutrition.current_phase !== "cut") return null;
  if (current_bodyweight_kg === null || current_bodyweight_kg <= 0) return null;

  const protein = intake.nutrition.current_macros.protein_g;
  const perKgBw = protein / current_bodyweight_kg;
  const FLOOR = 1.6;

  if (perKgBw >= FLOOR) return null;

  const proposedProteinG = Math.round(current_bodyweight_kg * FLOOR);
  const proteinDeltaG = proposedProteinG - protein;
  // Maintain kcal stable by reducing fat proportionally:
  // protein kcal change = proteinDeltaG × 4
  // fat kcal change = -proteinDeltaG × 4
  // fat g change = -(proteinDeltaG × 4) / 9
  const fatDeltaG = -(proteinDeltaG * 4) / 9;
  const proposedFatG = Math.max(
    20,
    Math.round(intake.nutrition.current_macros.fat_g + fatDeltaG),
  );

  return {
    type: "protein_floor",
    current_protein_g: protein,
    current_per_kg_bw: Math.round(perKgBw * 100) / 100,
    floor: FLOOR,
    bodyweight: current_bodyweight_kg,
    proposed_protein_g: proposedProteinG,
    proposed_fat_g: proposedFatG,
    rationale: `Current protein ${protein}g is ${perKgBw.toFixed(2)} g/kg BW, below the 1.6 g/kg clinical floor for cuts. Suggested ${proposedProteinG}g protein with ${proposedFatG}g fat to keep kcal stable.`,
  };
}
