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

/** Seconds between racking the bar and the stop press actually registering.
 *
 *  Calibrated 2026-08-20 against Garmin's independently-derived work time
 *  (wrist accelerometry set detection) over two full sessions:
 *
 *    Aug 18 Legs   garmin 786s  logger 752s  20 sets  -1.7s/set
 *    Aug 19 Chest  garmin 744s  logger 727s  21 sets  -0.8s/set
 *
 *  Σours - Σgarmin = n x (trueLag - PHONE_LAG_SECONDS) puts the real lag at
 *  ~3.3-4.2s once the rounding loss below is netted out. Was 5; the systematic
 *  under-report that produced is worth about a second a set. Two independent
 *  measurement systems agreeing inside 4% is the reason to trust this number
 *  rather than raise it again on a hunch — re-derive it, don't guess it. */
export const PHONE_LAG_SECONDS = 4;

/** Walk-up countdown after START. Deliberately NOT counted as work. */
export const COUNTDOWN_SECONDS = 5;

export type SetRef = { exerciseIndex: number; setIndex: number };

export type TimerPhase = "idle" | "countdown" | "running" | "rest";

export type TimerState = {
  phase: TimerPhase;
  /** Absolute epoch ms the current phase started. Null only when idle.
   *  For `rest` this is the RACK time, already back-dated by the phone lag. */
  anchorMs: number | null;
  /** The sets the phase concerns, in group order: counting down to them,
   *  under load, or being rested after. A superset round holds more than one;
   *  an ordinary exercise holds exactly one; idle holds none. One list rather
   *  than a separate superset path — a second copy of this machine is how the
   *  two would drift. */
  activeSets: SetRef[];
  /** Seeded rest length for the rest currently running (prescribed − lag). */
  restSeconds: number;
  /** Zoomed entry rows — one per member of the round just stopped, each
   *  carrying that member's share of the round's work. Deliberately NOT a
   *  phase: entry and rest are concurrent, and making entry a phase value would
   *  make them mutually exclusive — exactly the coupling this design removes. */
  pendingEntries: (SetRef & { workSeconds: number })[];
};

export const IDLE_TIMER: TimerState = {
  phase: "idle",
  anchorMs: null,
  activeSets: [],
  restSeconds: 0,
  pendingEntries: [],
};

export type TimerAction =
  | { type: "press_start"; sets: SetRef[]; nowMs: number }
  /** Countdown reached zero, or the athlete tapped to skip it. */
  | { type: "countdown_elapsed"; nowMs: number }
  | { type: "press_stop"; nowMs: number; prescribedRestSeconds: number }
  /** One member's entry row was saved. The rest stay open. */
  | { type: "save_entry"; set: SetRef }
  /** A set was uncommitted or deleted. */
  | { type: "clear_for_set"; set: SetRef }
  | { type: "reset" };

export function sameSet(a: SetRef | null, b: SetRef | null): boolean {
  if (!a || !b) return false;
  return a.exerciseIndex === b.exerciseIndex && a.setIndex === b.setIndex;
}

/** Membership test for a round. Null ref is never a member. */
export function includesSet(list: SetRef[], ref: SetRef | null): boolean {
  if (!ref) return false;
  return list.some((s) => sameSet(s, ref));
}

/** Honest time under load. Floored at 1 so a very short set cannot go
 *  negative once the lag is deducted.
 *
 *  ROUNDS rather than truncates. This used to floor, on the reasoning that a
 *  set should not be credited with a second it did not complete — which is
 *  right about a single set and wrong about a session. Truncation only ever
 *  errs downward, so it compounds: ~0.5s per set of guaranteed one-directional
 *  loss, ~10s across a session, and it lands hardest on the short sets where
 *  it is the largest share. Rounding is unbiased, which is what a quantity
 *  that gets SUMMED needs to be. */
export function workSecondsFor(startAnchorMs: number, stopPressMs: number): number {
  const raw = Math.round((stopPressMs - startAnchorMs) / 1000) - PHONE_LAG_SECONDS;
  return Math.max(1, raw);
}

/** Rest is already PHONE_LAG_SECONDS old when the stop press registers. */
export function restSeedSeconds(prescribedRestSeconds: number): number {
  return Math.max(1, prescribedRestSeconds - PHONE_LAG_SECONDS);
}

/** Dumbbell swap, or the walk from the rack to the cable station, between two
 *  exercises of one superset. Deducted once per transition so it is not
 *  credited as time under load. */
export const SUPERSET_TRANSITION_SECONDS = 5;

