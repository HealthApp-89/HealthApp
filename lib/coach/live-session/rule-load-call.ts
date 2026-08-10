// lib/coach/live-session/rule-load-call.ts
//
// The core verdict: given one committed set, what should the next one weigh?
//
// This is intra-session double progression. It answers a DIFFERENT question
// from prescribeAccessoryDoubleProgression, which reasons over 28 days of
// sessions — but it must land on the SAME equipment grid, so the load
// arithmetic goes through nextUpKg / nextDownKg and nowhere else.

import { repsForExercise } from "@/lib/coach/session-structure/rules";
import {
  nextUpKg,
  nextDownKg,
} from "@/lib/coach/prescription/double-progression-rule";
import { fmtNum } from "@/lib/ui/score";
import { effortBand, isFinalWorkingSet } from "./helpers";
import type { CoachLine, LiveSetInput } from "./types";

/** Phases in which the weekly engine freezes load. The live rule must never
 *  contradict it: consolidation and off_pace freeze by block-phase rule, and
 *  deload holds load by the accessory rule's deload branch. */
function isLoadFrozen(input: LiveSetInput): boolean {
  const p = input.context.blockPhase;
  return p === "consolidation" || p === "off_pace" || p === "deload_week";
}

export function ruleLoadCall(input: LiveSetInput): CoachLine | null {
  const { set, exercise, context } = input;

  if (set.warmup) return null;
  // Time-based work (planks, hangs, foam rolls) has no kg/reps semantics.
  if (exercise.prescribed.duration_seconds != null) return null;
  if (set.reps == null || set.kg == null) return null;

  const repTarget = repsForExercise(exercise.prescribed);
  if (repTarget == null) return null;

  const effortTarget = exercise.prescribed.rir ?? context.rirTarget;
  const band = effortBand(set, effortTarget);
  if (band == null) return null;

  const hitReps = set.reps >= repTarget;

  // No grid means no loadable number to suggest (bodyweight work). Treat it
  // the same as a freeze: advise, but never name a weight.
  const grid = exercise.prescribed.increment;
  const frozen = isLoadFrozen(input) || grid == null;
  const finalSet = isFinalWorkingSet(exercise, set);
  const horizon = finalSet ? "next time" : "next set";

  const line = (text: string, apply_kg?: number): CoachLine => ({
    kind: "load_call",
    text,
    ...(apply_kg != null ? { apply_kg } : {}),
    cue: false,
    rule: "load_call",
  });

  if (hitReps) {
    if (band === "on") return null; // exactly to plan — say nothing
    if (band === "strained") {
      return line(`Hit ${set.reps}, but that cost more than it should. Same weight.`);
    }
    // band === "easy"
    if (frozen) {
      return line(
        `Too easy at RIR ${set.rir}. Add a rep ${horizon} — load's held this block.`,
      );
    }
    const up = nextUpKg(set.kg, grid);
    return line(`Too easy at RIR ${set.rir}. → ${fmtNum(up)} ${horizon}.`, up);
  }

  const short = repTarget - set.reps;
  if (band === "easy") {
    return line(
      `Stopped ${short} short with ${set.rir} in reserve. Same weight — push it.`,
    );
  }
  if (band === "on") {
    return line(
      `${short} short at the right effort. Load's heavy for this range — hold and let reps climb.`,
    );
  }
  // band === "strained"
  if (frozen) {
    return line(`Short by ${short} with nothing left. Load's held this block — same weight.`);
  }
  const down = nextDownKg(set.kg, grid);
  return line(`Short by ${short} with nothing left. → ${fmtNum(down)}.`, down);
}
