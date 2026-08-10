// lib/coach/live-session/rule-failure-budget.ts
//
// Junk fatigue is the most common self-coaching error: taking working sets to
// failure repeatedly because it feels like effort. Failure on the LAST set of
// isolation work is appropriate and stays unflagged; everything else past the
// first is a debt paid later in the week.

import { tierOf } from "@/lib/coach/session-structure/tiers";
import { isFinalWorkingSet, ordinal } from "./helpers";
import type { CoachLine, LiveSetInput, SessionSetRef } from "./types";

function wasToFailure(s: SessionSetRef["set"]): boolean {
  return !s.warmup && (s.failure || s.rir === 0);
}

export function ruleFailureBudget(input: LiveSetInput): CoachLine | null {
  const { set, exercise, sessionSets } = input;

  if (!wasToFailure(set)) return null;

  // Tier 3 (isolation) and tier 4 (finisher) earn a failure set at the end.
  const tier = tierOf(exercise.prescribed);
  if ((tier === 3 || tier === 4) && isFinalWorkingSet(exercise, set)) return null;

  const count = sessionSets.filter((r) => wasToFailure(r.set)).length;
  if (count < 2) return null;

  return {
    kind: "guardrail",
    text: `${ordinal(count)} set to failure today. That's fatigue you'll pay for later in the week — leave 2 in the tank.`,
    cue: false,
    rule: "failure_budget",
  };
}
