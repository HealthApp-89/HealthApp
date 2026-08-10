import { describe, it, expect } from "vitest";
import { evaluateSet } from "@/lib/coach/live-session";
import { ruleRestDiscipline } from "@/lib/coach/live-session/rule-rest-discipline";
import type { LiveSetInput } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft } from "@/lib/logger/types";

const SQUAT = "Squat (Barbell)";

function at(iso: string): string {
  return iso;
}

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 100,
    reps: 5,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: at("2026-08-10T09:00:00.000Z"),
    ...over,
  };
}

function mkInput(args: {
  sets: ExerciseSetDraft[];
  current: ExerciseSetDraft;
  best?: number | null;
  baseReps?: number;
}): LiveSetInput {
  return {
    set: args.current,
    exercise: {
      name: SQUAT,
      position: 0,
      prescribed: {
        name: SQUAT,
        baseKg: 100,
        baseReps: args.baseReps ?? 5,
        sets: 3,
        increment: { step: 5 },
      },
      sets: args.sets,
    },
    sessionSets: args.sets.map((s) => ({ exerciseName: SQUAT, set: s })),
    context: {
      historyByExercise: {},
      bestByExercise: { [SQUAT]: args.best === undefined ? null : args.best },
      blockPhase: "pre_target",
      rirTarget: 2,
    },
  };
}

describe("ruleRestDiscipline", () => {
  it("fires when rest before a tier-1 set was under 60 percent of prescribed", () => {
    // Squat at 5 reps -> restPrescription(tier 1, 5) = { min: 180 }. 60% = 108s.
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:00:55.000Z") });
    const line = ruleRestDiscipline(mkInput({ sets: [s0, s1], current: s1 }));
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("guardrail");
    expect(line!.text).toContain("55s");
  });

  it("stays silent when rest was adequate", () => {
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:03:30.000Z") });
    expect(ruleRestDiscipline(mkInput({ sets: [s0, s1], current: s1 }))).toBeNull();
  });

  it("stays silent on the first set — there is no prior rest to judge", () => {
    const s0 = mkSet({ set_index: 0 });
    expect(ruleRestDiscipline(mkInput({ sets: [s0], current: s0 }))).toBeNull();
  });

  it("fires at most once per exercise", () => {
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:00:50.000Z") });
    const s2 = mkSet({ set_index: 2, committed_at: at("2026-08-10T09:01:40.000Z") });
    expect(ruleRestDiscipline(mkInput({ sets: [s0, s1, s2], current: s1 }))).not.toBeNull();
    expect(ruleRestDiscipline(mkInput({ sets: [s0, s1, s2], current: s2 }))).toBeNull();
  });

  it("does not police rest on isolation work", () => {
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:00:20.000Z") });
    const input = mkInput({ sets: [s0, s1], current: s1 });
    input.exercise.name = "Lateral Raise (Dumbbell)";
    input.exercise.prescribed.name = "Lateral Raise (Dumbbell)";
    expect(ruleRestDiscipline(input)).toBeNull();
  });

  it("does not fire on a short warmup-to-first-working-set transition", () => {
    // A 10s warmup->work gap is normal ramp-up, not under-rest — there is no
    // prior WORKING set yet for the first working set to be judged against.
    const w0 = mkSet({ set_index: 0, warmup: true, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, warmup: false, committed_at: at("2026-08-10T09:00:10.000Z") });
    expect(ruleRestDiscipline(mkInput({ sets: [w0, s1], current: s1 }))).toBeNull();
  });

  it("still fires on a genuine short gap between two WORKING sets, even when a short warmup-to-work gap preceded them", () => {
    // The warmup->s1 gap (10s) would have false-tripped the old (unfixed)
    // implementation and, via the once-per-exercise gate, permanently
    // suppressed the rule for the rest of the exercise. It must not: s1 has
    // no prior working set (silent), and s2's genuinely short 50s gap after
    // s1 must still fire.
    const w0 = mkSet({ set_index: 0, warmup: true, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, warmup: false, committed_at: at("2026-08-10T09:00:10.000Z") });
    const s2 = mkSet({ set_index: 2, warmup: false, committed_at: at("2026-08-10T09:01:00.000Z") });
    const line = ruleRestDiscipline(mkInput({ sets: [w0, s1, s2], current: s2 }));
    expect(line).not.toBeNull();
    expect(line!.rule).toBe("rest_discipline");
    expect(line!.text).toContain("50s");
  });
});

