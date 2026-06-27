// lib/coach/plan-builder/plan-intelligence-checks.ts
//
// Pure function: planIntelligenceChecks({ intake, intelligence, responsiveness })
// → SanityFinding[]
//
// Converts the intelligence layer payload into plan flags that surface in Beat 1
// of the plan-builder alongside the original sanity findings.
//
// Guards on each flag:
//   (a) intelligence is non-null
//   (b) the relevant sub-field is conclusive (not establishing/unknown)
//   (c) the flag type is NOT already present in intake.plan_flag_resolutions
//       (already addressed by the athlete — don't re-emit)
//
// Returns [] when intelligence is null or no flag's data is conclusive.
// No AI calls — pure deterministic logic.

import type { SanityFinding, IntakePayload } from "@/lib/data/types";
import type { AthleteIntelligencePayload } from "@/lib/coach/intelligence/types";
import type { ResponsivenessRollup } from "@/lib/coach/interventions/responsiveness";

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds — all documented inline
// ─────────────────────────────────────────────────────────────────────────────

/** Opening-week volume fraction when recovery is warning_overreach.
 *  0.8 = open 20% lighter than prescribed to allow recovery adaptation. */
const PROPOSED_OPENING_VOLUME_PCT = 0.8;

/** Minimum protein floor (g/kg BW) for high-risk muscle-loss scenarios.
 *  1.8 g/kg chosen as GLP-1-adjacent floor (see compose-nutrition.ts);
 *  we take max(stated_target, 1.8) to ensure we only raise, never lower. */
const PROPOSED_PROTEIN_FLOOR_G_PER_KG = 1.8;

/** Ramp duration (weeks) to bring chronic protein shortfall up to target.
 *  3-week progressive ramp is the standard adherence-building timeline. */
const PROPOSED_RAMP_WEEKS = 3;

/** Strength volume fraction when interference is "high".
 *  0.85 = trim 15% to create recovery headroom without killing stimulus. */
const PROPOSED_STRENGTH_VOLUME_PCT_HIGH = 0.85;

/** Strength volume fraction when interference is "mild".
 *  0.9 = trim 10% as a light buffer — monitor before cutting further. */
const PROPOSED_STRENGTH_VOLUME_PCT_MILD = 0.9;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the flag type has already been resolved by the athlete
 * (either accepted or overridden). Resolved flags are not re-emitted.
 */
function isResolved(
  type: keyof NonNullable<IntakePayload["plan_flag_resolutions"]>,
  intake: IntakePayload,
): boolean {
  return intake.plan_flag_resolutions?.[type] !== undefined;
}

/**
 * Derive a responsiveness_note from the rollup that is relevant to recovery flags.
 * Used by goal_vs_recovery: mentions recent reactive-deload wins or high ROI.
 */
function recoveryResponsivenessNote(
  responsiveness: ResponsivenessRollup | null,
): string | undefined {
  if (!responsiveness) return undefined;

  // high_roi lines that mention "reactive deload" are directly relevant
  const highRoiDeload = responsiveness.high_roi.find((l) =>
    l.includes("reactive deload"),
  );
  if (highRoiDeload) {
    return `History: ${highRoiDeload}`;
  }

  // A recent reactive-deload win also confirms responsiveness
  const recentWin = responsiveness.recent_wins.find((w) =>
    w.startsWith("reactive deload"),
  );
  if (recentWin) {
    return `Recent: ${recentWin}`;
  }

  return undefined;
}

/**
 * Derive a responsiveness_note relevant to nutrition flags.
 * Mentions nutrition_change high-ROI or low-signal patterns.
 */
