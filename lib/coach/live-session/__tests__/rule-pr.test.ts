import { describe, it, expect } from "vitest";
import { rulePr } from "@/lib/coach/live-session/rule-pr";
import { brzycki } from "@/lib/coach/e1rm";
import type { LiveSetInput } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft } from "@/lib/logger/types";

const NAME = "Deadlift (Barbell)";

function mkInput(over: {
  kg?: number | null;
  reps?: number | null;
  best?: number | null;
  warmup?: boolean;
} = {}): LiveSetInput {
  const set: ExerciseSetDraft = {
    set_index: 0,
    kg: over.kg === undefined ? 100 : over.kg,
    reps: over.reps === undefined ? 5 : over.reps,
    duration_seconds: null,
    warmup: over.warmup ?? false,
    failure: false,
    rir: 2,
    committed_at: "2026-08-10T09:00:00.000Z",
  };
  return {
    set,
    exercise: {
      name: NAME,
      position: 0,
      prescribed: { name: NAME, baseKg: 100, baseReps: 5, sets: 3, increment: { step: 5 } },
      sets: [set],
    },
    sessionSets: [{ exerciseName: NAME, set }],
    context: {
      historyByExercise: {},
      bestByExercise: { [NAME]: over.best === undefined ? 110 : over.best },
      blockPhase: "pre_target",
      rirTarget: 2,
    },
  };
}

describe("rulePr", () => {
  it("fires when this set's e1RM beats the stored best", () => {
    // 100 x 5 -> Brzycki 112.5
    const line = rulePr(mkInput({ kg: 100, reps: 5, best: 110 }));
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("pr");
    expect(line!.cue).toBe(true);
    expect(line!.text).toContain("PR");
    expect(line!.text).toContain("112.5");
  });

  it("reports the margin over the previous best", () => {
    const line = rulePr(mkInput({ kg: 100, reps: 5, best: 110 }));
    const e1rm = brzycki(100, 5)!;
    const margin = Math.round((e1rm - 110) * 10) / 10;
    expect(line!.text).toContain(`past your best by ${margin}.`);
  });

  it("stays silent when the set does not beat the best", () => {
    expect(rulePr(mkInput({ kg: 100, reps: 5, best: 120 }))).toBeNull();
  });

  it("stays silent when there is no prior history — first entry is not a PR", () => {
    expect(rulePr(mkInput({ best: null }))).toBeNull();
  });

  it("suppresses implausible jumps over 15 percent — a mistyped weight", () => {
    // 200 x 5 -> 225 e1RM against a 110 best is +104%: a typo, not a PR.
    expect(rulePr(mkInput({ kg: 200, reps: 5, best: 110 }))).toBeNull();
  });

  it("fires just inside the 15 percent ceiling", () => {
    // best 100, set 102x5 -> Brzycki ~114.75 = +14.75%
    const line = rulePr(mkInput({ kg: 102, reps: 5, best: 100 }));
    const e1rm = brzycki(102, 5)!;
    expect(e1rm / 100).toBeLessThan(1.15);
    expect(line).not.toBeNull();
  });

  it("stays silent just past the 15 percent ceiling", () => {
    // best 100, set 102.3x5 -> Brzycki ~115.09 = +15.09%
    const line = rulePr(mkInput({ kg: 102.3, reps: 5, best: 100 }));
    const e1rm = brzycki(102.3, 5)!;
    expect(e1rm / 100).toBeGreaterThan(1.15);
    expect(line).toBeNull();
  });

  it("stays silent on warmup sets", () => {
    expect(rulePr(mkInput({ warmup: true, kg: 100, reps: 5, best: 50 }))).toBeNull();
  });

  it("stays silent above 12 reps where Brzycki is unreliable", () => {
    expect(rulePr(mkInput({ kg: 100, reps: 15, best: 110 }))).toBeNull();
  });

  it("stays silent when kg or reps are missing", () => {
    expect(rulePr(mkInput({ kg: null }))).toBeNull();
    expect(rulePr(mkInput({ reps: null }))).toBeNull();
  });
});

/** Session-local high-water mark.
 *
 *  context.bestByExercise is frozen at logger open (`.lt("date", today)`,
 *  staleTime Infinity), so nothing in it moves when a PR happens mid-session.
 *  Without a session-local bar, the identical PR line — and a second audio cue
 *  — fires on every subsequent set at the same load. */
