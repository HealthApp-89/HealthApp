// lib/logger/draft-ops.ts
//
// Pure operations on a LoggerDraft. These used to live inside
// components/logger/LoggerSheet.tsx, where vitest could not reach them — this
// repo's test config is node-environment and scans `lib/**/__tests__` only, so
// anything in a .tsx file is untestable by construction. Two of them carry
// real rules (`commitEntries`, behind both commitPendingEntry/-Entries, decides
// when a time-based set records its duration; `keepUnmovedRestOverrides` keeps
// two copies of a value in sync),
// and both produced bugs while they were unreachable by tests.
//
// Every function here is pure: no React, no I/O, and no clock reads. Callers
// that need a timestamp pass one in, which is also what makes them safe to run
// inside a `setDraft` updater — React may invoke those more than once per
// commit (StrictMode double-invokes them), so reading the wall clock inside
// one is a Rules-of-React violation.
//
// Timer-state-only helpers (`timerReducer`, `remapTimerSets`,
// `remapTimerExercises`, …) live in ./set-timer, which deliberately has zero
// imports. This module is the layer above: it knows about LoggerDraft.

import type { LoggerDraft, ExerciseSetDraft } from "@/lib/logger/types";
import {
  IDLE_TIMER,
  timerReducer,
  sameSet,
  type TimerState,
  type SetRef,
} from "@/lib/logger/set-timer";
import { annotateSession } from "@/lib/coach/session-structure/annotate";

/** The draft's timer, or the idle state for a draft written before timing. */
export function timerOf(draft: LoggerDraft | null): TimerState {
  return draft?.timer ?? IDLE_TIMER;
}

/** Apply a timer state to the draft and stamp it. `nowIso` is a parameter so
 *  this stays callable from inside a setDraft updater. */
export function withTimer(
  draft: LoggerDraft,
  next: TimerState,
  nowIso: string,
): LoggerDraft {
  return { ...draft, timer: next, updated_at: nowIso };
}

/** Commit the entry row for ONE member of the open round. Called by that
 *  row's Save button; the other members' rows stay open and rest keeps
 *  running underneath. */
export function commitPendingEntry(
  draft: LoggerDraft,
  ref: SetRef,
  nowIso: string,
): LoggerDraft {
  const timer = draft.timer ?? IDLE_TIMER;
  const entry = timer.pendingEntries.find((e) => sameSet(e, ref));
  if (!entry) return draft;
  return commitEntries(draft, [entry], nowIso);
}

/** Commit EVERY open entry row. The exit paths use this — pressing START on
 *  the next round, Finish, and Pause & close — because none of them may
 *  silently drop a set the athlete has already performed. */
export function commitPendingEntries(draft: LoggerDraft, nowIso: string): LoggerDraft {
  const timer = draft.timer ?? IDLE_TIMER;
  if (timer.pendingEntries.length === 0) return draft;
  return commitEntries(draft, timer.pendingEntries, nowIso);
}

/**
 * Commit the given entry rows and close them. Reached from the Save button and,
 * implicitly, by pressing START on the next round and by Finish — the fields
 * are pre-filled from the prescription, so the flow never blocks on typing, and
 * no exit path may silently drop the set.
 *
 * Touches no clock beyond the `nowIso` handed in: `save_entry` clears only the
 * entries named here and leaves the rest countdown running underneath, which is
 * the whole point of splitting commit out of stop.
 */
