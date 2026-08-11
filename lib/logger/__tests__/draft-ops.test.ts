// Characterisation tests for the draft-level helpers extracted out of
// LoggerSheet.tsx. They were unreachable by vitest while they lived in a .tsx
// (node environment, `lib/**/__tests__` glob only) and one of them shipped a
// bug during that time — commitPendingEntry's time-based fallback.

import { describe, it, expect } from "vitest";
import type { LoggerDraft, ExerciseSetDraft } from "@/lib/logger/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import {
  timerOf,
  withTimer,
  commitPendingEntry,
  commitPendingEntries,
  firstPendingSet,
  annotatedRestFor,
  transitionRestFor,
  transitionAfterRound,
} from "@/lib/logger/draft-ops";
import { IDLE_TIMER, type TimerState } from "@/lib/logger/set-timer";

const NOW = "2026-08-11T09:00:00.000Z";
const REF_0_0 = { exerciseIndex: 0, setIndex: 0 };

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0, kg: 80, reps: 10, duration_seconds: null,
    warmup: false, failure: false, rir: 2, committed_at: null,
    ...over,
  };
}

function mkDraft(
  exercises: { name: string; prescribed?: Partial<PlannedExercise>; sets: ExerciseSetDraft[] }[],
  timer: TimerState | null = null,
): LoggerDraft {
  return {
    user_id: "u1", session_type: "Legs", date: "2026-08-11",
    started_at: NOW, updated_at: NOW, paused_at: null, paused_ms_total: 0,
    external_id: "logger-test", resolved_plan: [],
    timer,
    exercises: exercises.map((e, i) => ({
      name: e.name,
      position: i,
      prescribed: { name: e.name, sets: e.sets.length, ...e.prescribed } as PlannedExercise,
      sets: e.sets.map((s, si) => ({ ...s, set_index: si })),
    })),
  };
}

const restingOn = (exerciseIndex: number, setIndex: number, workSeconds = 33): TimerState => ({
  phase: "rest",
  anchorMs: 1_700_000_000_000,
  activeSets: [{ exerciseIndex, setIndex }],
  restSeconds: 175,
  pendingEntries: [{ exerciseIndex, setIndex, workSeconds }],
});

/** A two-member round mid-rest, both entry rows still open. Not producible by
 *  the reducer until the grouping lands, but the commit helpers are pure
 *  functions of TimerState and the multi-entry path has to be pinned now. */
const restingOnPair = (): TimerState => ({
  phase: "rest",
  anchorMs: 1_700_000_000_000,
  activeSets: [{ exerciseIndex: 0, setIndex: 0 }, { exerciseIndex: 1, setIndex: 0 }],
  restSeconds: 175,
  pendingEntries: [
    { exerciseIndex: 0, setIndex: 0, workSeconds: 45 },
    { exerciseIndex: 1, setIndex: 0, workSeconds: 45 },
  ],
});

describe("timerOf", () => {
  it("falls back to idle for a draft written before timing existed", () => {
    expect(timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], null))).toBe(IDLE_TIMER);
    expect(timerOf(null)).toBe(IDLE_TIMER);
  });

  it("hands back a round-shaped timer untouched, same reference", () => {
    // Identity matters: LoggerSheet passes this object straight into the
    // memoized ExerciseCards, so re-wrapping it would defeat the memo.
    const t = restingOn(0, 0);
    expect(timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], t))).toBe(t);
    expect(timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], IDLE_TIMER))).toBe(IDLE_TIMER);
  });

  // A draft written by the build BEFORE the round refactor is still sitting in
  // IndexedDB for up to 12h after the deploy. Reading `.length` off its absent
  // `activeSets` would throw and crash the logger on resume.
  it("normalises a legacy mid-set timer into a one-member round", () => {
    const legacy = {
      phase: "running",
      anchorMs: 1_700_000_000_000,
      activeSet: { exerciseIndex: 1, setIndex: 2 },
      restSeconds: 0,
      pendingEntry: null,
    } as unknown as TimerState;
    expect(timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], legacy))).toEqual({
      phase: "running",
      anchorMs: 1_700_000_000_000,
      activeSets: [{ exerciseIndex: 1, setIndex: 2 }],
      restSeconds: 0,
      pendingEntries: [],
    });
  });

  it("normalises a legacy open entry row into a one-member pendingEntries", () => {
    const legacy = {
      phase: "rest",
      anchorMs: 1_700_000_000_000,
      activeSet: { exerciseIndex: 0, setIndex: 0 },
      restSeconds: 175,
      pendingEntry: { exerciseIndex: 0, setIndex: 0, workSeconds: 33 },
    } as unknown as TimerState;
    const out = timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], legacy));
    expect(out.activeSets).toEqual([{ exerciseIndex: 0, setIndex: 0 }]);
    expect(out.pendingEntries).toEqual([{ exerciseIndex: 0, setIndex: 0, workSeconds: 33 }]);
    expect(out.phase).toBe("rest");
    expect(out.restSeconds).toBe(175);
  });

  it("falls back to idle for a timer matching neither shape", () => {
    // Not worth guessing at: losing it costs at most the set in flight, and a
    // half-understood timer stamps work_seconds onto the wrong row.
    const junk = { phase: "sprinting", activeSet: null } as unknown as TimerState;
    expect(timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], junk))).toBe(IDLE_TIMER);
    expect(timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], {} as unknown as TimerState)))
      .toBe(IDLE_TIMER);
  });
});

