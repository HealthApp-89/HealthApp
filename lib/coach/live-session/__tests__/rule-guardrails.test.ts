import { describe, it, expect } from "vitest";
import { ruleFailureBudget } from "@/lib/coach/live-session/rule-failure-budget";
import { ruleDropOff } from "@/lib/coach/live-session/rule-drop-off";
import { ruleRestDiscipline } from "@/lib/coach/live-session/rule-rest-discipline";
import type { LiveSetInput, SessionSetRef } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft, ExerciseDraft } from "@/lib/logger/types";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 60,
    reps: 10,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

/** Squat is tier 1 (compound); Lateral Raise is tier 3 (isolation). */
function mkInput(args: {
  name: string;
  sets: ExerciseSetDraft[];
  current: ExerciseSetDraft;
  sessionSets?: SessionSetRef[];
}): LiveSetInput {
  const exercise: ExerciseDraft = {
    name: args.name,
    position: 0,
    prescribed: { name: args.name, baseKg: 60, baseReps: 10, sets: 3, increment: { step: 2.5 } },
    sets: args.sets,
  };
  return {
    set: args.current,
    exercise,
    sessionSets:
      args.sessionSets ?? args.sets.map((s) => ({ exerciseName: args.name, set: s })),
    context: {
      historyByExercise: {},
      bestByExercise: {},
      blockPhase: "pre_target",
      rirTarget: 2,
    },
  };
}

describe("ruleFailureBudget", () => {
  it("stays silent on the first set taken to failure", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({ name: "Squat (Barbell)", sets: [s0], current: s0 }),
    );
    expect(line).toBeNull();
  });

  it("fires on the second failure set of the session", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const s1 = mkSet({ set_index: 1, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 }),
    );
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("guardrail");
    expect(line!.text).toContain("2nd");
    expect(line!.cue).toBe(false);
  });

  it("counts failures across DIFFERENT exercises — the budget is session-wide", () => {
    const squat = mkSet({ set_index: 0, failure: true, rir: 0 });
    const press = mkSet({ set_index: 0, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({
        name: "Overhead Press (Barbell)",
        sets: [press],
        current: press,
        sessionSets: [
          { exerciseName: "Squat (Barbell)", set: squat },
          { exerciseName: "Overhead Press (Barbell)", set: press },
        ],
      }),
    );
    expect(line).not.toBeNull();
  });

  it("treats RIR 0 as failure even without the failure flag", () => {
    const s0 = mkSet({ set_index: 0, rir: 0 });
    const s1 = mkSet({ set_index: 1, rir: 0 });
    expect(
      ruleFailureBudget(mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 })),
    ).not.toBeNull();
  });

  it("allows failure on the last set of isolation work — that is the point of it", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const s1 = mkSet({ set_index: 1, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({ name: "Lateral Raise (Dumbbell)", sets: [s0, s1], current: s1 }),
    );
    expect(line).toBeNull();
  });

  it("stays silent on a set that was not taken to failure", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const s1 = mkSet({ set_index: 1, rir: 3 });
    expect(
      ruleFailureBudget(mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 })),
    ).toBeNull();
  });

  it("fires on a mid-exercise failure set of isolation work — exemption is final set only", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const s1 = mkSet({ set_index: 1, failure: true, rir: 0 });
    const s2 = mkSet({ set_index: 2, rir: 2 });
    const line = ruleFailureBudget(
      mkInput({ name: "Lateral Raise (Dumbbell)", sets: [s0, s1, s2], current: s1 }),
    );
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("guardrail");
    expect(line!.text).toContain("2nd");
  });

  it("ignores failure sets that are warmups — they do not count toward the budget", () => {
    const w0 = mkSet({ set_index: 0, warmup: true, failure: true, rir: 0 });
    const s0 = mkSet({ set_index: 1, warmup: false, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({ name: "Squat (Barbell)", sets: [w0, s0], current: s0 }),
    );
    expect(line).toBeNull();
  });
});

