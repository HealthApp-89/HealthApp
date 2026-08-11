import { describe, it, expect } from "vitest";
import { propagateLoad } from "@/lib/logger/propagate-load";
import type { ExerciseSetDraft } from "@/lib/logger/types";

const COMMITTED = "2026-08-11T09:00:00Z";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 100,
    reps: 8,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: null,
    ...over,
  };
}

/** The kg of every set, in order — the assertion this file is really about. */
const loads = (sets: readonly ExerciseSetDraft[]) => sets.map((s) => s.kg);

describe("propagateLoad", () => {
  it("carries an increase on set 1 down every following working set", () => {
    const sets = [mkSet(), mkSet(), mkSet(), mkSet()];
    expect(loads(propagateLoad(sets, 0, 110))).toEqual([110, 110, 110, 110]);
  });

  it("carries a mid-exercise increase down, leaving the committed set above alone", () => {
    // The athlete's own example: set 1 done at 100, bump set 2 to 110, and
    // sets 3 and 4 should follow without being retyped.
    const sets = [
      mkSet({ set_index: 0, committed_at: COMMITTED }),
      mkSet({ set_index: 1 }),
      mkSet({ set_index: 2 }),
      mkSet({ set_index: 3 }),
    ];
    expect(loads(propagateLoad(sets, 1, 110))).toEqual([100, 110, 110, 110]);
  });

  it("stops at a set that had already diverged, and leaves everything below it", () => {
    // Set 5 was hand-set to 90 as a back-off. That divergence is the record of
    // a deliberate choice, so the chain ends there — and set 6 below it, which
    // still reads 100, must NOT be picked up on the far side of the stop.
    const sets = [
      mkSet({ set_index: 0, committed_at: COMMITTED }),
      mkSet({ set_index: 1 }),
      mkSet({ set_index: 2 }),
      mkSet({ set_index: 3 }),
      mkSet({ set_index: 4, kg: 90 }),
      mkSet({ set_index: 5 }),
    ];
    expect(loads(propagateLoad(sets, 1, 110))).toEqual([100, 110, 110, 110, 90, 100]);
  });

  it("skips a warmup row without breaking the chain", () => {
    const sets = [
      mkSet({ set_index: 0 }),
      mkSet({ set_index: 1, warmup: true, kg: 40 }),
      mkSet({ set_index: 2 }),
    ];
    expect(loads(propagateLoad(sets, 0, 110))).toEqual([110, 40, 110]);
  });

  it("skips a committed set without breaking the chain", () => {
    // A logged kg is a record of what was lifted, not a plan — never rewritten.
    // But it must not sever propagation to the pending set beneath it either.
    const sets = [
      mkSet({ set_index: 0 }),
      mkSet({ set_index: 1, committed_at: COMMITTED }),
      mkSet({ set_index: 2 }),
    ];
    expect(loads(propagateLoad(sets, 0, 110))).toEqual([110, 100, 110]);
  });

  it("does nothing when the edited set is a warmup", () => {
    // A warmup load is the athlete's ramp; it says nothing about the working
    // sets, so raising it must not raise them.
    const sets = [
      mkSet({ set_index: 0, warmup: true, kg: 40 }),
      mkSet({ set_index: 1 }),
      mkSet({ set_index: 2 }),
    ];
    const out = propagateLoad(sets, 0, 60);
    expect(out).toBe(sets);
    expect(loads(out)).toEqual([40, 100, 100]);
  });

  it("does nothing when the value did not change", () => {
    // Reached on every focus-then-blur that types nothing.
    const sets = [mkSet(), mkSet({ kg: 90 })];
    const out = propagateLoad(sets, 0, 100);
    expect(out).toBe(sets);
    expect(loads(out)).toEqual([100, 90]);
  });

  it("does nothing when the field is cleared", () => {
    // Emptying one input must not wipe the loads off the rest of the exercise.
    const sets = [mkSet(), mkSet(), mkSet()];
    const out = propagateLoad(sets, 0, null);
    expect(out).toBe(sets);
    expect(loads(out)).toEqual([100, 100, 100]);
  });

  it("treats a null previous value as a valid anchor", () => {
    // Bodyweight-seeded exercise the athlete starts loading: the followers hold
    // null, agree with the old value, and follow.
    const sets = [
      mkSet({ set_index: 0, kg: null }),
      mkSet({ set_index: 1, kg: null }),
      mkSet({ set_index: 2, kg: null }),
    ];
    expect(loads(propagateLoad(sets, 0, 20))).toEqual([20, 20, 20]);
  });

  it("writes only the edited set when it is the last one", () => {
    const sets = [mkSet({ set_index: 0, committed_at: COMMITTED }), mkSet({ set_index: 1 })];
    expect(loads(propagateLoad(sets, 1, 110))).toEqual([100, 110]);
  });

  it("leaves untouched sets object-identical so the card's memo survives", () => {
    const sets = [
      mkSet({ set_index: 0 }),
      mkSet({ set_index: 1 }),
      mkSet({ set_index: 2, kg: 90 }),
      mkSet({ set_index: 3 }),
    ];
    const out = propagateLoad(sets, 0, 110);
    expect(out[0]).not.toBe(sets[0]);
    expect(out[1]).not.toBe(sets[1]);
    expect(out[2]).toBe(sets[2]); // diverged: the chain stopped before it
    expect(out[3]).toBe(sets[3]); // below the stop
  });

  it("carries no non-kg field across — only the load propagates", () => {
    // Reps and RIR genuinely vary set to set under double progression, and RIR
    // is an observation rather than a plan. Neither may ride along.
    const sets = [
      mkSet({ set_index: 0, reps: 8, rir: 1 }),
      mkSet({ set_index: 1, reps: 6, rir: 3 }),
    ];
    const out = propagateLoad(sets, 0, 110);
    expect(out[1].reps).toBe(6);
    expect(out[1].rir).toBe(3);
    expect(out[1].kg).toBe(110);
  });

  it("returns the input unchanged for an out-of-range index", () => {
    const sets = [mkSet()];
    expect(propagateLoad(sets, 5, 110)).toBe(sets);
    expect(propagateLoad([], 0, 110)).toEqual([]);
  });
});