function commitEntries(
  draft: LoggerDraft,
  entries: (SetRef & { workSeconds: number })[],
  nowIso: string,
): LoggerDraft {
  let exercises = draft.exercises;
  for (const entry of entries) {
    exercises = exercises.map((ex, ei) =>
      ei !== entry.exerciseIndex ? ex : {
        ...ex,
        sets: ex.sets.map((s, si): ExerciseSetDraft => {
          if (si !== entry.setIndex || s.committed_at) return s;
          // A time-based set auto-saved by START never had its seconds field
          // blurred, so it would commit `duration_seconds: null` alongside a
          // perfectly good `work_seconds` — the plank the timer measured at 45s
          // recorded as no plank at all. SetEntryRow's saveAll already flushes
          // the field on the Save path; this makes the auto-save path agree,
          // using the number the timer measured as the fallback.
          const timeBased = ex.prescribed.duration_seconds != null;
          return {
            ...s,
            duration_seconds: timeBased && s.duration_seconds == null
              ? entry.workSeconds
              : s.duration_seconds,
            committed_at: nowIso,
          };
        }),
      },
    );
  }
  let timer = draft.timer ?? IDLE_TIMER;
  for (const entry of entries) {
    timer = timerReducer(timer, { type: "save_entry", set: entry });
  }
  return { ...draft, exercises, timer };
}

/**
 * Drop rest overrides for every exercise whose index moved.
 *
 * `restOverrides` is the LIFTED half of a value ExerciseCard also holds
 * locally. The card's `key` embeds its index, so any index change remounts it
 * and resets the local copy to "no override". Remapping the lifted copy instead
 * of dropping it would leave the two disagreeing — the "+ Add set (m:ss)" label
 * showing the prescription while `press_stop` seeds rest from the override.
 * Keeping only the entries whose card did NOT remount makes them agree by
 * construction. (Keying by exercise name would not: the card still remounts.)
 *
 * Covers the list edits that MOVE indices — Remove and Reorder. Replace is the
 * third remount trigger and cannot be expressed as an index map: the index is
 * unchanged, but the card's `key` embeds `ex.name`, so swapping the name
 * remounts it just the same, and the surviving override would then belong to a
 * DIFFERENT exercise. The replace branch deletes its own entry outright.
 */
export function keepUnmovedRestOverrides(
  overrides: Record<number, number>,
  mapIndex: (oldIndex: number) => number | null,
): Record<number, number> {
  const next: Record<number, number> = {};
  for (const [k, v] of Object.entries(overrides)) {
    const i = Number(k);
    if (mapIndex(i) === i) next[i] = v;
  }
  return next;
}

/** Prescribed rest for an exercise, from the same session-structure annotation
 *  ExerciseCard shows. Read at `press_stop` time so an override applied
 *  mid-session is picked up. */
export function annotatedRestFor(draft: LoggerDraft, exerciseIndex: number): number {
  const list = draft.exercises.map((e) => e.prescribed);
  const s = annotateSession(list);
  return s.exercises[exerciseIndex]?.rest_seconds.min ?? 120;
}

/**
 * First set in draft order with no `committed_at`. Null once every set is
 * committed — the dock then disables its START affordance rather than
 * dispatching a start for a set that does not exist.
 *
 * `skip` is a LIST because a superset round opens one entry row per member,
 * so more than one set can be uncommitted-but-finished at the same moment.
 *
 * `skip` is the set with the zoomed entry row open. That set is uncommitted
 * until Save, so without skipping it START would offer to re-run the set the
 * athlete just finished — and the caller commits the entry first, so it would
 * count down to a set it had itself just committed.
 */
export function firstPendingSet(draft: LoggerDraft, skip: SetRef[]): SetRef | null {
  for (let ei = 0; ei < draft.exercises.length; ei++) {
    const sets = draft.exercises[ei].sets;
    for (let si = 0; si < sets.length; si++) {
      const ref = { exerciseIndex: ei, setIndex: si };
      if (!sets[si].committed_at && !skip.some((s) => sameSet(ref, s))) return ref;
    }
  }
  return null;
}

// NOTE: summing committed work_seconds lives in ./set-timer as
// `totalWorkSeconds(exercises)` and already has both callers (the dock's WORK
// counter and the finish summary's ratio). Do not add a draft-shaped wrapper
// here — a second copy of that filter is exactly how the two surfaces would
// drift apart.
