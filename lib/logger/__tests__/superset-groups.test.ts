import { describe, it, expect } from "vitest";
import type { LoggerDraft, ExerciseSetDraft } from "@/lib/logger/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { groupsOf, groupOfIndex, nextRound } from "@/lib/logger/superset-groups";

const NOW = "2026-08-11T09:00:00.000Z";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0, kg: 20, reps: 15, duration_seconds: null,
    warmup: false, failure: false, rir: 2, committed_at: null, ...over,
  };
}

/** `spec` is [name, superset tag or null, number of sets, number committed]. */
function mkDraft(spec: [string, string | null, number, number][]): LoggerDraft {
  return {
    user_id: "u1", session_type: "Arms", date: "2026-08-11",
    started_at: NOW, updated_at: NOW, paused_at: null, paused_ms_total: 0,
    external_id: "logger-test", resolved_plan: [], timer: null,
    exercises: spec.map(([name, tag, sets, committed], i) => {
      const prescribed: PlannedExercise = { name, sets, baseReps: 15, baseKg: 20 };
      if (tag) prescribed.superset = tag;
      return {
        name, position: i, prescribed,
        sets: Array.from({ length: sets }, (_u, j) =>
          mkSet({ set_index: j, committed_at: j < committed ? NOW : null }),
        ),
      };
    }),
  };
}

const ARMS: [string, string | null, number, number][] = [
  ["Arnold Press", "A", 3, 0],
  ["Bicep Curl", "A", 3, 0],
  ["Front Raise", "B", 3, 0],
  ["Hammer Curl", "B", 3, 0],
  ["Rear Delt Fly", null, 3, 0],
];

describe("groupsOf", () => {
  it("pairs adjacent exercises sharing a tag and leaves untagged ones solo", () => {
    expect(groupsOf(mkDraft(ARMS).exercises)).toEqual([
      { tag: "A", indices: [0, 1] },
      { tag: "B", indices: [2, 3] },
      { tag: null, indices: [4] },
    ]);
  });

  it("dissolves a pair that a reorder has separated", () => {
    const groups = groupsOf(mkDraft([
      ["Arnold Press", "A", 3, 0],
      ["Rear Delt Fly", null, 3, 0],
      ["Bicep Curl", "A", 3, 0],
    ]).exercises);
    expect(groups).toEqual([
      { tag: "A", indices: [0] },
      { tag: null, indices: [1] },
      { tag: "A", indices: [2] },
    ]);
  });

  it("groups a run of three", () => {
    const groups = groupsOf(mkDraft([
      ["A1", "A", 3, 0], ["A2", "A", 3, 0], ["A3", "A", 3, 0],
    ]).exercises);
    expect(groups).toEqual([{ tag: "A", indices: [0, 1, 2] }]);
  });

  it("returns nothing for an empty session", () => {
    expect(groupsOf([])).toEqual([]);
  });
});

describe("groupOfIndex", () => {
  it("returns the group containing the index", () => {
    const ex = mkDraft(ARMS).exercises;
    expect(groupOfIndex(ex, 1)).toEqual({ tag: "A", indices: [0, 1] });
    expect(groupOfIndex(ex, 4)).toEqual({ tag: null, indices: [4] });
  });
});

describe("nextRound", () => {
  it("returns one set per member for a fresh pair", () => {
    expect(nextRound(mkDraft(ARMS), [])).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
      { exerciseIndex: 1, setIndex: 0 },
    ]);
  });

  it("advances both members once the first round is committed", () => {
    const d = mkDraft([["Arnold Press", "A", 3, 1], ["Bicep Curl", "A", 3, 1], ["Rear Delt Fly", null, 3, 0]]);
    expect(nextRound(d, [])).toEqual([
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
    ]);
  });

  it("drops a member that has no uncommitted set left", () => {
    // Arnold has 3 sets all done except the last; the curl is finished.
    const d = mkDraft([["Arnold Press", "A", 3, 2], ["Bicep Curl", "A", 2, 2]]);
    expect(nextRound(d, [])).toEqual([{ exerciseIndex: 0, setIndex: 2 }]);
  });

  it("skips refs whose entry row is still open, and moves on to the next group", () => {
    const d = mkDraft([["Arnold Press", "A", 1, 0], ["Bicep Curl", "A", 1, 0], ["Rear Delt Fly", null, 2, 0]]);
    const skip = [{ exerciseIndex: 0, setIndex: 0 }, { exerciseIndex: 1, setIndex: 0 }];
    expect(nextRound(d, skip)).toEqual([{ exerciseIndex: 2, setIndex: 0 }]);
  });

  it("returns an empty round when every set is committed", () => {
    expect(nextRound(mkDraft([["Arnold Press", "A", 2, 2], ["Bicep Curl", "A", 2, 2]]), [])).toEqual([]);
  });

  it("returns a single-set round for a solo exercise", () => {
    expect(nextRound(mkDraft([["Rear Delt Fly", null, 3, 1]]), [])).toEqual([
      { exerciseIndex: 0, setIndex: 1 },
    ]);
  });
});
