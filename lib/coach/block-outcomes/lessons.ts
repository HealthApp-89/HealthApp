// lib/coach/block-outcomes/lessons.ts
//
// Pure templating. Builds the deterministic lessons jsonb from evaluator
// facts + rotation decision + secondary-lift summary.

import type { BlockOutcomeLessons, BlockPhaseAtEnd, PrimaryLift } from "@/lib/data/types";
import type { BlockOutcomeFacts } from "@/lib/coach/block-outcomes/evaluator";
import type { SecondaryLiftOutcome } from "@/lib/coach/block-outcomes/types";
import type { RotationDecision } from "@/lib/coach/block-outcomes/rotation";

export function composeLessons(opts: {
  facts: BlockOutcomeFacts;
  primaryLift: PrimaryLift;
  targetValueKg: number | null;
  secondaryLifts: SecondaryLiftOutcome[];
  rotationDecision: RotationDecision;
}): BlockOutcomeLessons {
  const { facts, secondaryLifts, rotationDecision } = opts;

  const calibration_note = calibrationNote(facts.block_phase_at_end, facts.gap_pct, facts.observed_step_kg_per_wk);

  return {
    observed_step_kg_per_wk: facts.observed_step_kg_per_wk,
    projected_kg_at_end: facts.projected_kg_at_end,
    gap_kg: facts.gap_kg,
    gap_pct: facts.gap_pct,
    calibration_note,
    secondary_lifts: secondaryLifts,
    rotation_context: {
      ideal_next: rotationDecision.recommended_lift,
      athlete_overrode_rotation: false,
      override_reason: null,
    },
  };
}

function calibrationNote(
  phase: BlockPhaseAtEnd,
  gapPct: number | null,
  observedStep: number | null,
): string {
  switch (phase) {
    case "hit_early":
      return "Target was conservative — block ended in consolidation. Next focus block target raised more aggressively from the in-block step rate.";
    case "hit_on_pace":
      return "Clean execution at the prescribed pace. Next focus block target derived from end working kg + 4 accumulation weeks at the same step rate.";
    case "off_pace": {
      const gapPart = gapPct != null ? ` (${gapPct.toFixed(0)}% gap)` : "";
      const stepPart =
        observedStep != null
          ? ` Observed step ${observedStep.toFixed(2)} kg/wk — actual rate, not aspirational.`
          : "";
      return `Target was unreachable in remaining weeks${gapPart}. Next time this lift comes around, target sets from end working kg + 4 weeks of observed rate.${stepPart}`;
    }
    case "underperformed":
      return "Narrow miss — within 10% of target. Target was approximately right; consider whether one more accumulation week or a slightly slower step would close the gap.";
  }
}
