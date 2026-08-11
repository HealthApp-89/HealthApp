import { describe, it, expect } from "vitest";
import type { LoggerDraft, ExerciseSetDraft } from "@/lib/logger/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import {
  groupsOf,
  groupOfIndex,
  nextRound,
  roundFromLead,
  persistedGroupTags,
  stripOrphanTags,
} from "@/lib/logger/superset-groups";

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

// What reaches exercises.superset_group. The three one-tap paths that produce a
// tag-carrying exercise performed ALONE (remove the partner, ungroup one side,
// reorder something between the pair) must persist NULL — a non-null value tells
// every future consumer that the row's timing is split/inflated/derived, and for
// a solo round none of that is true.
describe("persistedGroupTags", () => {
  it("tags both members of a real pair", () => {
    expect(persistedGroupTags(mkDraft(ARMS).exercises)).toEqual(["A", "A", "B", "B", null]);
  });

  it("persists null for an orphan whose partner was removed", () => {
    const ex = mkDraft([["Arnold Press", "A", 3, 0], ["Rear Delt Fly", null, 3, 0]]).exercises;
    expect(persistedGroupTags(ex)).toEqual([null, null]);
  });

  it("persists null for both halves of a pair a reorder has separated", () => {
    const ex = mkDraft([
      ["Arnold Press", "A", 3, 0],
      ["Rear Delt Fly", null, 3, 0],
      ["Bicep Curl", "A", 3, 0],
    ]).exercises;
    expect(persistedGroupTags(ex)).toEqual([null, null, null]);
  });

  it("persists null for an untagged exercise", () => {
    expect(persistedGroupTags(mkDraft([["Rear Delt Fly", null, 3, 0]]).exercises)).toEqual([null]);
  });

  it("tags all three members of a run of three", () => {
    const ex = mkDraft([["A1", "A", 3, 0], ["A2", "A", 3, 0], ["A3", "A", 3, 0]]).exercises;
    expect(persistedGroupTags(ex)).toEqual(["A", "A", "A"]);
  });

  it("is index-aligned with the exercise list", () => {
    const ex = mkDraft(ARMS).exercises;
    expect(persistedGroupTags(ex)).toHaveLength(ex.length);
    expect(persistedGroupTags([])).toEqual([]);
  });
});

describe("stripOrphanTags", () => {
  it("drops the tag from a survivor whose partner is gone", () => {
    const ex = mkDraft([["Arnold Press", "A", 3, 0], ["Rear Delt Fly", null, 3, 0]]).exercises;
    const next = stripOrphanTags(ex);
    expect(next[0].prescribed.superset).toBeUndefined();
    expect(groupsOf(next)).toEqual([{ tag: null, indices: [0] }, { tag: null, indices: [1] }]);
  });

  it("drops the tag from both halves of a pair a reorder has separated", () => {
    const ex = mkDraft([
      ["Arnold Press", "A", 3, 0],
      ["Rear Delt Fly", null, 3, 0],
      ["Bicep Curl", "A", 3, 0],
    ]).exercises;
    const next = stripOrphanTags(ex);
    expect(next.map((e) => e.prescribed.superset)).toEqual([undefined, undefined, undefined]);
  });

  it("leaves a real pair alone and returns the SAME array (memo identity)", () => {
    const ex = mkDraft(ARMS).exercises;
    const next = stripOrphanTags(ex);
    expect(next).toBe(ex);
  });

  it("keeps untouched exercises reference-equal", () => {
    const ex = mkDraft([["Arnold Press", "A", 3, 0], ["Rear Delt Fly", null, 3, 0]]).exercises;
    const next = stripOrphanTags(ex);
    expect(next[1]).toBe(ex[1]);
    expect(next[0]).not.toBe(ex[0]);
  });
});

describe("groupOfIndex", () => {
  it("returns the group containing the index", () => {
    const ex = mkDraft(ARMS).exercises;
    expect(groupOfIndex(ex, 1)).toEqual({ tag: "A", indices: [0, 1] });
    expect(groupOfIndex(ex, 4)).toEqual({ tag: null, indices: [4] });
  });
});