/**
 * Time under load for each member of one superset round.
 *
 * A round is ONE continuous work interval covering N exercises — that
 * continuity is the point of the technique, so the athlete is not asked to tap
 * a hand-off. The per-member split is therefore an even estimate, not a
 * measurement, and the honest part is the total: the shares sum exactly to the
 * round's work time, which is what keeps the dock's WORK counter, the finish
 * summary's work:rest ratio and rest-between-rounds true.
 *
 * The odd remainder goes to the FIRST member rather than being dropped, for
 * that same reason. Each share is floored at 1 for the same reason
 * `workSecondsFor` floors — a set never records zero seconds.
 *
 * A one-member round is exactly `workSecondsFor`, so a solo exercise runs this
 * code path unchanged.
 */
export function splitRoundWork(
  startAnchorMs: number,
  stopPressMs: number,
  memberCount: number,
): number[] {
  const n = Math.max(1, memberCount);
  const raw =
    Math.floor((stopPressMs - startAnchorMs) / 1000)
    - PHONE_LAG_SECONDS
    - SUPERSET_TRANSITION_SECONDS * (n - 1);
  if (raw < n) return Array.from({ length: n }, () => 1);
  const share = Math.floor(raw / n);
  const remainder = raw - share * n;
  return Array.from({ length: n }, (_unused, i) => (i === 0 ? share + remainder : share));
}

/**
 * Seconds from the round's start to each member's start: the earlier members'
 * work plus one transition allowance apiece. LoggerSheet turns these into the
 * per-set `started_at` stamps, so `restBetweenSets` keeps measuring from a real
 * anchor rather than guessing.
 */
