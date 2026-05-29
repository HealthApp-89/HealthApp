// lib/coach/block-outcomes/evaluator.ts
//
// Pure: given a TrainingBlock and the clean working sets from its window,
// compute the deterministic outcome facts. No Supabase, no AI.

import type { TrainingBlock, BlockPhaseAtEnd } from "@/lib/data/types";
import type { BlockSetSample } from "@/lib/coach/block-outcomes/types";

const OFF_PACE_THRESHOLD = 0.90; // end_working_kg < target × 0.90 → off_pace; else underperformed
const HIT_EARLY_GAP_WEEKS = 1;   // target hit at_week < (totalWeeks - HIT_EARLY_GAP_WEEKS) → hit_early

export type BlockOutcomeFacts = {
  end_working_kg: number | null;
  target_hit: boolean;
  block_phase_at_end: BlockPhaseAtEnd;
  observed_step_kg_per_wk: number | null;
  projected_kg_at_end: number | null;
  gap_kg: number | null;
  gap_pct: number | null;
};

export function evaluateBlockOutcome(opts: {
  block: TrainingBlock;
  primarySets: BlockSetSample[];
  totalBlockWeeks: number;
}): BlockOutcomeFacts {
  const { block, primarySets, totalBlockWeeks } = opts;

  const end_working_kg = primarySets.length > 0 ? Math.max(...primarySets.map((s) => s.kg)) : null;
  const target = block.target_value;
  const target_hit = end_working_kg != null && target != null && end_working_kg >= target;

  const observed_step_kg_per_wk = estimateWeeklyStep(primarySets);

  const projected_kg_at_end =
    target_hit && end_working_kg != null && observed_step_kg_per_wk != null
      ? end_working_kg + observed_step_kg_per_wk * Math.max(0, totalBlockWeeks - (block.target_hit_at_week ?? totalBlockWeeks))
      : null;

  const gap_kg = end_working_kg != null && target != null ? target - end_working_kg : null;
  const gap_pct = gap_kg != null && target != null && target !== 0 ? (gap_kg / target) * 100 : null;

  let block_phase_at_end: BlockPhaseAtEnd;
  if (target_hit) {
    if (
      block.target_hit_at_week != null &&
      block.target_hit_at_week < totalBlockWeeks - HIT_EARLY_GAP_WEEKS
    ) {
      block_phase_at_end = "hit_early";
    } else {
      block_phase_at_end = "hit_on_pace";
    }
  } else {
    if (end_working_kg != null && target != null && end_working_kg < target * OFF_PACE_THRESHOLD) {
      block_phase_at_end = "off_pace";
    } else {
      block_phase_at_end = "underperformed";
    }
  }

  return { end_working_kg, target_hit, block_phase_at_end, observed_step_kg_per_wk, projected_kg_at_end, gap_kg, gap_pct };
}

function estimateWeeklyStep(sets: BlockSetSample[]): number | null {
  if (sets.length < 2) return null;
  const weeklyMax: Map<number, number> = new Map();
  for (const s of sets) {
    weeklyMax.set(s.weekN, Math.max(weeklyMax.get(s.weekN) ?? 0, s.kg));
  }
  const points = Array.from(weeklyMax.entries()).sort((a, b) => a[0] - b[0]);
  if (points.length < 2) return null;
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p[0], 0);
  const sumY = points.reduce((a, p) => a + p[1], 0);
  const sumXY = points.reduce((a, p) => a + p[0] * p[1], 0);
  const sumX2 = points.reduce((a, p) => a + p[0] * p[0], 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}
