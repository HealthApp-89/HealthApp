// lib/logger/draft-ops.ts
//
// Pure operations on a LoggerDraft. These used to live inside
// components/logger/LoggerSheet.tsx, where vitest could not reach them — this
// repo's test config is node-environment and scans `lib/**/__tests__` only, so
// anything in a .tsx file is untestable by construction. `commitEntries`,
// behind both commitPendingEntry/-Entries, carries a real rule — when a
// time-based set records its duration — and produced bugs while it was
// unreachable by tests.
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
import { TRANSITION_BUFFER_SECONDS } from "@/lib/coach/session-structure/rules";

/** The single-set timer shape this module still has to read. Not exported and
 *  deliberately not part of `TimerState` any more — it only exists on drafts
 *  written by a build that predates the round refactor. */
type LegacyTimerState = {
  phase?: unknown;
  anchorMs?: unknown;
  restSeconds?: unknown;
  activeSet?: SetRef | null;
  pendingEntry?: (SetRef & { workSeconds: number }) | null;
};

const TIMER_PHASES = new Set(["idle", "countdown", "running", "rest"]);

/**
 * The draft's timer, or the idle state for a draft written before timing.
 *
 * Also a READ-TIME SHIM for the pre-round timer shape. `LoggerDraft.timer` is
 * persisted to IndexedDB with a 12h TTL, so it outlives a deploy: a draft
 * written by the previous build carries `activeSet` / `pendingEntry`, while
 * every reader now indexes `activeSets` / `pendingEntries`. Reading `.length`
 * off `undefined` throws, so an athlete resuming a session across the deploy
 * would crash the logger instead of resuming it.
 *
 * Narrow on purpose — one legacy shape, one target shape, and anything matching
 * neither falls back to IDLE_TIMER rather than being guessed at. This is not a
 * migration framework and must not grow into one; delete it once no draft
 * written before the round refactor can still be within its TTL.
 */
export function timerOf(draft: LoggerDraft | null): TimerState {
  const t = draft?.timer;
  if (!t) return IDLE_TIMER;
  // Already the round shape: hand back the SAME object. Callers compare timer
  // identity to decide whether a memoized ExerciseCard can skip a re-render.
  if (Array.isArray(t.activeSets) && Array.isArray(t.pendingEntries)) return t;

  const legacy = t as unknown as LegacyTimerState;
  if (typeof legacy.phase !== "string" || !TIMER_PHASES.has(legacy.phase)) return IDLE_TIMER;
  return {
    phase: legacy.phase as TimerState["phase"],
    anchorMs: typeof legacy.anchorMs === "number" ? legacy.anchorMs : null,
    activeSets: legacy.activeSet ? [legacy.activeSet] : [],
    restSeconds: typeof legacy.restSeconds === "number" ? legacy.restSeconds : 0,
    pendingEntries: legacy.pendingEntry ? [legacy.pendingEntry] : [],
  };
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
  const timer = timerOf(draft);
  const entry = timer.pendingEntries.find((e) => sameSet(e, ref));
  if (!entry) return draft;
  return commitEntries(draft, [entry], nowIso);
}

/** Commit EVERY open entry row. The exit paths use this — pressing START on
 *  the next round, Finish, and Pause & close — because none of them may
 *  silently drop a set the athlete has already performed. */
export function commitPendingEntries(draft: LoggerDraft, nowIso: string): LoggerDraft {
  const timer = timerOf(draft);
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
  // Via timerOf, not `draft.timer`, so a legacy-shaped timer is normalised
  // before the reducer indexes its lists.
  let timer = timerOf(draft);
  for (const entry of entries) {
    timer = timerReducer(timer, { type: "save_entry", set: entry });
  }
  return { ...draft, exercises, timer };
}

/** Prescribed rest for an exercise, from the same session-structure annotation
 *  ExerciseCard shows. The athlete's manual override is NOT applied here —
 *  callers check `exercise.rest_override_seconds` first, which is where the
 *  single copy of that value lives. */
export function annotatedRestFor(draft: LoggerDraft, exerciseIndex: number): number {
  const list = draft.exercises.map((e) => e.prescribed);
  const s = annotateSession(list);
  return s.exercises[exerciseIndex]?.rest_seconds ?? 120;
}

/**
 * Rest to take BEFORE starting the exercise at `exerciseIndex` — the walk
 * between two exercises, not the gap between two sets of one.
 *
 * Null when no transition applies: the session's first exercise has nothing
 * before it, a warm-up ramp IS the transition, and an out-of-range index has
 * no prescription to read. The annotation decides that, so an override can
 * never resurrect a transition that does not apply.
 *
 * When the athlete has overridden rest on the INCOMING exercise, that choice
 * wins and the setup buffer is added to it. Deriving the walk from a
 * prescription the athlete has explicitly overruled would contradict them: a
 * lifter who cuts rest to 60s to get through a session is not asking for a
 * five-minute stroll to the next rack.
 */
export function transitionRestFor(
  draft: LoggerDraft,
  exerciseIndex: number,
): number | null {
  const list = draft.exercises.map((e) => e.prescribed);
  const annotated = annotateSession(list).exercises[exerciseIndex];
  if (!annotated || annotated.transition_seconds == null) return null;
  const override = draft.exercises[exerciseIndex]?.rest_override_seconds;
  return override != null
    ? override + TRANSITION_BUFFER_SECONDS
    : annotated.transition_seconds;
}

/**
 * The rest to seed when the round named by `activeSets` is stopped, IF that
 * round finishes its exercise and another exercise follows. Null otherwise —
 * the caller then falls back to ordinary inter-set rest.
 *
 * A round ends an exercise only when EVERY member is on its exercise's final
 * set. For a superset pair that means both members: stopping a round where one
 * partner still has sets left is mid-exercise, however finished the other is.
 *
 * The next exercise is the one after the round's LAST member, so a pair hands
 * off to whatever follows the pair rather than to its own second member.
 */
export function transitionAfterRound(
  draft: LoggerDraft,
  activeSets: SetRef[],
): number | null {
  if (activeSets.length === 0) return null;
  // A finished warm-up ramp hands off to its own working sets — same bar, same
  // rack, nothing to walk to. The last warm-up's own rest (bumped to
  // REST_SECONDS.lastWarmup by annotateSession) is the number that governs
  // that hand-off; charging a full walk-in here would override it and stand
  // the athlete around for five minutes before the set the ramp just prepared.
  if (activeSets.every((r) => draft.exercises[r.exerciseIndex]?.sets[r.setIndex]?.warmup)) {
    return null;
  }
  const endsExercise = activeSets.every((r) => {
    const ex = draft.exercises[r.exerciseIndex];
    return ex != null && r.setIndex === ex.sets.length - 1;
  });
  if (!endsExercise) return null;
  const nextIndex = Math.max(...activeSets.map((r) => r.exerciseIndex)) + 1;
  return transitionRestFor(draft, nextIndex);
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