export function roundMemberStartOffsets(shares: number[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (let i = 0; i < shares.length; i++) {
    offsets.push(acc);
    acc += shares[i] + SUPERSET_TRANSITION_SECONDS;
  }
  return offsets;
}

export function timerReducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case "press_start": {
      // Starting a new set while one is mid-flight is not a thing the UI
      // offers (the circle reads STOP), so treat it as a no-op rather than
      // silently discarding an in-progress set's anchor.
      if (state.phase === "countdown" || state.phase === "running") return state;
      if (action.sets.length === 0) return state;
      return {
        phase: "countdown",
        anchorMs: action.nowMs,
        activeSets: action.sets,
        restSeconds: 0,
        // Caller persists any open entries BEFORE dispatching — see the
        // auto-save in LoggerSheet's handleTimerStart.
        pendingEntries: [],
      };
    }

    case "countdown_elapsed": {
      if (state.phase !== "countdown") return state;
      return { ...state, phase: "running", anchorMs: action.nowMs };
    }

    case "press_stop": {
      if (state.phase !== "running" || state.anchorMs === null || state.activeSets.length === 0) {
        return state;
      }
      const shares = splitRoundWork(state.anchorMs, action.nowMs, state.activeSets.length);
      return {
        phase: "rest",
        // Anchor at the rack, not the tap.
        anchorMs: action.nowMs - PHONE_LAG_SECONDS * 1000,
        activeSets: state.activeSets,
        restSeconds: restSeedSeconds(action.prescribedRestSeconds),
        pendingEntries: state.activeSets.map((s, i) => ({ ...s, workSeconds: shares[i] })),
      };
    }

    case "save_entry": {
      if (!state.pendingEntries.some((e) => sameSet(e, action.set))) return state;
      return {
        ...state,
        pendingEntries: state.pendingEntries.filter((e) => !sameSet(e, action.set)),
      };
    }

    case "clear_for_set": {
      // Un-committing or deleting ANY member of the round in play leaves
      // nothing coherent to stop or rest after, so the whole timer goes —
      // the same conservative rule the single-set machine applied.
      if (includesSet(state.activeSets, action.set)) return IDLE_TIMER;
      if (state.pendingEntries.some((e) => sameSet(e, action.set))) {
        return {
          ...state,
          pendingEntries: state.pendingEntries.filter((e) => !sameSet(e, action.set)),
        };
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
 * vanished target: if any member of the round in play (or being rested after)
 * is gone there is nothing left to stop or save for it, so drop the whole timer
 * rather than let it advance against a set that no longer exists. A member that
 * vanishes is dropped from the round; the timer only dies when every member is
 * gone.
 *
 * `mapSetIndex` returns the set's new index within `exerciseIndex`, or null if
 * it is gone. Refs in any OTHER exercise are untouched.
 */
export function remapTimerSets(
  state: TimerState,
  exerciseIndex: number,
  mapSetIndex: (oldIndex: number) => number | null,
): TimerState {
  if (state.activeSets.length === 0 && state.pendingEntries.length === 0) return state;

  const activeSets: SetRef[] = [];
  for (const ref of state.activeSets) {
    if (ref.exerciseIndex !== exerciseIndex) { activeSets.push(ref); continue; }
    const moved = mapSetIndex(ref.setIndex);
    if (moved !== null) activeSets.push({ ...ref, setIndex: moved });
  }
  // Every member of the round in play is gone: nothing left to stop or rest
  // after, so drop the timer rather than let it advance against sets that no
  // longer exist.
  if (state.activeSets.length > 0 && activeSets.length === 0) return IDLE_TIMER;

  const pendingEntries = state.pendingEntries.flatMap((e) => {
    if (e.exerciseIndex !== exerciseIndex) return [e];
    const moved = mapSetIndex(e.setIndex);
    return moved === null ? [] : [{ ...e, setIndex: moved }];
  });

  if (roundsUnchanged(state, activeSets, pendingEntries)) return state;
  return { ...state, activeSets, pendingEntries };
}

/**
 * Re-point the timer's stored refs after the exercise LIST changed under them.
 * The exercise-axis twin of `remapTimerSets`, and it lives beside it for that
 * reason — the two share a rule that is easy to get subtly different.
 *
 * `SetRef.exerciseIndex` is positional, so removing or reordering an exercise
 * silently re-aims every stored ref at whatever slid into the slot: STOP would
 * stamp `committed_at` / `work_seconds` onto a different exercise's set, and
 * `pendingEntries` would route the athlete's typed kg/reps there too.
 *
 * Same rule for a vanished target as its set-axis twin: a member whose exercise
 * is gone is dropped from the round; the timer only dies when every member is
 * gone.
 *
 * `mapIndex` returns the exercise's new index, or null if it is gone.
 */
export function remapTimerExercises(
  state: TimerState,
  mapIndex: (oldIndex: number) => number | null,
): TimerState {
  if (state.activeSets.length === 0 && state.pendingEntries.length === 0) return state;

  const activeSets: SetRef[] = [];
  for (const ref of state.activeSets) {
    const moved = mapIndex(ref.exerciseIndex);
    if (moved !== null) activeSets.push({ ...ref, exerciseIndex: moved });
  }
  // Every exercise holding a member of the round in play (or being rested
  // after) is gone. Nothing left to stop or save, so drop the timer rather than
  // let it advance to `rest` against sets that no longer exist.
  if (state.activeSets.length > 0 && activeSets.length === 0) return IDLE_TIMER;

  const pendingEntries = state.pendingEntries.flatMap((e) => {
    const moved = mapIndex(e.exerciseIndex);
    return moved === null ? [] : [{ ...e, exerciseIndex: moved }];
  });

  if (roundsUnchanged(state, activeSets, pendingEntries)) return state;
  return { ...state, activeSets, pendingEntries };
}

/**
 * Did a remap actually move anything?
 *
 * Both remaps run on EVERY list edit, including the common case of an edit
 * nowhere near the round in play. Returning `state` itself when nothing moved
 * keeps the timer object reference-equal, which is what lets the memo on
 * ExerciseCard skip re-rendering every other card in the session. The
 * single-set machine got this for free by mutating a `next` cursor only on a
 * real move; building fresh arrays loses it unless it is asserted here.
 */
function roundsUnchanged(
  state: TimerState,
  activeSets: SetRef[],
  pendingEntries: (SetRef & { workSeconds: number })[],
): boolean {
  if (activeSets.length !== state.activeSets.length) return false;
  if (pendingEntries.length !== state.pendingEntries.length) return false;
  return (
    activeSets.every((s, i) => sameSet(s, state.activeSets[i]))
    && pendingEntries.every((e, i) => sameSet(e, state.pendingEntries[i]))
  );
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

/**
 * m:ss for every timer display in the logger. Signed, because rest overtime is
 * rendered as a negative counter — positives are unaffected, so this is safe
 * for the committed-row stamps and the finish summary too.
 *
 * Four near-identical copies of this existed (SetTimerDock, SetRow,
 * SetEntryRow, FinishSummary); only the dock's handled the minus sign, so the
 * one place a negative could reach was also the only place it read correctly.
 */
export function formatMmSs(totalSeconds: number): string {
  const neg = totalSeconds < 0;
  const s = Math.abs(Math.floor(totalSeconds));
  return `${neg ? "\u2212" : ""}${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}
