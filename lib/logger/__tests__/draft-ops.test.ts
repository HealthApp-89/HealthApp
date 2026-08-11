// Characterisation tests for the draft-level helpers extracted out of
// LoggerSheet.tsx. They were unreachable by vitest while they lived in a .tsx
// (node environment, `lib/**/__tests__` glob only) and two of them shipped
// bugs during that time — commitPendingEntry's time-based fallback and
// keepUnmovedRestOverrides' index handling.

import { describe, it, expect } from "vitest";
import type { LoggerDraft, ExerciseSetDraft } from "@/lib/logger/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import {
  timerOf,
  withTimer,
  commitPendingEntry,
  keepUnmovedRestOverrides,
  firstPendingSet,
  annotatedRestFor,
} from "@/lib/logger/draft-ops";
import { IDLE_TIMER, type TimerState } from "@/lib/logger/set-timer";

const NOW = "2026-08-11T09:00:00.000Z";

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
  activeSet: { exerciseIndex, setIndex },
  restSeconds: 175,
  pendingEntry: { exerciseIndex, setIndex, workSeconds },
});

describe("timerOf", () => {
  it("falls back to idle for a draft written before timing existed", () => {
    expect(timerOf(mkDraft([{ name: "Squat", sets: [mkSet()] }], null))).toBe(IDLE_TIMER);
    expect(timerOf(null)).toBe(IDLE_TIMER);
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
    const out = commitPendingEntry(d, NOW);
    expect(out.exercises[0].sets[0].committed_at).toBe(NOW);
    expect(out.exercises[0].sets[1].committed_at).toBeNull();
    expect(out.timer!.pendingEntry).toBeNull();
    // The whole point of splitting commit out of stop.
    expect(out.timer!.phase).toBe("rest");
    expect(out.timer!.anchorMs).toBe(d.timer!.anchorMs);
    expect(out.timer!.restSeconds).toBe(175);
  });

  it("is a no-op when nothing is pending", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }], IDLE_TIMER);
    expect(commitPendingEntry(d, NOW)).toBe(d);
  });

  it("never re-stamps an already-committed set", () => {
    const d = mkDraft(
      [{ name: "Squat", sets: [mkSet({ committed_at: "2020-01-01T00:00:00.000Z" })] }],
      restingOn(0, 0),
    );
    expect(commitPendingEntry(d, NOW).exercises[0].sets[0].committed_at)
      .toBe("2020-01-01T00:00:00.000Z");
  });

  it("fills duration_seconds from the measured work time for a time-based set", () => {
    // The plank the timer measured at 45s must not commit as no plank at all
    // just because its seconds field was never blurred.
    const d = mkDraft(
      [{ name: "Plank", prescribed: { duration_seconds: 60 }, sets: [mkSet({ kg: null, reps: null })] }],
      restingOn(0, 0, 45),
    );
    const s = commitPendingEntry(d, NOW).exercises[0].sets[0];
    expect(s.duration_seconds).toBe(45);
  });

  it("does not overwrite a duration the athlete actually typed", () => {
    const d = mkDraft(
      [{ name: "Plank", prescribed: { duration_seconds: 60 }, sets: [mkSet({ duration_seconds: 52 })] }],
      restingOn(0, 0, 45),
    );
    expect(commitPendingEntry(d, NOW).exercises[0].sets[0].duration_seconds).toBe(52);
  });

  it("leaves duration_seconds null on a REP-based set", () => {
    // Load-bearing: lib/coach/derived.ts reads duration_seconds as a hold and
    // lib/coach/snapshot.ts renders it to the coach as "45s hold". A rep set
    // writing it produces a 33-second bench press.
    const d = mkDraft([{ name: "Squat", sets: [mkSet()] }], restingOn(0, 0, 33));
    expect(commitPendingEntry(d, NOW).exercises[0].sets[0].duration_seconds).toBeNull();
  });
});

describe("keepUnmovedRestOverrides", () => {
  const identity = (i: number) => i;

  it("keeps every override when nothing moved", () => {
    expect(keepUnmovedRestOverrides({ 0: 90, 2: 150 }, identity)).toEqual({ 0: 90, 2: 150 });
  });

  it("drops overrides whose card remounted because its index shifted", () => {
    // Exercise 0 removed: 1->0, 2->1. Neither survivor keeps its index, so
    // both lifted overrides go, matching the local copies the remount reset.
    const mapIndex = (i: number) => (i === 0 ? null : i - 1);
    expect(keepUnmovedRestOverrides({ 1: 90, 2: 150 }, mapIndex)).toEqual({});
  });

  it("keeps entries above an edit that did not move them", () => {
    // Removing index 3 leaves 0..2 in place.
    const mapIndex = (i: number) => (i === 3 ? null : i < 3 ? i : i - 1);
    expect(keepUnmovedRestOverrides({ 0: 90, 3: 120, 4: 150 }, mapIndex)).toEqual({ 0: 90 });
  });
});

describe("firstPendingSet", () => {
  it("finds the first uncommitted set in draft order", () => {
    const d = mkDraft([
      { name: "Squat", sets: [mkSet({ committed_at: NOW }), mkSet()] },
      { name: "Leg Press", sets: [mkSet()] },
    ]);
    expect(firstPendingSet(d, null)).toEqual({ exerciseIndex: 0, setIndex: 1 });
  });

  it("skips the set whose entry row is open", () => {
    // Otherwise START would offer to re-run the set just finished — and the
    // caller commits the entry first, so it would count down to a set it had
    // itself just committed.
    const d = mkDraft([
      { name: "Squat", sets: [mkSet({ committed_at: NOW }), mkSet()] },
      { name: "Leg Press", sets: [mkSet()] },
    ]);
    expect(firstPendingSet(d, { exerciseIndex: 0, setIndex: 1 }))
      .toEqual({ exerciseIndex: 1, setIndex: 0 });
  });

  it("returns null once everything is committed, so the dock can disable START", () => {
    const d = mkDraft([{ name: "Squat", sets: [mkSet({ committed_at: NOW })] }]);
    expect(firstPendingSet(d, null)).toBeNull();
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
});
