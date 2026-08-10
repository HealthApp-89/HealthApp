// lib/logger/set-timer.ts
//
// The logger's set/rest state machine. Pure — no React, no Date.now(), no I/O.
// Every "now" arrives as a parameter so the whole thing is testable and so the
// UI can re-derive from an absolute anchor after the phone has been locked.
//
// The load-bearing idea is PHONE_LAG_SECONDS. The athlete racks the bar, then
// picks up the phone, unlocks it, and taps stop — about five seconds during
// which he is already resting. Back-dating the set end by that lag makes work
// time honest AND anchors the rest countdown at the rack instead of the tap.
// They are the same fact seen from two sides, which is why one constant drives
// both and neither is allowed to re-declare it.

/** Seconds between racking the bar and the stop press actually registering. */
export const PHONE_LAG_SECONDS = 5;

/** Walk-up countdown after START. Deliberately NOT counted as work. */
export const COUNTDOWN_SECONDS = 5;

export type SetRef = { exerciseIndex: number; setIndex: number };

export type TimerPhase = "idle" | "countdown" | "running" | "rest";

export type TimerState = {
  phase: TimerPhase;
  /** Absolute epoch ms the current phase started. Null only when idle.
   *  For `rest` this is the RACK time, already back-dated by the phone lag. */
  anchorMs: number | null;
  /** The set the phase concerns: counting down to it, lifting it, or resting
   *  after it. */
  activeSet: SetRef | null;
  /** Seeded rest length for the rest currently running (prescribed − lag). */
  restSeconds: number;
  /** Zoomed entry row. Deliberately NOT a phase: entry and rest are
   *  concurrent, and making entry a phase value would make them mutually
   *  exclusive — exactly the coupling this design removes. */
  pendingEntry: (SetRef & { workSeconds: number }) | null;
};

export const IDLE_TIMER: TimerState = {
  phase: "idle",
  anchorMs: null,
  activeSet: null,
  restSeconds: 0,
  pendingEntry: null,
};

export type TimerAction =
  | { type: "press_start"; set: SetRef; nowMs: number }
  /** Countdown reached zero, or the athlete tapped to skip it. */
  | { type: "countdown_elapsed"; nowMs: number }
  | { type: "press_stop"; nowMs: number; prescribedRestSeconds: number }
  | { type: "save_entry" }
  /** A set was uncommitted or deleted. */
  | { type: "clear_for_set"; set: SetRef }
  | { type: "reset" };

export function sameSet(a: SetRef | null, b: SetRef | null): boolean {
  if (!a || !b) return false;
  return a.exerciseIndex === b.exerciseIndex && a.setIndex === b.setIndex;
}

/** Honest time under load. Floored at 1 so a very short set cannot go
 *  negative once the lag is deducted. Truncates rather than rounds — a set is
 *  not credited with a second it did not complete. */
export function workSecondsFor(startAnchorMs: number, stopPressMs: number): number {
  const raw = Math.floor((stopPressMs - startAnchorMs) / 1000) - PHONE_LAG_SECONDS;
  return Math.max(1, raw);
}

/** Rest is already PHONE_LAG_SECONDS old when the stop press registers. */
export function restSeedSeconds(prescribedRestSeconds: number): number {
  return Math.max(1, prescribedRestSeconds - PHONE_LAG_SECONDS);
}

