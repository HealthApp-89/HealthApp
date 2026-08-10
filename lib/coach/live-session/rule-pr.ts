// lib/coach/live-session/rule-pr.ts
//
// Celebrate at the moment it happens, not three hours later in the debrief.
// Celebration has a half-life.
//
// This is the only rule that returns cue: true. The audio cue is reserved for
// PRs so that a sound always means something genuinely happened.

import { brzycki } from "@/lib/coach/e1rm";
import { fmtNum } from "@/lib/ui/score";
import type { CoachLine, LiveSetInput } from "./types";

/** A single-session e1RM jump beyond this ratio is a mistyped weight far more
 *  often than a real PR, and a false celebration is worse than a missed one. */
const MAX_PLAUSIBLE_JUMP = 1.15;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function rulePr(input: LiveSetInput): CoachLine | null {
  const { set, exercise, context } = input;

  if (set.warmup) return null;
  if (set.kg == null || set.reps == null) return null;

  // brzycki returns null outside 1..12 reps — above that the linear
  // extrapolation stops being a strength proxy.
  const e1rm = brzycki(set.kg, set.reps);
  if (e1rm == null) return null;

  const best = context.bestByExercise[exercise.name] ?? null;
  if (best == null) return null;
  if (e1rm <= best) return null;
  if (e1rm > best * MAX_PLAUSIBLE_JUMP) return null;

  const margin = round1(e1rm - best);
  return {
    kind: "pr",
    text: `PR — ${fmtNum(set.kg)} × ${set.reps} = ${fmtNum(round1(e1rm))} e1RM, past your best by ${fmtNum(margin)}.`,
    cue: true,
    rule: "pr",
  };
}