describe("legacy timer shape reaching the commit helpers", () => {
  const legacyResting = () => ({
    phase: "rest",
    anchorMs: 1_700_000_000_000,
    activeSet: { exerciseIndex: 0, setIndex: 0 },
    restSeconds: 175,
    pendingEntry: { exerciseIndex: 0, setIndex: 0, workSeconds: 33 },
  } as unknown as TimerState);

  it("commitPendingEntries flushes a legacy open row instead of throwing", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }], legacyResting());
    const out = commitPendingEntries(d, NOW);
    expect(out.exercises[0].sets[0].committed_at).toBe(NOW);
    expect(out.timer!.pendingEntries).toEqual([]);
  });

  it("commitPendingEntry flushes a legacy open row instead of throwing", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }], legacyResting());
    const out = commitPendingEntry(d, REF_0_0, NOW);
    expect(out.exercises[0].sets[0].committed_at).toBe(NOW);
    expect(out.timer!.pendingEntries).toEqual([]);
  });
});

describe("withTimer", () => {
  it("stamps updated_at from the caller's clock, never its own", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }]);
    const out = withTimer(d, IDLE_TIMER, "2026-01-02T03:04:05.000Z");
    expect(out.updated_at).toBe("2026-01-02T03:04:05.000Z");
    expect(out.timer).toBe(IDLE_TIMER);
    expect(out.exercises).toBe(d.exercises);
  });
});

describe("commitPendingEntry", () => {
  it("commits the pending set and clears the entry without touching the rest clock", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet(), mkSet()] }], restingOn(0, 0));
    const out = commitPendingEntry(d, REF_0_0, NOW);
    expect(out.exercises[0].sets[0].committed_at).toBe(NOW);
    expect(out.exercises[0].sets[1].committed_at).toBeNull();
    expect(out.timer!.pendingEntries).toEqual([]);
    // The whole point of splitting commit out of stop.
    expect(out.timer!.phase).toBe("rest");
    expect(out.timer!.anchorMs).toBe(d.timer!.anchorMs);
    expect(out.timer!.restSeconds).toBe(175);
  });

  it("is a no-op when nothing is pending", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }], IDLE_TIMER);
    expect(commitPendingEntry(d, REF_0_0, NOW)).toBe(d);
  });

  it("never re-stamps an already-committed set", () => {
    const d = mkDraft(
      [{ name: "Squat", sets: [mkSet({ committed_at: "2020-01-01T00:00:00.000Z" })] }],
      restingOn(0, 0),
    );
    expect(commitPendingEntry(d, REF_0_0, NOW).exercises[0].sets[0].committed_at)
      .toBe("2020-01-01T00:00:00.000Z");
  });

  it("fills duration_seconds from the measured work time for a time-based set", () => {
    // The plank the timer measured at 45s must not commit as no plank at all
    // just because its seconds field was never blurred.
    const d = mkDraft(
      [{ name: "Plank", prescribed: { duration_seconds: 60 }, sets: [mkSet({ kg: null, reps: null })] }],
      restingOn(0, 0, 45),
    );
    const s = commitPendingEntry(d, REF_0_0, NOW).exercises[0].sets[0];
    expect(s.duration_seconds).toBe(45);
  });

  it("does not overwrite a duration the athlete actually typed", () => {
    const d = mkDraft(
      [{ name: "Plank", prescribed: { duration_seconds: 60 }, sets: [mkSet({ duration_seconds: 52 })] }],
      restingOn(0, 0, 45),
    );
    expect(commitPendingEntry(d, REF_0_0, NOW).exercises[0].sets[0].duration_seconds).toBe(52);
  });

  it("leaves duration_seconds null on a REP-based set", () => {
    // Load-bearing: lib/coach/derived.ts reads duration_seconds as a hold and
    // lib/coach/snapshot.ts renders it to the coach as "45s hold". A rep set
    // writing it produces a 33-second bench press.
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }], restingOn(0, 0, 33));
    expect(commitPendingEntry(d, REF_0_0, NOW).exercises[0].sets[0].duration_seconds).toBeNull();
  });

  it("commits only the named member and leaves the other's row open", () => {
    const d = mkDraft(
      [{ name: "Curl", sets: [mkSet()] }, { name: "Pushdown", sets: [mkSet()] }],
      restingOnPair(),
    );
    const out = commitPendingEntry(d, { exerciseIndex: 1, setIndex: 0 }, NOW);
    expect(out.exercises[0].sets[0].committed_at).toBeNull();
    expect(out.exercises[1].sets[0].committed_at).toBe(NOW);
    expect(out.timer!.pendingEntries).toEqual([{ exerciseIndex: 0, setIndex: 0, workSeconds: 45 }]);
    expect(out.timer!.phase).toBe("rest");
  });

  it("is a no-op for a ref that is not one of the open rows", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet(), mkSet()] }], restingOn(0, 0));
    expect(commitPendingEntry(d, { exerciseIndex: 0, setIndex: 1 }, NOW)).toBe(d);
  });
});