describe("rulePr — session high-water mark", () => {
  const NAME2 = "Deadlift (Barbell)";

  function mkSet(over: Partial<ExerciseSetDraft>): ExerciseSetDraft {
    return {
      set_index: 0,
      kg: 100,
      reps: 5,
      duration_seconds: null,
      warmup: false,
      failure: false,
      rir: 2,
      committed_at: "2026-08-10T09:00:00.000Z",
      ...over,
    };
  }

  function mkSessionInput(args: {
    sets: ExerciseSetDraft[];
    current: ExerciseSetDraft;
    best: number | null;
  }): LiveSetInput {
    return {
      set: args.current,
      exercise: {
        name: NAME2,
        position: 0,
        prescribed: { name: NAME2, baseKg: 100, baseReps: 5, sets: 3, increment: { step: 5 } },
        sets: args.sets,
      },
      sessionSets: args.sets.map((s) => ({ exerciseName: NAME2, set: s })),
      context: {
        historyByExercise: {},
        bestByExercise: { [NAME2]: args.best },
        blockPhase: "pre_target",
        rirTarget: 2,
      },
    };
  }

  it("fires on the FIRST set that clears the stored best", () => {
    const s0 = mkSet({ set_index: 0, kg: 100, reps: 5 }); // e1RM 112.5
    const line = rulePr(mkSessionInput({ sets: [s0], current: s0, best: 110 }));
    expect(line).not.toBeNull();
    expect(line!.cue).toBe(true);
  });

  it("does NOT re-fire on an identical second set at the same load", () => {
    // 110 stored best; 100x5 = 112.5 twice. Set 2 must be silent — no second
    // celebration, and critically no second audio cue.
    const s0 = mkSet({ set_index: 0, kg: 100, reps: 5 });
    const s1 = mkSet({ set_index: 1, kg: 100, reps: 5 });
    expect(rulePr(mkSessionInput({ sets: [s0, s1], current: s1, best: 110 }))).toBeNull();
  });

  it("stays silent on a third set that falls back below the session best", () => {
    // 100x4 -> 109.09, under both the session best (112.5) and the old 110.
    const s0 = mkSet({ set_index: 0, kg: 100, reps: 5 });
    const s1 = mkSet({ set_index: 1, kg: 100, reps: 5 });
    const s2 = mkSet({ set_index: 2, kg: 100, reps: 4 });
    expect(rulePr(mkSessionInput({ sets: [s0, s1, s2], current: s2, best: 110 }))).toBeNull();
  });

  it("fires AGAIN when a later set genuinely beats the new session best", () => {
    // 100x5 = 112.5, then 105x5 = 118.125 — a real second PR, so it speaks.
    const s0 = mkSet({ set_index: 0, kg: 100, reps: 5 });
    const s1 = mkSet({ set_index: 1, kg: 105, reps: 5 });
    const line = rulePr(mkSessionInput({ sets: [s0, s1], current: s1, best: 110 }));
    expect(line).not.toBeNull();
    // Margin is measured against the SESSION best (112.5), not the stale 110.
    expect(line!.text).toContain("past your best by 5.6");
  });

  it("excludes the just-committed set from its own bar", () => {
    // If the current set counted toward the high-water mark, e1rm <= best
    // would hold for every set and nothing would ever be a PR.
    const s0 = mkSet({ set_index: 0, kg: 100, reps: 5 });
    expect(rulePr(mkSessionInput({ sets: [s0], current: s0, best: 110 }))).not.toBeNull();
  });

  it("ignores earlier sets of OTHER exercises", () => {
    const other: ExerciseSetDraft = mkSet({ set_index: 0, kg: 200, reps: 5 });
    const s1 = mkSet({ set_index: 1, kg: 100, reps: 5 });
    const input = mkSessionInput({ sets: [s1], current: s1, best: 110 });
    input.sessionSets = [
      { exerciseName: "Squat (Barbell)", set: other },
      { exerciseName: NAME2, set: s1 },
    ];
    expect(rulePr(input)).not.toBeNull();
  });

  it("ignores earlier WARMUP sets when building the bar", () => {
    const w = mkSet({ set_index: 0, kg: 140, reps: 5, warmup: true });
    const s1 = mkSet({ set_index: 1, kg: 100, reps: 5 });
    const input = mkSessionInput({ sets: [w, s1], current: s1, best: 110 });
    expect(rulePr(input)).not.toBeNull();
  });

  it("still refuses to invent a PR when there is no stored history at all", () => {
    // A within-session ramp on a brand-new exercise must not manufacture one.
    const s0 = mkSet({ set_index: 0, kg: 50, reps: 5 });
    const s1 = mkSet({ set_index: 1, kg: 60, reps: 5 });
    expect(rulePr(mkSessionInput({ sets: [s0, s1], current: s1, best: null }))).toBeNull();
  });
});
