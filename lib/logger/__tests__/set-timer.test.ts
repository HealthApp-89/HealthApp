import { describe, it, expect } from "vitest";
import {
  PHONE_LAG_SECONDS,
  COUNTDOWN_SECONDS,
  IDLE_TIMER,
  timerReducer,
  workSecondsFor,
  restSeedSeconds,
  countdownRemaining,
  elapsedWorkSeconds,
  restRemaining,
  isRestOvertime,
  sameSet,
  restBetweenSets,
  remapTimerSets,
  totalWorkSeconds,
  type TimerState,
} from "@/lib/logger/set-timer";

const T0 = 1_700_000_000_000; // fixed epoch ms; no Date.now() in tests
const SET_A = { exerciseIndex: 0, setIndex: 1 };
const SET_B = { exerciseIndex: 0, setIndex: 2 };

/** Drive the machine to `running` with the set start anchored at `startMs`. */
function running(startMs: number): TimerState {
  const s1 = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: startMs - COUNTDOWN_SECONDS * 1000 });
  return timerReducer(s1, { type: "countdown_elapsed", nowMs: startMs });
}

describe("constants", () => {
  it("pins the phone lag and countdown at 5s each", () => {
    expect(PHONE_LAG_SECONDS).toBe(5);
    expect(COUNTDOWN_SECONDS).toBe(5);
  });
});

describe("workSecondsFor", () => {
  it("deducts the phone lag from raw elapsed", () => {
    // 38s on the clock, 5s of which was fumbling for the phone.
    expect(workSecondsFor(T0, T0 + 38_000)).toBe(33);
  });

  it("floors at 1 for a set shorter than the lag", () => {
    expect(workSecondsFor(T0, T0 + 3_000)).toBe(1);
  });

  it("floors at 1 when start and stop coincide", () => {
    expect(workSecondsFor(T0, T0)).toBe(1);
  });

  it("truncates sub-second remainders rather than rounding up", () => {
    expect(workSecondsFor(T0, T0 + 38_900)).toBe(33);
  });
});

describe("restSeedSeconds", () => {
  it("seeds a 3:00 prescription at 2:55", () => {
    expect(restSeedSeconds(180)).toBe(175);
  });

  it("floors at 1 for a prescription at or below the lag", () => {
    expect(restSeedSeconds(5)).toBe(1);
    expect(restSeedSeconds(3)).toBe(1);
    expect(restSeedSeconds(0)).toBe(1);
  });
});

describe("timerReducer — press_start", () => {
  it("moves idle to countdown and records the set", () => {
    const s = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: T0 });
    expect(s.phase).toBe("countdown");
    expect(s.anchorMs).toBe(T0);
    expect(s.activeSet).toEqual(SET_A);
  });

  it("clears a pending entry (the caller persists it first)", () => {
    const stopped = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(stopped.pendingEntry).not.toBeNull();
    const restarted = timerReducer(stopped, { type: "press_start", set: SET_B, nowMs: T0 + 60_000 });
    expect(restarted.pendingEntry).toBeNull();
  });

  it("is ignored while a set is already running", () => {
    const r = running(T0);
    expect(timerReducer(r, { type: "press_start", set: SET_B, nowMs: T0 + 1_000 })).toBe(r);
  });
});

describe("timerReducer — countdown_elapsed", () => {
  it("anchors the work clock at countdown end, not at the START tap", () => {
    const s1 = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: T0 });
    const s2 = timerReducer(s1, { type: "countdown_elapsed", nowMs: T0 + 5_000 });
    expect(s2.phase).toBe("running");
    expect(s2.anchorMs).toBe(T0 + 5_000);
  });

  it("is ignored from any phase but countdown", () => {
    const r = running(T0);
    expect(timerReducer(r, { type: "countdown_elapsed", nowMs: T0 + 1_000 })).toBe(r);
    expect(timerReducer(IDLE_TIMER, { type: "countdown_elapsed", nowMs: T0 })).toBe(IDLE_TIMER);
  });
});

describe("timerReducer — press_stop", () => {
  it("anchors rest at the rack, five seconds before the stop press", () => {
    const s = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(s.phase).toBe("rest");
    expect(s.anchorMs).toBe(T0 + 38_000 - PHONE_LAG_SECONDS * 1000);
    expect(s.restSeconds).toBe(175);
  });

  it("opens a pending entry carrying the honest work time", () => {
    const s = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(s.pendingEntry).toEqual({ ...SET_A, workSeconds: 33 });
  });

  it("is ignored when no set is running", () => {
    expect(
      timerReducer(IDLE_TIMER, { type: "press_stop", nowMs: T0, prescribedRestSeconds: 180 }),
    ).toBe(IDLE_TIMER);
  });
});