describe("evaluateSet — priority", () => {
  it("returns the PR line even when the load call would also fire", () => {
    // 100x5 with RIR 4 is both a PR (best 105) and a too-easy load call.
    const s0 = mkSet({ set_index: 0, rir: 4, committed_at: at("2026-08-10T09:00:00.000Z") });
    const line = evaluateSet(mkInput({ sets: [s0], current: s0, best: 105 }));
    expect(line).not.toBeNull();
    expect(line!.rule).toBe("pr");
    expect(line!.cue).toBe(true);
  });

  it("prefers the failure guardrail over the load call", () => {
    const s0 = mkSet({ set_index: 0, rir: 0, failure: true });
    const s1 = mkSet({ set_index: 1, rir: 0, failure: true, reps: 3 });
    const line = evaluateSet(mkInput({ sets: [s0, s1], current: s1 }));
    expect(line!.rule).toBe("failure_budget");
  });

  it("falls through to the load call when no guardrail fires", () => {
    const s0 = mkSet({ set_index: 0, rir: 4 });
    const line = evaluateSet(mkInput({ sets: [s0], current: s0 }));
    expect(line!.rule).toBe("load_call");
  });

  it("returns null for a set that went exactly to plan", () => {
    const s0 = mkSet({ set_index: 0, reps: 5, rir: 2 });
    expect(evaluateSet(mkInput({ sets: [s0], current: s0 }))).toBeNull();
  });

  it("never throws — a rule bug must not block a set commit", () => {
    const s0 = mkSet({ set_index: 0 });
    const broken = mkInput({ sets: [s0], current: s0 });
    // @ts-expect-error deliberately corrupting the context to simulate a bug
    broken.context = null;
    expect(() => evaluateSet(broken)).not.toThrow();
    expect(evaluateSet(broken)).toBeNull();
  });

  it("returns the PR line over the failure-budget guardrail when a set is BOTH a PR and the 2nd failure set", () => {
    // s0: first set taken to failure (count 1, doesn't fire on its own).
    // s1: also taken to failure (count 2 -> failure_budget would fire) AND
    // its e1RM (105x5 ~= 118.1) clears the best of 115 within the plausible
    // jump ceiling -> rulePr would also fire. PR must win: it is earlier in
    // RULES.
    const s0 = mkSet({
      set_index: 0,
      kg: 100,
      reps: 5,
      rir: 0,
      failure: true,
      committed_at: at("2026-08-10T09:00:00.000Z"),
    });
    const s1 = mkSet({
      set_index: 1,
      kg: 105,
      reps: 5,
      rir: 0,
      failure: true,
      committed_at: at("2026-08-10T09:05:00.000Z"),
    });
    const line = evaluateSet(mkInput({ sets: [s0, s1], current: s1, best: 115 }));
    expect(line).not.toBeNull();
    expect(line!.rule).toBe("pr");
  });

  it("returns the drop-off guardrail over the load call when reps have collapsed on the third set", () => {
    // Three committed working sets at the same load; reps fall from 5 to 2 on
    // the third (2 < 0.75 * bestReps(5) = 3.75) -> ruleDropOff should fire.
    // The same set is also a valid (strained, short-by-3) load call target,
    // so this is the only fixture in the suite where drop-off's priority over
    // load_call is actually exercised.
    const s0 = mkSet({ set_index: 0, kg: 100, reps: 5, rir: 2, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, kg: 100, reps: 5, rir: 2, committed_at: at("2026-08-10T09:03:00.000Z") });
    const s2 = mkSet({ set_index: 2, kg: 100, reps: 2, rir: 1, committed_at: at("2026-08-10T09:06:00.000Z") });
    const line = evaluateSet(mkInput({ sets: [s0, s1, s2], current: s2 }));
    expect(line).not.toBeNull();
    expect(line!.rule).toBe("drop_off");
  });
});