// THE member-resolution rule, shared by the dock's START (via nextRound, which
// scans for its own lead) and LoggerSheet's row-level "Start this set" (which
// is handed one). The nextRound cases below are unchanged and are the proof
// that routing them through this function preserved their behaviour.
describe("roundFromLead", () => {
  it("returns one set per member for a fresh pair, from either member as lead", () => {
    const ex = mkDraft(ARMS).exercises;
    const round = [{ exerciseIndex: 0, setIndex: 0 }, { exerciseIndex: 1, setIndex: 0 }];
    expect(roundFromLead(ex, { exerciseIndex: 0, setIndex: 0 }, [])).toEqual(round);
    // Leading with the SECOND member still returns the pair in GROUP order —
    // the round is performed Arnold-then-curl however the athlete taps it.
    expect(roundFromLead(ex, { exerciseIndex: 1, setIndex: 0 }, [])).toEqual(round);
  });

  it("honours a lead that is not the group's first uncommitted set", () => {
    // Only the dock scans for a lead; a row-level tap names one, and the round
    // must be built around THAT set rather than silently re-scanning to set 0.
    const ex = mkDraft([["Arnold Press", "A", 3, 0], ["Bicep Curl", "A", 3, 0]]).exercises;
    expect(roundFromLead(ex, { exerciseIndex: 0, setIndex: 2 }, [])).toEqual([
      { exerciseIndex: 0, setIndex: 2 },
      { exerciseIndex: 1, setIndex: 0 },
    ]);
  });

  it("skips a partner whose entry row is still open and takes its next set", () => {
    // The case LoggerSheet's roundForSet exists for: round 1 was stopped, the
    // athlete saved Arnold's zoom but not the curl's, then tapped START on
    // Arnold's set 2. The curl's set 0 is uncommitted but already performed.
    const ex = mkDraft([["Arnold Press", "A", 3, 1], ["Bicep Curl", "A", 3, 0]]).exercises;
    const skip = [{ exerciseIndex: 1, setIndex: 0 }];
    expect(roundFromLead(ex, { exerciseIndex: 0, setIndex: 1 }, skip)).toEqual([
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
    ]);
  });

  it("omits a partner with nothing left but a pending set, ending the round solo", () => {
    const ex = mkDraft([["Arnold Press", "A", 3, 1], ["Bicep Curl", "A", 1, 0]]).exercises;
    const skip = [{ exerciseIndex: 1, setIndex: 0 }];
    expect(roundFromLead(ex, { exerciseIndex: 0, setIndex: 1 }, skip)).toEqual([
      { exerciseIndex: 0, setIndex: 1 },
    ]);
  });

  it("omits an exhausted partner in an unequal pair", () => {
    const ex = mkDraft([["Arnold Press", "A", 3, 2], ["Bicep Curl", "A", 2, 2]]).exercises;
    expect(roundFromLead(ex, { exerciseIndex: 0, setIndex: 2 }, [])).toEqual([
      { exerciseIndex: 0, setIndex: 2 },
    ]);
  });

  it("returns just the lead for a solo exercise", () => {
    const ex = mkDraft(ARMS).exercises;
    expect(roundFromLead(ex, { exerciseIndex: 4, setIndex: 1 }, [])).toEqual([
      { exerciseIndex: 4, setIndex: 1 },
    ]);
  });

  it("returns just the lead when a reorder has separated a tagged pair", () => {
    const ex = mkDraft([
      ["Arnold Press", "A", 3, 0],
      ["Rear Delt Fly", null, 3, 0],
      ["Bicep Curl", "A", 3, 0],
    ]).exercises;
    expect(roundFromLead(ex, { exerciseIndex: 0, setIndex: 0 }, [])).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
    ]);
  });

  it("resolves all three members of a run of three", () => {
    const ex = mkDraft([["A1", "A", 3, 1], ["A2", "A", 3, 1], ["A3", "A", 3, 1]]).exercises;
    expect(roundFromLead(ex, { exerciseIndex: 1, setIndex: 1 }, [])).toEqual([
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
      { exerciseIndex: 2, setIndex: 1 },
    ]);
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
