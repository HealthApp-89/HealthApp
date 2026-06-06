// lib/coach/weekly-review/phase-mapping.ts
//
// Map (week_n, total_weeks, training_blocks.research_phase) → WeeklyPhase.
// Canonical 5-week meso: MEV (Wk1) → MAV (Wk2-3) → MRV (Wk4) → Deload (Wk5).
// For non-5-week blocks, MRV is week (total-1), Deload is week total when
// research_phase != 'deload'; if research_phase = 'deload' the whole block
// is a deload (rare).

import type { ResearchPhase, WeeklyPhase } from "@/lib/data/types";

export function weeklyPhaseFor(
  weekN: number,
  totalWeeks: number,
  researchPhase: ResearchPhase,
): WeeklyPhase {
  if (researchPhase === "deload") return "deload";
  if (weekN <= 1) return "mev";
  if (weekN >= totalWeeks) return "deload";
  if (weekN === totalWeeks - 1) return "mrv";
  return "mav";
}

export function nextWeeklyPhaseFor(
  currentWeekN: number,
  totalWeeks: number,
  researchPhase: ResearchPhase,
): WeeklyPhase {
  return weeklyPhaseFor(currentWeekN + 1, totalWeeks, researchPhase);
}

/** Map a WeeklyPhase back to the canonical week-of-block index used by
 *  volume-landmarks.targetSetsForWeek. Used by compose-volume to compute
 *  next-week per-muscle targets from a phase symbol when the orchestrator
 *  hasn't yet resolved the literal next week_n.
 *
 *  MEV → 1 (start of ramp)
 *  MAV → 3 (mid-ramp; targetSetsForWeek interpolates linearly Wk1-4)
 *  MRV → 4 (peak)
 *  Deload → 5 (recipe.deload_pct) */
export function blockWeekForPhase(phase: WeeklyPhase): number {
  switch (phase) {
    case "mev":
      return 1;
    case "mav":
      return 3;
    case "mrv":
      return 4;
    case "deload":
      return 5;
    default:
      // v2 BlockPhase labels are not used by this v1 volume-ramp helper;
      // fall back to MEV (week 1) so the function stays total.
      return 1;
  }
}