export function timerReducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case "press_start": {
      // Starting a new set while one is mid-flight is not a thing the UI
      // offers (the circle reads STOP), so treat it as a no-op rather than
      // silently discarding an in-progress set's anchor.
      if (state.phase === "countdown" || state.phase === "running") return state;
      return {
        phase: "countdown",
        anchorMs: action.nowMs,
        activeSet: action.set,
        restSeconds: 0,
        // Caller persists any open entry BEFORE dispatching — see the
        // auto-save in LoggerSheet's handleStart.
        pendingEntry: null,
      };
    }

    case "countdown_elapsed": {
      if (state.phase !== "countdown") return state;
      return { ...state, phase: "running", anchorMs: action.nowMs };
    }

    case "press_stop": {
      if (state.phase !== "running" || state.anchorMs === null || state.activeSet === null) {
        return state;
      }
      const workSeconds = workSecondsFor(state.anchorMs, action.nowMs);
      return {
        phase: "rest",
        // Anchor at the rack, not the tap.
        anchorMs: action.nowMs - PHONE_LAG_SECONDS * 1000,
        activeSet: state.activeSet,
        restSeconds: restSeedSeconds(action.prescribedRestSeconds),
        pendingEntry: { ...state.activeSet, workSeconds },
      };
    }

    case "save_entry": {
      if (state.pendingEntry === null) return state;
      return { ...state, pendingEntry: null };
    }

    case "clear_for_set": {
      if (sameSet(state.activeSet, action.set)) return IDLE_TIMER;
      if (state.pendingEntry && sameSet(state.pendingEntry, action.set)) {
        return { ...state, pendingEntry: null };
      }
      return state;
    }

    case "reset":
      return IDLE_TIMER;
  }
}

/**
 * Re-point the timer's stored refs after the SET list of one exercise changed
 * under them.
 *
 * `SetRef.setIndex` is positional, so deleting a set that sits BEFORE the one
 * in play leaves both stored refs one too high and they silently name the row
 * that slid up into the slot. `clear_for_set` cannot cover this: it only fires
 * on an EXACT ref match, so a delete anywhere below the live set is invisible
 * to it. That mis-stamps `committed_at` / `work_seconds` today, and once the
 * zoomed entry row lands it writes the athlete's typed kg / reps / RIR onto a
 * different set — undetectable after the fact.
 *
 * Mirrors `remapTimerExercises` in LoggerSheet, including its rule for a
 * vanished target: if the set in play (or being rested after) is gone there is
 * nothing left to stop or save, so drop the whole timer rather than let it
 * advance against a set that no longer exists.
 *
 * `mapSetIndex` returns the set's new index within `exerciseIndex`, or null if
 * it is gone. Refs in any OTHER exercise are untouched.
 */
export function remapTimerSets(
  state: TimerState,
  exerciseIndex: number,
  mapSetIndex: (oldIndex: number) => number | null,
): TimerState {
  if (state.activeSet === null && state.pendingEntry === null) return state;
  let next = state;

  if (next.activeSet && next.activeSet.exerciseIndex === exerciseIndex) {
    const moved = mapSetIndex(next.activeSet.setIndex);
    if (moved === null) return IDLE_TIMER;
    if (moved !== next.activeSet.setIndex) {
      next = { ...next, activeSet: { ...next.activeSet, setIndex: moved } };
    }
  }

  if (next.pendingEntry && next.pendingEntry.exerciseIndex === exerciseIndex) {
    const moved = mapSetIndex(next.pendingEntry.setIndex);
    if (moved === null) {
      next = { ...next, pendingEntry: null };
    } else if (moved !== next.pendingEntry.setIndex) {
      next = { ...next, pendingEntry: { ...next.pendingEntry, setIndex: moved } };
    }
  }

  return next;
}

/**
 * Session wall clock in ms: time since `started_at`, minus every completed
 * pause interval, frozen while `paused_at` is set.
 *
 * Lives here rather than in LoggerSheet because two components need it and it
 * is pure — `now` is a parameter. LoggerSheet's header clock and SetTimerDock's
 * SESSION counter each own their own tick and call this, so they can never
 * disagree, and no live-computed number has to cross a component boundary.
 */
export function getElapsedMs(
  clock: { started_at: string; paused_at: string | null; paused_ms_total: number },
  now: number,
): number {
  const start = new Date(clock.started_at).getTime();
  const end = clock.paused_at ? new Date(clock.paused_at).getTime() : now;
  return Math.max(0, end - start - clock.paused_ms_total);
}

/** The set/exercise shapes totalWorkSeconds needs. Structural so both
 *  ExerciseDraft/ExerciseSetDraft and any future plain-row shape satisfy it. */
