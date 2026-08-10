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

/** Best e1RM already achieved on this exercise EARLIER in today's session.
 *
 *  `context.bestByExercise` is a snapshot frozen at logger open (the fetcher
 *  queries `.lt("date", today)` and the hook holds it at `staleTime: Infinity`),
 *  so nothing in it moves when a PR happens mid-session. Without this, sets of
 *  100×5, 100×5, 100×4 against a stored best of 110 produce the IDENTICAL PR
 *  line twice — and a second audio cue, which is precisely the thing that makes
 *  a sound stop meaning something.
 *
 *  Derived from `sessionSets` rather than module state so the rule stays pure.
 *  Strictly BEFORE this set: `set_index < set.set_index`, or nothing would ever
 *  clear its own bar. */
function sessionBestBefore(input: LiveSetInput): number | null {
  const name = input.exercise.name;
  let best: number | null = null;
  for (const ref of input.sessionSets ?? []) {
    if (ref.exerciseName !== name) continue;
    const s = ref.set;
    if (s.warmup) continue;
    if (s.set_index >= input.set.set_index) continue;
    if (s.kg == null || s.reps == null) continue;
    const v = brzycki(s.kg, s.reps);
    if (v == null) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

export function rulePr(input: LiveSetInput): CoachLine | null {
  const { set, exercise, context } = input;

  if (set.warmup) return null;
  if (set.kg == null || set.reps == null) return null;

  // brzycki returns null outside 1..12 reps — above that the linear
  // extrapolation stops being a strength proxy.
  const e1rm = brzycki(set.kg, set.reps);
  if (e1rm == null) return null;

  const stored = context.bestByExercise[exercise.name] ?? null;
  // A first-ever entry is not a PR: with no stored history there is no bar to
  // clear, and an opening ramp within a single session must not manufacture
  // one either. So the stored best gates the rule, and the session high-water
  // mark only ever RAISES the bar.
  if (stored == null) return null;

  const sessionBest = sessionBestBefore(input);
  const best = sessionBest != null && sessionBest > stored ? sessionBest : stored;

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
