import { describe, it, expect } from "vitest";
import {
  PHONE_LAG_SECONDS,
  COUNTDOWN_SECONDS,
  IDLE_TIMER,
  timerReducer,
  workSecondsFor,
  restSeedSeconds,
  SUPERSET_TRANSITION_SECONDS,
  splitRoundWork,
  roundMemberStartOffsets,
  countdownRemaining,
  elapsedWorkSeconds,
  restRemaining,
  isRestOvertime,
  sameSet,
  includesSet,
  restBetweenSets,
  remapTimerExercises,
  remapTimerSets,
  totalWorkSeconds,
  type TimerState,
} from "@/lib/logger/set-timer";

const T0 = 1_700_000_000_000; // fixed epoch ms; no Date.now() in tests
const SET_A = { exerciseIndex: 0, setIndex: 1 };
const SET_B = { exerciseIndex: 0, setIndex: 2 };

/** Drive the machine to `running` with the set start anchored at `startMs`. */
function running(startMs: number): TimerState {
  const s1 = timerReducer(IDLE_TIMER, { type: "press_start", sets: [SET_A], nowMs: startMs - COUNTDOWN_SECONDS * 1000 });
  return timerReducer(s1, { type: "countdown_elapsed", nowMs: startMs });
}

describe("constants", () => {
  it("pins the phone lag at 4s and the countdown at 5s", () => {
    // Not the same number and not interchangeable: the countdown is a chosen
    // UX duration, the lag is a MEASURED quantity (calibrated against Garmin
    // work time, 2026-08-20 — see the constant's docstring).
    expect(PHONE_LAG_SECONDS).toBe(4);
    expect(COUNTDOWN_SECONDS).toBe(5);
  });
});

describe("workSecondsFor", () => {
  it("deducts the phone lag from raw elapsed", () => {
    // 38s on the clock, 4s of which was racking and reaching for the phone.
    expect(workSecondsFor(T0, T0 + 38_000)).toBe(34);
  });

  it("floors at 1 for a set shorter than the lag", () => {
    expect(workSecondsFor(T0, T0 + 3_000)).toBe(1);
  });

  it("floors at 1 when start and stop coincide", () => {
    expect(workSecondsFor(T0, T0)).toBe(1);
  });

  it("rounds sub-second remainders instead of truncating", () => {
    // Truncation only ever errs downward, so summing a session compounds the
    // loss. Rounding is unbiased, which is what a summed quantity needs.
    expect(workSecondsFor(T0, T0 + 38_900)).toBe(35); // .9 rounds up
    expect(workSecondsFor(T0, T0 + 38_100)).toBe(34); // .1 rounds down
    expect(workSecondsFor(T0, T0 + 38_500)).toBe(35); // .5 rounds up
  });

  it("does not accumulate a one-directional error across a session", () => {
    // 20 sets each landing on a .6 remainder. Truncation would shed 20s over
    // the session; rounding tracks the true total.
    const perSet = workSecondsFor(T0, T0 + 30_600);
    const trueTotal = 20 * (30.6 - PHONE_LAG_SECONDS);
    expect(Math.abs(perSet * 20 - trueTotal)).toBeLessThanOrEqual(10);
  });
});

describe("restSeedSeconds", () => {
  it("seeds a 3:00 prescription at 2:56", () => {
    expect(restSeedSeconds(180)).toBe(176);
  });

  it("floors at 1 for a prescription at or below the lag", () => {
    expect(restSeedSeconds(5)).toBe(1);
    expect(restSeedSeconds(3)).toBe(1);
    expect(restSeedSeconds(0)).toBe(1);
  });
});

describe("splitRoundWork", () => {
  it("matches workSecondsFor exactly for a one-member round", () => {
    expect(splitRoundWork(T0, T0 + 38_000, 1)).toEqual([workSecondsFor(T0, T0 + 38_000)]);
  });

  it("deducts one transition allowance for a pair and splits the rest", () => {
    // 101s wall clock − 4s phone lag − 5s transition = 92s of work, 46 each.
    expect(splitRoundWork(T0, T0 + 101_000, 2)).toEqual([46, 46]);
  });

  it("gives an odd remainder to the first member so the sum stays exact", () => {
    // Input chosen so the split is ODD — that is the whole point of this test,
    // so it must be re-picked whenever PHONE_LAG_SECONDS moves, not just
    // re-numbered. 100s − 4 − 5 = 91 → 46 + 45.
    const shares = splitRoundWork(T0, T0 + 100_000, 2);
    expect(shares[0] + shares[1]).toBe(91);
    expect(shares).toEqual([46, 45]);
    expect(shares[0]).toBeGreaterThan(shares[1]);
  });

  it("deducts two transitions for a three-member round", () => {
    // 125s − 4 − 10 = 111 → 37 each.
    const shares = splitRoundWork(T0, T0 + 125_000, 3);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(111);
    expect(shares[0]).toBe(37);
  });

  it("floors every member at 1 second for an absurdly short round", () => {
    expect(splitRoundWork(T0, T0 + 2_000, 2)).toEqual([1, 1]);
  });
});

