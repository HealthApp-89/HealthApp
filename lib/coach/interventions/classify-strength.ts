// lib/coach/interventions/classify-strength.ts
//
// Block-aware classification: distinguishes PLANNED program structure
// (end-of-block deloads, block-boundary rotations) from REACTIVE interventions
// (mid-block deloads, mid-block swaps). Only reactive events feed responsiveness
// memory — crediting a scheduled deload would measure the program, not the athlete.

import type { TrainingBlock } from "@/lib/data/types";
import type { BlockPhase } from "@/lib/coach/prescription/types";

/** Minimum primary-lift load drop (fraction) to count as a deload at all. */
export const DELOAD_MIN_DROP_PCT = 0.1;

export function classifyDeload(opts: {
  block: TrainingBlock | null;
  weekPhase: BlockPhase | null;
  loadDropPct: number; // positive = drop, e.g. 0.2 = 20% down
  todayIso: string;
}): "planned" | "reactive" | "not_a_deload" {
  if (opts.loadDropPct < DELOAD_MIN_DROP_PCT) return "not_a_deload";
  // A drop during the scheduled deload week is the program, not an intervention.
  if (opts.weekPhase === "deload_week") return "planned";
  return "reactive";
}

export function classifySwap(opts: {
  isBoundaryWeek: boolean; // first training week of a new block = planned rotation
  sameExercise: boolean;
}): "planned_rotation" | "reactive" | "not_a_swap" {
  if (opts.sameExercise) return "not_a_swap";
  if (opts.isBoundaryWeek) return "planned_rotation";
  return "reactive";
}