type WorkSecondsSet = { committed_at: string | null; work_seconds?: number | null };
type WorkSecondsExercise = { sets: WorkSecondsSet[] };

/**
 * Total honest work time across every COMMITTED set in a session, in seconds.
 *
 * `work_seconds` is nullable — hand-logged sets, Strong CSV imports, and
 * pre-timer rows carry NULL and are excluded rather than counted as zero, so
 * a partially-timed session does not understate its own work total. An
 * uncommitted (still zoomed) set is excluded too; the caller is responsible
 * for flushing any pending entry before reading this if it wants the final
 * set counted.
 *
 * Single source of truth for this sum — SetTimerDock's live WORK counter and
 * FinishSummary's work:rest ratio both call this rather than each keeping
 * their own copy of the same filter.
 */
export function totalWorkSeconds(exercises: WorkSecondsExercise[]): number {
  let total = 0;
  for (const ex of exercises) {
    for (const s of ex.sets) {
      if (s.committed_at && s.work_seconds != null) total += s.work_seconds;
    }
  }
  return total;
}

function elapsedSecondsSinceAnchor(state: TimerState, nowMs: number): number {
  if (state.anchorMs === null) return 0;
  return Math.floor((nowMs - state.anchorMs) / 1000);
}

/** Whole seconds left in the walk-up countdown. Zero outside `countdown`. */
export function countdownRemaining(state: TimerState, nowMs: number): number {
  if (state.phase !== "countdown") return 0;
  return Math.max(0, COUNTDOWN_SECONDS - elapsedSecondsSinceAnchor(state, nowMs));
}

/** Seconds under load so far. Zero outside `running`. */
export function elapsedWorkSeconds(state: TimerState, nowMs: number): number {
  if (state.phase !== "running") return 0;
  return Math.max(0, elapsedSecondsSinceAnchor(state, nowMs));
}

/** SIGNED seconds left in rest — negative once the athlete is over. Deliberately
 *  unclamped: overtime is information, not an error state, and the dock renders
 *  it as a negative counter. Zero outside `rest`. */
export function restRemaining(state: TimerState, nowMs: number): number {
  if (state.phase !== "rest") return 0;
  return state.restSeconds - elapsedSecondsSinceAnchor(state, nowMs);
}

export function isRestOvertime(state: TimerState, nowMs: number): boolean {
  return state.phase === "rest" && restRemaining(state, nowMs) < 0;
}

/** The two set shapes restBetweenSets needs. Structural so both
 *  ExerciseSetDraft and a plain DB row satisfy it. */
type RestPrevSet = {
  started_at?: string | null;
  work_seconds?: number | null;
  committed_at: string | null;
};
type RestNextSet = {
  started_at?: string | null;
  committed_at: string | null;
};

/**
 * Seconds of ACTUAL rest between two consecutive committed sets.
 *
 * Preferred path uses true anchors: the previous set ended at
 * `started_at + work_seconds`, so rest is the gap from there to the next set's
 * start. The legacy path — commit timestamp deltas — measured rest PLUS set
 * execution, which is why ruleRestDiscipline's own header called it a proxy.
 *
 * Falls back to that proxy whenever either side lacks timer data, so
 * hand-logged sets, Strong imports, and pre-0056 rows keep their old value
 * rather than silently becoming null.
 */
export function restBetweenSets(prev: RestPrevSet, next: RestNextSet): number | null {
  if (prev.started_at && prev.work_seconds != null && next.started_at) {
    const prevEnd = Date.parse(prev.started_at) + prev.work_seconds * 1000;
    const nextStart = Date.parse(next.started_at);
    if (Number.isFinite(prevEnd) && Number.isFinite(nextStart)) {
      return Math.max(0, Math.round((nextStart - prevEnd) / 1000));
    }
  }

  if (prev.committed_at && next.committed_at) {
    const delta = Date.parse(next.committed_at) - Date.parse(prev.committed_at);
    if (!Number.isFinite(delta) || delta < 0) return null;
    return Math.round(delta / 1000);
  }

  return null;
}