describe("ruleDropOff", () => {
  it("stays silent with fewer than three working sets", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 6 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 })),
    ).toBeNull();
  });

  it("fires when reps collapse below 75 percent of the best set at the same load", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 9 });
    const s2 = mkSet({ set_index: 2, reps: 7 });
    const line = ruleDropOff(
      mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2], current: s2 }),
    );
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("guardrail");
    expect(line!.text).toContain("12");
    expect(line!.text).toContain("7");
  });

  it("stays silent when reps hold up", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 11 });
    const s2 = mkSet({ set_index: 2, reps: 10 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2], current: s2 })),
    ).toBeNull();
  });

  it("ignores earlier sets performed at a LIGHTER load", () => {
    // A 12-rep set at 40kg must not make a 7-rep set at 80kg look like a
    // collapse — they are different efforts.
    const s0 = mkSet({ set_index: 0, kg: 40, reps: 12 });
    const s1 = mkSet({ set_index: 1, kg: 80, reps: 8 });
    const s2 = mkSet({ set_index: 2, kg: 80, reps: 7 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2], current: s2 })),
    ).toBeNull();
  });

  it("excludes warmups from the comparison", () => {
    const w = mkSet({ set_index: 0, kg: 60, reps: 20, warmup: true });
    const s1 = mkSet({ set_index: 1, reps: 10 });
    const s2 = mkSet({ set_index: 2, reps: 9 });
    const s3 = mkSet({ set_index: 3, reps: 8 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [w, s1, s2, s3], current: s3 })),
    ).toBeNull();
  });

  // ── scope: tier 1-2 only ────────────────────────────────────────────────
  //
  // On isolation work a fixed load taken to a fixed RIR is SUPPOSED to bleed
  // reps set over set. Firing there flagged a textbook accessory AND, because
  // drop-off outranks the load call, swallowed the useful verdict.

  it("stays silent on isolation work — rep decay there is the prescription working", () => {
    // Lateral Raise (tier 3), baseReps 15, fixed load to RIR 2: 15/13/11/10.
    // Set 3 is 11 < 15 x 0.75 = 11.25, so the ungated rule would fire here.
    const s0 = mkSet({ set_index: 0, reps: 15 });
    const s1 = mkSet({ set_index: 1, reps: 13 });
    const s2 = mkSet({ set_index: 2, reps: 11 });
    const s3 = mkSet({ set_index: 3, reps: 10 });
    expect(
      ruleDropOff(mkInput({ name: "Lateral Raise (Dumbbell)", sets: [s0, s1, s2], current: s2 })),
    ).toBeNull();
    expect(
      ruleDropOff(mkInput({ name: "Lateral Raise (Dumbbell)", sets: [s0, s1, s2, s3], current: s3 })),
    ).toBeNull();
  });

  it("still fires on a tier-2 secondary compound", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 9 });
    const s2 = mkSet({ set_index: 2, reps: 7 });
    expect(
      ruleDropOff(mkInput({ name: "Romanian Deadlift (Barbell)", sets: [s0, s1, s2], current: s2 })),
    ).not.toBeNull();
  });

  // ── scope: once per exercise ────────────────────────────────────────────

  it("does not re-fire on a fourth set once it has already flagged", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 9 });
    const s2 = mkSet({ set_index: 2, reps: 7 }); // fires
    const s3 = mkSet({ set_index: 3, reps: 6 }); // condition still true — must be silent
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2], current: s2 })),
    ).not.toBeNull();
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2, s3], current: s3 })),
    ).toBeNull();
  });

  it("does not re-fire on a fifth set either", () => {
    const sets = [
      mkSet({ set_index: 0, reps: 12 }),
      mkSet({ set_index: 1, reps: 9 }),
      mkSet({ set_index: 2, reps: 7 }),
      mkSet({ set_index: 3, reps: 6 }),
      mkSet({ set_index: 4, reps: 5 }),
    ];
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets, current: sets[4] })),
    ).toBeNull();
  });

  it("fires on the first qualifying set even when an EARLIER set held up fine", () => {
    // Only a set that would itself have fired suppresses later ones.
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 11 }); // holds up — no fire
    const s2 = mkSet({ set_index: 2, reps: 10 }); // holds up (10 >= 9) — no fire
    const s3 = mkSet({ set_index: 3, reps: 8 });  // 8 < 9 — first fire
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2, s3], current: s3 })),
    ).not.toBeNull();
  });
});

describe("ruleRestDiscipline — supersets", () => {
  const s1 = mkSet({
    set_index: 0,
    started_at: "2026-08-10T09:00:00.000Z",
    work_seconds: 40,
    committed_at: "2026-08-10T09:00:45.000Z",
  });
  const s2 = mkSet({
    set_index: 1,
    started_at: "2026-08-10T09:01:30.000Z",
    work_seconds: 38,
    committed_at: "2026-08-10T09:02:15.000Z",
  });

  it("fires on a 50s gap for a solo tier-1 lift", () => {
    const input = mkInput({ name: "Squat", sets: [s1, s2], current: s2 });
    expect(ruleRestDiscipline(input)).not.toBeNull();
  });

  it("stays silent when the same lift is performed in a superset", () => {
    const input = mkInput({ name: "Squat", sets: [s1, s2], current: s2 });
    const grouped = {
      ...input,
      exercise: {
        ...input.exercise,
        prescribed: { ...input.exercise.prescribed, superset: "A" },
      },
    };
    expect(ruleRestDiscipline(grouped)).toBeNull();
  });
});