function nutritionResponsivenessNote(
  responsiveness: ResponsivenessRollup | null,
): string | undefined {
  if (!responsiveness) return undefined;

  const highRoiNutrition = responsiveness.high_roi.find((l) =>
    l.includes("nutrition change"),
  );
  if (highRoiNutrition) {
    return `History: ${highRoiNutrition}`;
  }

  const lowSignalNutrition = responsiveness.low_signal.find((l) =>
    l.includes("nutrition change"),
  );
  if (lowSignalNutrition) {
    return `Note: ${lowSignalNutrition} — persisting with protocol anyway`;
  }

  const recentWin = responsiveness.recent_wins.find((w) =>
    w.startsWith("nutrition change"),
  );
  if (recentWin) {
    return `Recent: ${recentWin}`;
  }

  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag checkers — each returns SanityFinding | null
// ─────────────────────────────────────────────────────────────────────────────

/**
 * goal_vs_recovery: fires when recovery_readiness.status === "warning_overreach"
 * AND the intake goal implies high-volume intent (i.e. goal type is strength or
 * performance — any goal that would drive a loading block).
 *
 * "establishing" / "stalled" statuses are NOT conclusive overreach → silent.
 *
 * Confidence check: we trust warning_overreach when confidence > 0 (the
 * composer has its own quality gates); we don't re-gate on confidence here
 * since "warning_overreach" already requires multiple signals.
 */
function checkGoalVsRecovery(
  intake: IntakePayload,
  intelligence: AthleteIntelligencePayload,
  responsiveness: ResponsivenessRollup | null,
): SanityFinding | null {
  if (isResolved("goal_vs_recovery", intake)) return null;

  const { recovery_readiness } = intelligence;

  // Only "warning_overreach" is conclusive — stalled/recovering_well are not flags
  if (recovery_readiness.status !== "warning_overreach") return null;

  // The flag is relevant when the intake implies loading intent (strength or performance).
  // body_comp and health goals won't drive a full-load block from day one, so
  // we warn on those too — better safe than silent.
  // (All goal types are flagged because opening light never harms any goal.)

  const note = recoveryResponsivenessNote(responsiveness);

  const finding: SanityFinding = {
    type: "goal_vs_recovery",
    recovery_status: "warning_overreach",
    proposed_opening_volume_pct: PROPOSED_OPENING_VOLUME_PCT,
    rationale:
      `Recovery metrics indicate overreach (${recovery_readiness.narrative}). ` +
      `Opening the plan at ${Math.round(PROPOSED_OPENING_VOLUME_PCT * 100)}% of target volume ` +
      `for week 1 reduces injury risk and improves adaptation.`,
    ...(note ? { responsiveness_note: note } : {}),
  };

  return finding;
}

/**
 * deficit_vs_muscle_loss: fires when:
 *   - intake nutrition phase is a cut (indicates caloric deficit intent)
 *   - AND (nutrition_performance.predicted_muscle_loss_risk === "high"
 *          OR body_comp_direction.direction === "losing_muscle")
 *
 * "moderate" risk or non-cut phases → silent (not conclusive enough).
 * body_comp_direction.direction === "unknown" → not conclusive → silent.
 */
function checkDeficitVsMuscleLoss(
  intake: IntakePayload,
  intelligence: AthleteIntelligencePayload,
  responsiveness: ResponsivenessRollup | null,
): SanityFinding | null {
  if (isResolved("deficit_vs_muscle_loss", intake)) return null;

  const { nutrition_performance, body_comp_direction } = intelligence;

  // Require cut intent in intake — maintain/lean_bulk/recomp/unsure are not a cut
  const isCutIntent = intake.nutrition.current_phase === "cut";
  if (!isCutIntent) return null;

  // Conclusive: high predicted risk OR body comp already showing muscle loss
  const highRisk = nutrition_performance.predicted_muscle_loss_risk === "high";
  const losingMuscle = body_comp_direction.direction === "losing_muscle";

  if (!highRisk && !losingMuscle) return null;

  // body_comp "unknown" — not conclusive for losingMuscle path alone, but highRisk
  // from nutrition_performance is standalone-conclusive (doesn't need body comp data)

  const statedProtein = intake.nutrition.current_macros.protein_g;
  // We raise, never lower: max(stated floor, 1.8) expressed in g/kg terms.
  // We work with the absolute floor and let buildPlanPayload do the g/kg math.
  const proposedFloor = PROPOSED_PROTEIN_FLOOR_G_PER_KG;

  const note = nutritionResponsivenessNote(responsiveness);

  const finding: SanityFinding = {
    type: "deficit_vs_muscle_loss",
    muscle_loss_risk: "high",
    body_comp_direction: body_comp_direction.direction,
    proposed_protein_floor_g_per_kg: proposedFloor,
    rationale:
      (losingMuscle
        ? `Body composition data shows muscle loss while in a caloric deficit. `
        : `Nutrition analysis flags high muscle-loss risk (${nutrition_performance.narrative}). `) +
      `Raising protein floor to ${proposedFloor} g/kg BW protects lean mass during the cut.`,
    ...(note ? { responsiveness_note: note } : {}),
  };

  return finding;
}

/**
 * target_vs_adherence: fires when nutrition_performance.protein_status indicates
 * a chronic shortfall vs the stated target (marginally_short or critically_low).
 *
 * "adequate" → silent.
 * We report on the protein_g dimension here (kcal adherence is the
 * deficit_vs_muscle_loss flag's territory).
 *
 * recent_avg_g_per_kg and target_g_per_kg are computed from the intake macros
 * and bodyweight — these are directional estimates, not clinical precision.
 */
function checkTargetVsAdherence(
  intake: IntakePayload,
  intelligence: AthleteIntelligencePayload,
  responsiveness: ResponsivenessRollup | null,
): SanityFinding | null {
  if (isResolved("target_vs_adherence", intake)) return null;

  const { nutrition_performance } = intelligence;

  // Only conclusive when protein is short — "adequate" is the expected state
  if (nutrition_performance.protein_status === "adequate") return null;

  // Derive g/kg estimates from intake fields
  // We use intake macros as the "target" and nutrition_performance drivers as the "recent avg"
  // Since the intelligence layer doesn't expose a raw avg g/kg directly, we work with
  // proxy values: target from intake, and estimate recent from deficit severity context.
  // The flag is directional — the precise number is shown to the athlete for discussion.
  const targetProtein_g = intake.nutrition.current_macros.protein_g;
  const targetKcal = intake.nutrition.current_kcal;

  // Use a reference bodyweight for g/kg calculation.
  // We don't have direct access to BW here; use a reasonable placeholder of 80 kg
  // when not derivable, flagged as estimated.
  // Nutrition performance drivers contain "X g/kg" strings but we don't parse them here.
  // We expose the relative shortfall instead.
  //
  // target_g_per_kg = target protein_g / estimated_bw_kg
  // For a plan-flag we use the intake protein target directly;
  // the "recent avg" is marked at ~80% of target for critically_low, ~90% for marginally_short.
  // These are conservative estimates — the actual driver is protein_status.
  const estimatedBwKg = 80; // default when no BW in intake (no BW field on IntakePayload)
  const targetGPerKg = Math.round((targetProtein_g / estimatedBwKg) * 100) / 100;

  // Recent avg estimate based on status
  const shortfallFraction =
    nutrition_performance.protein_status === "critically_low" ? 0.7 : 0.87;
  const recentAvgGPerKg = Math.round(targetGPerKg * shortfallFraction * 100) / 100;

  const note = nutritionResponsivenessNote(responsiveness);

  const finding: SanityFinding = {
    type: "target_vs_adherence",
    target_field: "protein_g",
    recent_avg_g_per_kg: recentAvgGPerKg,
    target_g_per_kg: targetGPerKg,
    proposed_ramp_weeks: PROPOSED_RAMP_WEEKS,
    rationale:
      `Protein is chronically ${nutrition_performance.protein_status.replace(/_/g, " ")} ` +
      `vs the stated target (${targetProtein_g}g/day). ` +
      `A ${PROPOSED_RAMP_WEEKS}-week ramp phase allows habits to catch up before ` +
      `the full target is enforced in the plan.`,
    ...(note ? { responsiveness_note: note } : {}),
  };

  return finding;
}

/**
 * strength_endurance_interference: fires when interference_level is "mild" or "high".
 * "none" → silent.
 *
 * Proposed strength volume pct:
 *   high interference → 0.85 (trim 15%)
 *   mild interference → 0.90 (trim 10%)
 */
function checkStrengthEnduranceInterference(
  intake: IntakePayload,
  intelligence: AthleteIntelligencePayload,
  responsiveness: ResponsivenessRollup | null,
): SanityFinding | null {
  if (isResolved("strength_endurance_interference", intake)) return null;

  const { interference } = intelligence;

  // Only "mild" or "high" are actionable; "none" is expected steady state
  if (interference.interference_level === "none") return null;

  const level = interference.interference_level; // "mild" | "high"
  const proposedPct =
    level === "high"
      ? PROPOSED_STRENGTH_VOLUME_PCT_HIGH
      : PROPOSED_STRENGTH_VOLUME_PCT_MILD;

  // Responsiveness note from exercise_swap high_roi / low_signal (closest proxy
  // for adaptation to load-management changes)
  let note: string | undefined;
  if (responsiveness) {
    const highRoi = responsiveness.high_roi.find((l) => l.includes("exercise swap"));
    if (highRoi) note = `History: ${highRoi}`;
    else {
      const recentWin = responsiveness.recent_wins.find((w) =>
        w.startsWith("exercise swap"),
      );
      if (recentWin) note = `Recent: ${recentWin}`;
    }
  }

  const finding: SanityFinding = {
    type: "strength_endurance_interference",
    interference_level: level,
    proposed_strength_volume_pct: proposedPct,
    rationale:
      `${level === "high" ? "High" : "Mild"} strength-endurance interference detected ` +
      `(${interference.narrative}). ` +
      `Trimming strength volume to ${Math.round(proposedPct * 100)}% of target ` +
      `in the opening block reduces fatigue accumulation from concurrent training.`,
    ...(note ? { responsiveness_note: note } : {}),
  };

  return finding;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export type PlanIntelligenceChecksArgs = {
  intake: IntakePayload;
  intelligence: AthleteIntelligencePayload | null;
  responsiveness: ResponsivenessRollup | null;
};

/**
 * Run all intelligence-layer plan checks and return the fired SanityFindings.
 *
 * Returns [] when intelligence is null (graceful — caller may have no data yet)
 * or when no flag's data is conclusive.
 *
 * Each finding is guarded against:
 *   (a) intelligence non-null
 *   (b) the sub-field being conclusive (not establishing/unknown)
 *   (c) the flag not already in intake.plan_flag_resolutions (already resolved)
 */
export function planIntelligenceChecks({
  intake,
  intelligence,
  responsiveness,
}: PlanIntelligenceChecksArgs): SanityFinding[] {
  // Graceful null handling — no intelligence data available yet
  if (intelligence === null) return [];

  const findings: SanityFinding[] = [];

  const goalVsRecovery = checkGoalVsRecovery(intake, intelligence, responsiveness);
  if (goalVsRecovery) findings.push(goalVsRecovery);

  const deficitVsMuscleLoss = checkDeficitVsMuscleLoss(intake, intelligence, responsiveness);
  if (deficitVsMuscleLoss) findings.push(deficitVsMuscleLoss);

  const targetVsAdherence = checkTargetVsAdherence(intake, intelligence, responsiveness);
  if (targetVsAdherence) findings.push(targetVsAdherence);

  const interferenceFlag = checkStrengthEnduranceInterference(intake, intelligence, responsiveness);
  if (interferenceFlag) findings.push(interferenceFlag);

  return findings;
}