describe("timerReducer — save_entry", () => {
  it("clears the entry without disturbing the running rest clock", () => {
    const rest = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    const saved = timerReducer(rest, { type: "save_entry" });
    expect(saved.pendingEntry).toBeNull();
    expect(saved.phase).toBe("rest");
    expect(saved.anchorMs).toBe(rest.anchorMs);
    expect(saved.restSeconds).toBe(rest.restSeconds);
  });
});

describe("timerReducer — clear_for_set", () => {
  it("returns to idle when the cleared set is the active one", () => {
    const s = timerReducer(running(T0), { type: "clear_for_set", set: SET_A });
    expect(s).toEqual(IDLE_TIMER);
  });

  it("leaves state alone when a different set is cleared", () => {
    const r = running(T0);
    expect(timerReducer(r, { type: "clear_for_set", set: SET_B })).toBe(r);
  });
});

describe("timerReducer — reset", () => {
  it("returns to idle from any phase", () => {
    expect(timerReducer(running(T0), { type: "reset" })).toEqual(IDLE_TIMER);
  });
});

describe("derivations", () => {
  it("counts the countdown down and clamps at zero", () => {
    const s = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: T0 });
    expect(countdownRemaining(s, T0)).toBe(5);
    expect(countdownRemaining(s, T0 + 2_400)).toBe(3);
    expect(countdownRemaining(s, T0 + 9_000)).toBe(0);
  });

  it("counts work time up from the anchor", () => {
    const r = running(T0);
    expect(elapsedWorkSeconds(r, T0)).toBe(0);
    expect(elapsedWorkSeconds(r, T0 + 27_400)).toBe(27);
  });

  it("returns signed rest remaining so overtime is negative", () => {
    const rest = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    const stopPress = T0 + 38_000;
    // 5s already elapsed at the moment of the press.
    expect(restRemaining(rest, stopPress)).toBe(170);
    expect(isRestOvertime(rest, stopPress)).toBe(false);
    // 175s of countdown from the rack = 170s after the press.
    expect(restRemaining(rest, stopPress + 170_000)).toBe(0);
    expect(restRemaining(rest, stopPress + 217_000)).toBe(-47);
    expect(isRestOvertime(rest, stopPress + 217_000)).toBe(true);
  });

  it("reports zero for derivations that do not apply to the current phase", () => {
    expect(countdownRemaining(running(T0), T0)).toBe(0);
    expect(elapsedWorkSeconds(IDLE_TIMER, T0)).toBe(0);
    expect(restRemaining(IDLE_TIMER, T0)).toBe(0);
    expect(isRestOvertime(IDLE_TIMER, T0)).toBe(false);
  });

  it("stays correct across a long background gap (anchor-derived, not accumulated)", () => {
    const rest = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    // Phone locked for 20 minutes.
    expect(restRemaining(rest, T0 + 38_000 + 1_200_000)).toBe(-1030);
  });
});

describe("sameSet", () => {
  it("compares by value and treats null as unequal", () => {
    expect(sameSet(SET_A, { exerciseIndex: 0, setIndex: 1 })).toBe(true);
    expect(sameSet(SET_A, SET_B)).toBe(false);
    expect(sameSet(null, null)).toBe(false);
    expect(sameSet(SET_A, null)).toBe(false);
  });
});

describe("remapTimerSets", () => {
  /** Index map for "the set at `removed` was deleted and the survivors
   *  re-indexed" — exactly what ExerciseCard's delete does to `set_index`. */
  const removeAt = (removed: number) => (i: number) =>
    i === removed ? null : i > removed ? i - 1 : i;

  /** `rest` with both refs on SET_A (exercise 0, set 1) — the shape the
   *  machine is actually in while the zoomed entry row is open. */
  function resting(): TimerState {
    return timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
  }

  it("shifts the in-play ref down when a set BELOW it is removed", () => {
    // The reachable case: a warmup at index 0 is deleted while set 1 is live.
    const next = remapTimerSets(running(T0), 0, removeAt(0));
    expect(next.activeSet).toEqual({ exerciseIndex: 0, setIndex: 0 });
    expect(next.phase).toBe("running");
    expect(next.anchorMs).toBe(T0);
  });

  it("leaves the in-play ref alone when a set ABOVE it is removed", () => {
    const r = running(T0);
    expect(remapTimerSets(r, 0, removeAt(3))).toBe(r);
  });

  it("returns to idle when the in-play set itself is removed", () => {
    expect(remapTimerSets(running(T0), 0, removeAt(1))).toEqual(IDLE_TIMER);
  });

  it("remaps pendingEntry alongside activeSet, preserving its workSeconds", () => {
    const next = remapTimerSets(resting(), 0, removeAt(0));
    expect(next.activeSet).toEqual({ exerciseIndex: 0, setIndex: 0 });
    expect(next.pendingEntry).toEqual({ exerciseIndex: 0, setIndex: 0, workSeconds: 33 });
    // Rest keeps running underneath — a delete elsewhere must not touch it.
    expect(next.phase).toBe("rest");
    expect(next.restSeconds).toBe(175);
  });

  it("ignores a removal in a DIFFERENT exercise", () => {
    const r = resting();
    expect(remapTimerSets(r, 1, removeAt(0))).toBe(r);
    expect(remapTimerSets(r, 7, removeAt(1))).toBe(r);
  });

  it("drops only pendingEntry when the two refs sit in different exercises", () => {
    // Not producible by the reducer, but remapTimerSets is a pure function of
    // TimerState and must not assume the two refs agree.
    const mixed: TimerState = {
      phase: "rest",
      anchorMs: T0,
      activeSet: { exerciseIndex: 1, setIndex: 0 },
      restSeconds: 175,
      pendingEntry: { exerciseIndex: 0, setIndex: 2, workSeconds: 33 },
    };
    const next = remapTimerSets(mixed, 0, removeAt(2));
    expect(next.pendingEntry).toBeNull();
    expect(next.activeSet).toEqual({ exerciseIndex: 1, setIndex: 0 });
  });

  it("is a no-op on an idle timer", () => {
    expect(remapTimerSets(IDLE_TIMER, 0, removeAt(0))).toBe(IDLE_TIMER);
  });
});

