import { describe, it, expect } from "vitest";
import { ruleLoadCall } from "@/lib/coach/live-session/rule-load-call";
import { nextUpKg, nextDownKg } from "@/lib/coach/prescription/double-progression-rule";
import type { LiveSetInput, LiveSessionContext } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import type { BlockPhase } from "@/lib/coach/prescription/types";

const CONTEXT: LiveSessionContext = {
  historyByExercise: {},
  bestByExercise: {},
  blockPhase: "pre_target",
  rirTarget: 2,
};

/** Three-set decline bench at 60kg x 10, RIR target 2, 2.5kg grid. */
function mkInput(over: {
  reps?: number | null;
  kg?: number | null;
  rir?: number | null;
  failure?: boolean;
  setIndex?: number;
  blockPhase?: BlockPhase;
  increment?: { step: number; intermediate?: number };
  durationSeconds?: number;
  warmup?: boolean;
} = {}): LiveSetInput {
  const setIndex = over.setIndex ?? 0;
  const set: ExerciseSetDraft = {
    set_index: setIndex,
    kg: over.kg === undefined ? 60 : over.kg,
    reps: over.reps === undefined ? 10 : over.reps,
    duration_seconds: null,
    warmup: over.warmup ?? false,
    failure: over.failure ?? false,
    rir: over.rir === undefined ? 2 : over.rir,
    committed_at: "2026-08-10T09:00:00.000Z",
  };
  const sets: ExerciseSetDraft[] = [0, 1, 2].map((i) =>
    i === setIndex ? set : { ...set, set_index: i, committed_at: null },
  );
  return {
    set,
    exercise: {
      name: "Decline Bench Press (Barbell)",
      position: 0,
      prescribed: {
        name: "Decline Bench Press (Barbell)",
        baseKg: 60,
        baseReps: 10,
        sets: 3,
        increment: over.increment ?? { step: 2.5 },
        ...(over.durationSeconds != null ? { duration_seconds: over.durationSeconds } : {}),
      },
      sets,
    },
    sessionSets: [{ exerciseName: "Decline Bench Press (Barbell)", set }],
    context: { ...CONTEXT, blockPhase: over.blockPhase ?? "pre_target" },
  };
}

describe("ruleLoadCall — the six-cell table", () => {
  it("reps hit + easy: steps the load up and offers it for one tap", () => {
    const line = ruleLoadCall(mkInput({ reps: 10, rir: 4 }));
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("load_call");
    expect(line!.apply_kg).toBe(nextUpKg(60, { step: 2.5 }));
    expect(line!.text).toContain("62.5");
    expect(line!.cue).toBe(false);
  });

  it("reps hit + on target: SILENT — this is the whole point of the feature", () => {
    expect(ruleLoadCall(mkInput({ reps: 10, rir: 2 }))).toBeNull();
    expect(ruleLoadCall(mkInput({ reps: 12, rir: 3 }))).toBeNull();
  });

  it("reps hit + strained: holds the weight, no tap target", () => {
    const line = ruleLoadCall(mkInput({ reps: 10, rir: 0 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
    expect(line!.text).toContain("Same weight");
  });

  it("reps short + easy: holds and tells the athlete to push", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 4 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
    expect(line!.text).toContain("push");
  });

  it("reps short + on target: holds so reps can climb", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 2 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
    expect(line!.text).toContain("hold");
  });

  it("reps short + strained: steps the load down", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 0 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBe(nextDownKg(60, { step: 2.5 }));
    expect(line!.text).toContain("57.5");
  });
});

describe("ruleLoadCall — grid agreement (anti-drift)", () => {
  it("a step up equals nextUpKg on a micro-pin grid", () => {
    const inc = { step: 5, intermediate: 2.3 };
    const line = ruleLoadCall(mkInput({ kg: 22, reps: 15, rir: 4, increment: inc }));
    expect(line!.apply_kg).toBe(nextUpKg(22, inc));
  });

  it("a step down equals nextDownKg on a micro-pin grid", () => {
    const inc = { step: 5, intermediate: 2.3 };
    const line = ruleLoadCall(mkInput({ kg: 22, reps: 9, rir: 0, increment: inc }));
    expect(line!.apply_kg).toBe(nextDownKg(22, inc));
  });
});

describe("ruleLoadCall — block phase freeze", () => {
  it.each<BlockPhase>(["consolidation", "off_pace", "deload_week"])(
    "does not offer a load change during %s",
    (blockPhase) => {
      const line = ruleLoadCall(mkInput({ reps: 10, rir: 4, blockPhase }));
      expect(line).not.toBeNull();
      expect(line!.apply_kg).toBeUndefined();
      expect(line!.text).toContain("held");
    },
  );

  it("holds in both directions during a freeze — no step down either", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 0, blockPhase: "consolidation" }));
    expect(line!.apply_kg).toBeUndefined();
  });
});

describe("ruleLoadCall — guards", () => {
  it("stays silent on warmup sets", () => {
    expect(ruleLoadCall(mkInput({ warmup: true, reps: 5, rir: 6 }))).toBeNull();
  });

  it("stays silent when RIR was not recorded", () => {
    expect(ruleLoadCall(mkInput({ rir: null, reps: 15 }))).toBeNull();
  });

  it("stays silent on time-based exercises", () => {
    expect(ruleLoadCall(mkInput({ durationSeconds: 60, reps: 1, rir: 5 }))).toBeNull();
  });

  it("offers no tap target when the exercise has no equipment grid", () => {
    const input = mkInput({ reps: 10, rir: 4 });
    delete input.exercise.prescribed.increment;
    const line = ruleLoadCall(input);
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
  });

  it("reframes to next-time wording on the final working set", () => {
    const line = ruleLoadCall(mkInput({ setIndex: 2, reps: 10, rir: 4 }));
    expect(line!.text).toContain("next time");
    expect(line!.text).not.toContain("next set");
  });
});