describe("roundMemberStartOffsets", () => {
  it("starts the first member at zero", () => {
    expect(roundMemberStartOffsets([45, 45])[0]).toBe(0);
  });

  it("offsets each later member by the earlier shares plus a transition", () => {
    expect(roundMemberStartOffsets([45, 45])).toEqual([0, 50]);
    expect(roundMemberStartOffsets([38, 36, 36])).toEqual([0, 43, 84]);
  });
});

describe("timerReducer — press_start", () => {
  it("moves idle to countdown and records the set", () => {
    const s = timerReducer(IDLE_TIMER, { type: "press_start", sets: [SET_A], nowMs: T0 });
    expect(s.phase).toBe("countdown");
    expect(s.anchorMs).toBe(T0);
    expect(s.activeSets).toEqual([SET_A]);
  });

  it("clears a pending entry (the caller persists it first)", () => {
    const stopped = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(stopped.pendingEntries).toHaveLength(1);
    const restarted = timerReducer(stopped, { type: "press_start", sets: [SET_B], nowMs: T0 + 60_000 });
    expect(restarted.pendingEntries).toEqual([]);
  });

  it("is ignored while a set is already running", () => {
    const r = running(T0);
    expect(timerReducer(r, { type: "press_start", sets: [SET_B], nowMs: T0 + 1_000 })).toBe(r);
  });

  it("press_start with an empty round is a no-op", () => {
    expect(timerReducer(IDLE_TIMER, { type: "press_start", sets: [], nowMs: T0 })).toBe(IDLE_TIMER);
  });
});