describe("commitPendingEntries", () => {
  it("commits every open row of a round and empties pendingEntries", () => {
    // The exit paths (START on the next round, Finish, Pause & close) may not
    // silently drop a set the athlete has already performed.
    const d = mkDraft(
      [{ name: "Curl", sets: [mkSet()] }, { name: "Pushdown", sets: [mkSet()] }],
      restingOnPair(),
    );
    const out = commitPendingEntries(d, NOW);
    expect(out.exercises[0].sets[0].committed_at).toBe(NOW);
    expect(out.exercises[1].sets[0].committed_at).toBe(NOW);
    expect(out.timer!.pendingEntries).toEqual([]);
    // Rest keeps running underneath — commit is still split out of stop.
    expect(out.timer!.phase).toBe("rest");
    expect(out.timer!.anchorMs).toBe(d.timer!.anchorMs);
    expect(out.timer!.restSeconds).toBe(175);
  });

  it("is a no-op when nothing is pending", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }], IDLE_TIMER);
    expect(commitPendingEntries(d, NOW)).toBe(d);
  });
});

describe("firstPendingSet", () => {
  it("finds the first uncommitted set in draft order", () => {
    const d = mkDraft([
      { name: "Squat", sets: [mkSet({ committed_at: NOW }), mkSet()] },
      { name: "Leg Press", sets: [mkSet()] },
    ]);
    expect(firstPendingSet(d, [])).toEqual({ exerciseIndex: 0, setIndex: 1 });
  });

  it("skips the set whose entry row is open", () => {
    // Otherwise START would offer to re-run the set just finished — and the
    // caller commits the entry first, so it would count down to a set it had
    // itself just committed.
    const d = mkDraft([
      { name: "Squat", sets: [mkSet({ committed_at: NOW }), mkSet()] },
      { name: "Leg Press", sets: [mkSet()] },
    ]);
    expect(firstPendingSet(d, [{ exerciseIndex: 0, setIndex: 1 }]))
      .toEqual({ exerciseIndex: 1, setIndex: 0 });
  });

  it("returns null once everything is committed, so the dock can disable START", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet({ committed_at: NOW })] }]);
    expect(firstPendingSet(d, [])).toBeNull();
  });
});

describe("annotatedRestFor", () => {
  it("returns a positive prescription for a known exercise", () => {
    const d = mkDraft([{ name: "Squat (Barbell)", prescribed: { baseKg: 100, baseReps: 5 }, sets: [mkSet()] }]);
    expect(annotatedRestFor(d, 0)).toBeGreaterThan(0);
  });

  it("falls back rather than throwing for an index that does not exist", () => {
    const d = mkDraft([{ name: "Squat (Barbell)", sets: [mkSet()] }]);
    expect(annotatedRestFor(d, 99)).toBe(120);
  });

  it("ignores the athlete's override — callers apply that themselves", () => {
    const d = mkDraft([{ name: "Squat (Barbell)", sets: [mkSet()] }]);
    d.exercises[0].rest_override_seconds = 30;
    expect(annotatedRestFor(d, 0)).toBe(240);
  });
});

