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
    expect(line!.text).toContain(`${Math.round((e1rm - 110) * 10) / 10}`);
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

  it("still fires just inside the 15 percent guard", () => {
    // best 100, set 100x3 -> 105.9 e1RM = +5.9%
    expect(rulePr(mkInput({ kg: 100, reps: 3, best: 100 }))).not.toBeNull();
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
