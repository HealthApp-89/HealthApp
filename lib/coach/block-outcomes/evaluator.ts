// lib/coach/block-outcomes/evaluator.ts
//
// Pure: given a TrainingBlock and the clean working sets from its window,
// compute the deterministic outcome facts. No Supabase, no AI.
//
// Comparison metric honors `training_blocks.target_metric`:
//   'working_weight' → end_working_kg = max raw kg across non-warmup sets
//   'e1rm'           → end_working_kg = max Brzycki e1RM across non-warmup
//                      sets in the 1..12 rep window (the "end value to compare
//                      against target_value", whatever the metric)
//   null (legacy)    → defaults to 'working_weight'

import type { TrainingBlock, BlockPhaseAtEnd, TargetMetric } from "@/lib/data/types";
import type { BlockSetSample } from "@/lib/coach/block-outcomes/types";
import { bestComparisonValue } from "@/lib/coach/e1rm";

const OFF_PACE_THRESHOLD = 0.90; // end value < target × 0.90 → off_pace; else underperformed
const HIT_EARLY_GAP_WEEKS = 1;   // target hit at_week < (totalWeeks - HIT_EARLY_GAP_WEEKS) → hit_early

export type BlockOutcomeFacts = {
  /** The "end value" used for the target comparison. For working_weight blocks
   *  this is max raw kg; for e1rm blocks this is max Brzycki e1RM. Field name
   *  kept for back-compat — the *_kg suffix is true in both cases (e1RM is
   *  also in kg). */
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

  const metric: TargetMetric = (block.target_metric as TargetMetric | null) ?? "working_weight";
  // Outcomes are computed off CLEAN sets only (warmup/failure filtered upstream
  // in block-outcomes/index.ts), so the warmup flag is always false here.
  // bestComparisonValue honors the metric without needing the upstream filter
  // to re-think e1RM rep-window rejection.
  const end_working_kg = bestComparisonValue(
    primarySets.map((s) => ({ kg: s.kg, reps: s.reps, warmup: false })),
    metric,
  );
  const target = block.target_value;
  const target_hit = end_working_kg != null && target != null && end_working_kg >= target;

  const observed_step_kg_per_wk = estimateWeeklyStep(primarySets, metric);

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

function estimateWeeklyStep(sets: BlockSetSample[], metric: TargetMetric): number | null {
  if (sets.length < 2) return null;
  const weeklyMax: Map<number, number> = new Map();
  for (const s of sets) {
    // Per-week max in the comparison space (kg or e1RM). When metric='e1rm'
    // and the rep count is out of the 1..12 window, bestComparisonValue
    // would reject the set — skip it here too so the slope reflects only
    // valid comparison points.
    const v = bestComparisonValue([{ kg: s.kg, reps: s.reps, warmup: false }], metric);
    if (v == null) continue;
    weeklyMax.set(s.weekN, Math.max(weeklyMax.get(s.weekN) ?? 0, v));
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