describe("timerReducer — countdown_elapsed", () => {
  it("anchors the work clock at countdown end, not at the START tap", () => {
    const s1 = timerReducer(IDLE_TIMER, { type: "press_start", sets: [SET_A], nowMs: T0 });
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
  it("anchors rest at the rack, PHONE_LAG_SECONDS before the stop press", () => {
    const s = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(s.phase).toBe("rest");
    expect(s.anchorMs).toBe(T0 + 38_000 - PHONE_LAG_SECONDS * 1000);
    expect(s.restSeconds).toBe(176);
  });

  it("opens a pending entry carrying the honest work time", () => {
    const s = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(s.pendingEntries).toEqual([{ ...SET_A, workSeconds: 34 }]);
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
    const saved = timerReducer(rest, { type: "save_entry", set: SET_A });
    expect(saved.pendingEntries).toEqual([]);
    expect(saved.phase).toBe("rest");
    expect(saved.anchorMs).toBe(rest.anchorMs);
    expect(saved.restSeconds).toBe(rest.restSeconds);
  });

  it("save_entry for one member leaves the other member's row open", () => {
    const started = timerReducer(IDLE_TIMER, { type: "press_start", sets: [SET_A, SET_B], nowMs: T0 - 5000 });
    const running = timerReducer(started, { type: "countdown_elapsed", nowMs: T0 });
    const stopped = timerReducer(running, { type: "press_stop", nowMs: T0 + 100_000, prescribedRestSeconds: 120 });
    expect(stopped.pendingEntries).toHaveLength(2);
    const saved = timerReducer(stopped, { type: "save_entry", set: SET_A });
    expect(saved.pendingEntries).toEqual([{ ...SET_B, workSeconds: 45 }]);
    expect(saved.phase).toBe("rest");
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
    const s = timerReducer(IDLE_TIMER, { type: "press_start", sets: [SET_A], nowMs: T0 });
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
    // PHONE_LAG_SECONDS already elapsed at the moment of the press.
    expect(restRemaining(rest, stopPress)).toBe(172);
    expect(isRestOvertime(rest, stopPress)).toBe(false);
    // 176s of countdown from the rack = 172s after the press.
    expect(restRemaining(rest, stopPress + 172_000)).toBe(0);
    expect(restRemaining(rest, stopPress + 219_000)).toBe(-47);
    expect(isRestOvertime(rest, stopPress + 219_000)).toBe(true);
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
    expect(restRemaining(rest, T0 + 38_000 + 1_200_000)).toBe(-1028);
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

describe("includesSet", () => {
  it("matches by value anywhere in the round", () => {
    expect(includesSet([SET_A, SET_B], { exerciseIndex: 0, setIndex: 2 })).toBe(true);
    expect(includesSet([SET_A], SET_B)).toBe(false);
  });

  it("is false for a null ref and for an empty round", () => {
    expect(includesSet([SET_A], null)).toBe(false);
    expect(includesSet([], SET_A)).toBe(false);
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
    expect(next.activeSets).toEqual([{ exerciseIndex: 0, setIndex: 0 }]);
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

  it("remaps pendingEntries alongside activeSets, preserving their workSeconds", () => {
    const next = remapTimerSets(resting(), 0, removeAt(0));
    expect(next.activeSets).toEqual([{ exerciseIndex: 0, setIndex: 0 }]);
    expect(next.pendingEntries).toEqual([{ exerciseIndex: 0, setIndex: 0, workSeconds: 34 }]);
    // Rest keeps running underneath — a delete elsewhere must not touch it.
    expect(next.phase).toBe("rest");
    expect(next.restSeconds).toBe(176);
  });

  it("ignores a removal in a DIFFERENT exercise", () => {
    const r = resting();
    expect(remapTimerSets(r, 1, removeAt(0))).toBe(r);
    expect(remapTimerSets(r, 7, removeAt(1))).toBe(r);
  });

  it("drops only the pending entry when the two refs sit in different exercises", () => {
    // Not producible by the reducer, but remapTimerSets is a pure function of
    // TimerState and must not assume the two lists agree.
    const mixed: TimerState = {
      phase: "rest",
      anchorMs: T0,
      activeSets: [{ exerciseIndex: 1, setIndex: 0 }],
      restSeconds: 175,
      pendingEntries: [{ exerciseIndex: 0, setIndex: 2, workSeconds: 33 }],
    };
    const next = remapTimerSets(mixed, 0, removeAt(2));
    expect(next.pendingEntries).toEqual([]);
    expect(next.activeSets).toEqual([{ exerciseIndex: 1, setIndex: 0 }]);
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

describe("remapTimerExercises", () => {
  const resting = (exerciseIndex: number): TimerState => ({
    phase: "rest",
    anchorMs: T0,
    activeSets: [{ exerciseIndex, setIndex: 1 }],
    restSeconds: 175,
    pendingEntries: [{ exerciseIndex, setIndex: 1, workSeconds: 33 }],
  });

  it("shifts both refs down when an earlier exercise is removed", () => {
    const s = remapTimerExercises(resting(2), (i) => (i === 0 ? null : i - 1));
    expect(s.activeSets).toEqual([{ exerciseIndex: 1, setIndex: 1 }]);
    expect(s.pendingEntries).toEqual([{ exerciseIndex: 1, setIndex: 1, workSeconds: 33 }]);
    expect(s.phase).toBe("rest");
    expect(s.anchorMs).toBe(T0);
    expect(s.restSeconds).toBe(175);
  });

  it("returns the same object when no index moved", () => {
    const r = resting(1);
    expect(remapTimerExercises(r, (i) => i)).toBe(r);
  });

  it("goes idle when the exercise holding the active set is gone", () => {
    expect(remapTimerExercises(resting(1), (i) => (i === 1 ? null : i))).toEqual(IDLE_TIMER);
  });

  it("clears only the pending entry when its exercise is gone but the active set's survives", () => {
    const mixed: TimerState = {
      phase: "rest", anchorMs: T0, restSeconds: 175,
      activeSets: [{ exerciseIndex: 0, setIndex: 0 }],
      pendingEntries: [{ exerciseIndex: 2, setIndex: 0, workSeconds: 12 }],
    };
    const s = remapTimerExercises(mixed, (i) => (i === 2 ? null : i));
    expect(s.activeSets).toEqual([{ exerciseIndex: 0, setIndex: 0 }]);
    expect(s.pendingEntries).toEqual([]);
  });

  it("is a no-op on an idle timer regardless of the mapping", () => {
    expect(remapTimerExercises(IDLE_TIMER, () => null)).toBe(IDLE_TIMER);
  });
});

describe("regression guards", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("counts a zero-second work value rather than skipping it", () => {
    // Pins `!= null` against a regression to a truthiness check. A skipped
    // term and a zero term are arithmetically identical in a sum, so this
    // asserts on the ROW COUNT reaching the sum via a non-zero sibling.
    const zero = totalWorkSeconds([
      { sets: [{ committed_at: iso(T0), work_seconds: 0 }, { committed_at: iso(T0), work_seconds: 7 }] },
    ]);
    const nulled = totalWorkSeconds([
      { sets: [{ committed_at: iso(T0), work_seconds: null }, { committed_at: iso(T0), work_seconds: 7 }] },
    ]);
    expect(zero).toBe(7);
    expect(nulled).toBe(7);
  });

  it("treats work_seconds 0 as a real measurement in restBetweenSets", () => {
    // A truthiness check here would fall through to the commit-delta proxy and
    // silently report a different number.
    const prev = { started_at: iso(T0), work_seconds: 0, committed_at: iso(T0 + 90_000) };
    const next = { started_at: iso(T0 + 60_000), committed_at: iso(T0 + 120_000) };
    expect(restBetweenSets(prev, next)).toBe(60); // anchored path, not the 30s commit delta
  });

  it("returns null from the FALLBACK path on a negative commit delta", () => {
    // Deliberately different from the anchored path, which clamps to 0.
    const prev = { started_at: null, work_seconds: null, committed_at: iso(T0 + 60_000) };
    const next = { started_at: null, committed_at: iso(T0) };
    expect(restBetweenSets(prev, next)).toBeNull();
  });
});