describe("restBetweenSets", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("measures true rest: next start minus previous end", () => {
    const prev = { started_at: iso(T0), work_seconds: 33, committed_at: iso(T0 + 38_000) };
    // Previous set truly ended at T0+33s. Next set starts 175s later.
    const next = { started_at: iso(T0 + 33_000 + 175_000), committed_at: iso(T0 + 260_000) };
    expect(restBetweenSets(prev, next)).toBe(175);
  });

  it("excludes set-execution time that the commit-delta proxy included", () => {
    const prev = { started_at: iso(T0), work_seconds: 40, committed_at: iso(T0 + 45_000) };
    const next = { started_at: iso(T0 + 100_000), committed_at: iso(T0 + 140_000) };
    // Commit-to-commit would say 95s. True rest is 100 - 40 = 60s.
    expect(restBetweenSets(prev, next)).toBe(60);
  });

  it("falls back to the commit delta when the previous set was not timed", () => {
    const prev = { started_at: null, work_seconds: null, committed_at: iso(T0) };
    const next = { started_at: iso(T0 + 120_000), committed_at: iso(T0 + 150_000) };
    expect(restBetweenSets(prev, next)).toBe(150);
  });

  it("falls back to the commit delta when the next set was not timed", () => {
    const prev = { started_at: iso(T0), work_seconds: 30, committed_at: iso(T0 + 35_000) };
    const next = { started_at: null, committed_at: iso(T0 + 155_000) };
    expect(restBetweenSets(prev, next)).toBe(120);
  });

  it("returns null when there is no commit timestamp to fall back on", () => {
    expect(
      restBetweenSets(
        { started_at: null, work_seconds: null, committed_at: null },
        { started_at: null, committed_at: iso(T0) },
      ),
    ).toBeNull();
  });

  it("clamps a negative result to zero rather than emitting nonsense", () => {
    const prev = { started_at: iso(T0), work_seconds: 200, committed_at: iso(T0 + 205_000) };
    const next = { started_at: iso(T0 + 100_000), committed_at: iso(T0 + 130_000) };
    expect(restBetweenSets(prev, next)).toBe(0);
  });
});

describe("totalWorkSeconds", () => {
  const committed = (workSeconds: number | null) => ({
    committed_at: "2026-08-10T06:00:00.000Z",
    work_seconds: workSeconds,
  });
  const uncommitted = (workSeconds: number | null) => ({
    committed_at: null,
    work_seconds: workSeconds,
  });

  it("sums work_seconds across committed sets in every exercise", () => {
    const exercises = [
      { sets: [committed(30), committed(45)] },
      { sets: [committed(20)] },
    ];
    expect(totalWorkSeconds(exercises)).toBe(95);
  });

  it("excludes a null work_seconds rather than counting it as zero", () => {
    // A hand-logged set sits alongside two timed ones — it must not silently
    // zero-fill and it must not throw.
    const exercises = [{ sets: [committed(30), committed(null), committed(20)] }];
    expect(totalWorkSeconds(exercises)).toBe(50);
  });

  it("excludes uncommitted (still zoomed) sets even when timed", () => {
    const exercises = [{ sets: [committed(30), uncommitted(15)] }];
    expect(totalWorkSeconds(exercises)).toBe(30);
  });

  it("returns zero for an all-untimed (hand-logged) session", () => {
    const exercises = [
      { sets: [committed(null), committed(null)] },
      { sets: [committed(null)] },
    ];
    expect(totalWorkSeconds(exercises)).toBe(0);
  });

  it("returns zero for an empty exercise list", () => {
    expect(totalWorkSeconds([])).toBe(0);
  });
});
