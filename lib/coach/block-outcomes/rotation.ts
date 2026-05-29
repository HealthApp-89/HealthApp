// lib/coach/block-outcomes/rotation.ts
//
// Pure rotation engine. Default cycle D → B → S → OHP. When
// profiles.rotation_priority_lift is set, applies an injection pattern:
// every other rotation slot becomes the priority lift, with a non-priority
// lift between for recovery. No two consecutive same-lift focuses.

import type { TrainingBlock, PrimaryLift, BlockPhaseAtEnd } from "@/lib/data/types";

export const ROTATION_ORDER: PrimaryLift[] = ["deadlift", "bench", "squat", "ohp"];

export type RotationDecision = {
  recommended_lift: PrimaryLift;
  reasoning: "standard_rotation" | "priority_injection" | "off_pace_recovery_avoided" | "first_block";
  consecutive_focus_warning: boolean;
};

export function recommendNextFocus(opts: {
  userBlocks: TrainingBlock[];
  priorityLift: PrimaryLift | null;
  lastOutcome: { primary_lift: PrimaryLift; block_phase_at_end: BlockPhaseAtEnd } | null;
}): RotationDecision {
  const { userBlocks, priorityLift, lastOutcome } = opts;

  if (lastOutcome == null || userBlocks.length === 0) {
    return {
      recommended_lift: priorityLift ?? "deadlift",
      reasoning: "first_block",
      consecutive_focus_warning: false,
    };
  }

  const lastLift = lastOutcome.primary_lift;
  const recentLifts = userBlocks.slice(0, 2).map((b) => b.primary_lift).filter((l): l is PrimaryLift => l != null);

  if (priorityLift == null) {
    const idx = ROTATION_ORDER.indexOf(lastLift);
    const nextIdx = (idx + 1) % ROTATION_ORDER.length;
    return {
      recommended_lift: ROTATION_ORDER[nextIdx],
      reasoning: "standard_rotation",
      consecutive_focus_warning: false,
    };
  }

  if (lastLift === priorityLift) {
    const candidates = ROTATION_ORDER.filter((l) => l !== priorityLift);
    const fresh = candidates.find((l) => !recentLifts.includes(l)) ?? candidates[0];
    return {
      recommended_lift: fresh,
      reasoning: lastOutcome.block_phase_at_end === "off_pace" ? "off_pace_recovery_avoided" : "priority_injection",
      consecutive_focus_warning: false,
    };
  }

  return {
    recommended_lift: priorityLift,
    reasoning: "priority_injection",
    consecutive_focus_warning: false,
  };
}

/** Helper for the trajectory composer — produces the "ideal" sequence for
 *  N blocks given the priority setting. */
export function idealSequence(opts: {
  n: number;
  priorityLift: PrimaryLift | null;
  startingLift?: PrimaryLift;
}): PrimaryLift[] {
  const { n, priorityLift } = opts;
  const start = opts.startingLift ?? "deadlift";
  const out: PrimaryLift[] = [start];

  for (let i = 1; i < n; i++) {
    const last = out[out.length - 1];
    const recent = out.slice(Math.max(0, out.length - 2));
    const decision = recommendNextFocus({
      userBlocks: recent.map((lift) => ({ primary_lift: lift } as TrainingBlock)),
      priorityLift,
      lastOutcome: { primary_lift: last, block_phase_at_end: "hit_on_pace" },
    });
    out.push(decision.recommended_lift);
  }
  return out;
}