describe("transitionRestFor", () => {
  /** Lateral Raise (tier 3 small, 60s) then Squat (tier 1, 240s), so the
   *  transition is unmistakably the INCOMING exercise's number. */
  const twoExercises = () => mkDraft([
    { name: "Lateral Raise (Dumbbell)", sets: [mkSet()] },
    { name: "Squat (Barbell)", sets: [mkSet()] },
  ]);

  it("is the incoming exercise's rest plus the setup buffer", () => {
    // Into the squat: 240 + 60. Sized by what is COMING, not by the lateral
    // raise that was just finished.
    expect(transitionRestFor(twoExercises(), 1)).toBe(300);
  });

  it("is null into an isolation — that exercise's own rest is enough", () => {
    const d = mkDraft([
      { name: "Squat (Barbell)", sets: [mkSet()] },
      { name: "Lateral Raise (Dumbbell)", sets: [mkSet()] },
    ]);
    expect(transitionRestFor(d, 1)).toBeNull();
  });

  it("is null for the first exercise — nothing precedes it", () => {
    expect(transitionRestFor(twoExercises(), 0)).toBeNull();
  });

  it("is null for an index that does not exist", () => {
    expect(transitionRestFor(twoExercises(), 99)).toBeNull();
  });

  it("is null when the incoming exercise is a warm-up", () => {
    const d = mkDraft([
      { name: "Squat (Barbell)", sets: [mkSet()] },
      { name: "Squat (Barbell)", prescribed: { warmup: true }, sets: [mkSet()] },
    ]);
    expect(transitionRestFor(d, 1)).toBeNull();
  });

  it("honours a manual override on the incoming exercise", () => {
    // The athlete asked for 90s between sets of the squat, so the walk into it
    // is 90 + 60 — not the prescription's 300. A lifter who cut rest to get
    // through the session is not asking for a five-minute stroll.
    const d = twoExercises();
    d.exercises[1].rest_override_seconds = 90;
    expect(transitionRestFor(d, 1)).toBe(150);
  });

  it("does not let an override resurrect a transition that does not apply", () => {
    const d = twoExercises();
    d.exercises[0].rest_override_seconds = 300;
    expect(transitionRestFor(d, 0)).toBeNull();
  });
});

describe("transitionAfterRound", () => {
  /** Lateral Raise (tier 3 small, 60s) then Squat (tier 1, 240s), so the
   *  transition (300s) is unmistakably the NEXT exercise's number and not the
   *  finished one's. */
  const twoUp = () => mkDraft([
    { name: "Lateral Raise (Dumbbell)", sets: [mkSet(), mkSet()] },
    { name: "Squat (Barbell)", sets: [mkSet()] },
  ]);

  it("returns the next exercise's transition when the round ends the exercise", () => {
    expect(transitionAfterRound(twoUp(), [{ exerciseIndex: 0, setIndex: 1 }])).toBe(300);
  });

  it("returns null mid-exercise", () => {
    expect(transitionAfterRound(twoUp(), [{ exerciseIndex: 0, setIndex: 0 }])).toBeNull();
  });

  it("returns null after the session's last exercise", () => {
    expect(transitionAfterRound(twoUp(), [{ exerciseIndex: 1, setIndex: 0 }])).toBeNull();
  });

  it("returns null with no active sets", () => {
    expect(transitionAfterRound(twoUp(), [])).toBeNull();
  });

  it("needs BOTH superset members finished, not just one", () => {
    const d = mkDraft([
      { name: "Bicep Curl (Dumbbell)", sets: [mkSet(), mkSet()] },
      { name: "Triceps Pushdown", sets: [mkSet(), mkSet()] },
      { name: "Squat (Barbell)", sets: [mkSet()] },
    ]);
    // Curl on its last set, pushdown still has one to go.
    expect(transitionAfterRound(d, [
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 0 },
    ])).toBeNull();
    // Both on their last set — hands off to the exercise after the PAIR.
    expect(transitionAfterRound(d, [
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
    ])).toBe(300);
  });
});
