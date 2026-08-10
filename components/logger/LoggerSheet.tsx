"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { LoggerDraft, ExerciseDraft, CommitSessionPayload } from "@/lib/logger/types";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadDraft, saveDraft, clearDraft } from "@/lib/logger/draft-store";
import { useWakeLock } from "@/lib/logger/rest-timer";
import { seedRir } from "@/lib/logger/seed-rir";
import { useLiveSessionContext } from "@/lib/query/hooks/useLiveSessionContext";
import { annotateSession } from "@/lib/coach/session-structure/annotate";
import { fmtNum } from "@/lib/ui/score";
import {
  IDLE_TIMER,
  timerReducer,
  workSecondsFor,
  getElapsedMs,
  type TimerState,
  type SetRef,
} from "@/lib/logger/set-timer";
import { SetTimerDock } from "@/components/logger/SetTimerDock";
import { ExerciseCard } from "@/components/logger/ExerciseCard";
import { ExercisePicker } from "@/components/logger/ExercisePicker";
import { ResumeDraftPrompt } from "@/components/logger/ResumeDraftPrompt";
import { SaveAsDefaultDialog } from "@/components/logger/SaveAsDefaultDialog";
import { FinishSummary } from "@/components/logger/FinishSummary";
import { ReorderDialog } from "@/components/logger/ReorderDialog";
import { queryKeys } from "@/lib/query/keys";

type Props = {
  userId: string;
  sessionType: string;
  date: string;            // YYYY-MM-DD
  weekdayLong: string;     // "Monday"
  weekOverrides: Record<string, PlannedExercise[]> | null;
  weekPrescriptions?: import("@/lib/data/types").SessionPrescriptions | null;
  manualEdits?: import("@/lib/data/types").ManualSessionEdits | null;
  onClose: () => void;
  /** When set, LoggerSheet boots in edit mode: seeds state from initialDraft,
   *  skips draft-store reads/writes, hides timer controls. */
  editMode?: { initialDraft: LoggerDraft };
  /** Week-level prescribed RIR (training_weeks.rir_target). Seeds new working
   *  sets so effort is captured by default; athlete edits per set on deviation.
   *  Defaults to 2 (the engine's RP/Helms hypertrophy default) when absent. */
  weekRirTarget?: number | null;
};

function makeDraftFromPlan(args: {
  userId: string;
  sessionType: string;
  date: string;
  plan: PlannedExercise[];
  weekRirTarget: number | null;
}): LoggerDraft {
  const externalId = `logger-${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const exercises: ExerciseDraft[] = args.plan.map((p, i) => ({
    name: p.name,
    position: i,
    prescribed: p,
    sets: Array.from({ length: p.sets ?? 1 }, (_unused, j) => ({
      set_index: j,
      kg: p.duration_seconds != null ? null : (p.baseKg ?? null),
      reps: null,
      duration_seconds: null,
      warmup: !!p.warmup && j === 0,
      failure: false,
      // warmups and duration-based exercises carry no RIR
      rir: (!!p.warmup && j === 0) || p.duration_seconds != null
        ? null
        : seedRir(p, args.weekRirTarget),
      committed_at: null,
    })),
  }));
  return {
    user_id: args.userId,
    session_type: args.sessionType,
    date: args.date,
    started_at: nowIso,
    updated_at: nowIso,
    paused_at: null,
    paused_ms_total: 0,
    exercises,
    resolved_plan: args.plan,
    external_id: externalId,
    timer: null,
  };
}

// ---------------------------------------------------------------------------
// Session timer helpers
//
// Timer state lives ON THE DRAFT, not in component state, so it is mirrored to
// IndexedDB with everything else and a reload mid-set resumes exactly (the
// anchors are absolute epoch ms). Nothing that ticks is ever passed into the
// memoized ExerciseCards — only the phase-transition state and stable
// callbacks. SetTimerDock owns the tick and reads the wall clock itself.
// ---------------------------------------------------------------------------

function timerOf(draft: LoggerDraft | null): TimerState {
  return draft?.timer ?? IDLE_TIMER;
}

/** Apply a timer action and persist it with the draft. */
function withTimer(draft: LoggerDraft, next: TimerState): LoggerDraft {
  return { ...draft, timer: next, updated_at: new Date().toISOString() };
}

/**
 * Persist the zoomed entry row's in-flight values onto the draft before the
 * next set starts. Task 6 fills this in.
 */
function commitPendingEntry(draft: LoggerDraft): LoggerDraft {
  return draft;
}

/**
 * Re-point the timer's stored refs after the exercise LIST changed under them.
 *
 * `SetRef.exerciseIndex` is positional, so removing or reordering an exercise
 * silently re-aims every stored ref at whatever slid into that slot: STOP would
 * stamp `committed_at` / `work_seconds` onto a different exercise's set. Both
 * refs are remapped — `pendingEntry` carries the same shape (Task 6 reads it).
 *
 * `mapIndex` returns the exercise's new index, or null if it is gone.
 */
function remapTimerExercises(
  state: TimerState,
  mapIndex: (oldIndex: number) => number | null,
): TimerState {
  if (state.activeSet === null && state.pendingEntry === null) return state;
  let next = state;

  if (next.activeSet) {
    const moved = mapIndex(next.activeSet.exerciseIndex);
    // The exercise holding the set in play (or being rested after) is gone.
    // There is nothing left to stop or save, so drop the timer entirely rather
    // than let it advance to `rest` against a set that no longer exists.
    if (moved === null) return IDLE_TIMER;
    if (moved !== next.activeSet.exerciseIndex) {
      next = { ...next, activeSet: { ...next.activeSet, exerciseIndex: moved } };
    }
  }

  if (next.pendingEntry) {
    const moved = mapIndex(next.pendingEntry.exerciseIndex);
    if (moved === null) {
      next = { ...next, pendingEntry: null };
    } else if (moved !== next.pendingEntry.exerciseIndex) {
      next = { ...next, pendingEntry: { ...next.pendingEntry, exerciseIndex: moved } };
    }
  }

  return next;
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
 */
function keepUnmovedRestOverrides(
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
function annotatedRestFor(draft: LoggerDraft, exerciseIndex: number): number {
  const list = draft.exercises.map((e) => e.prescribed);
  const s = annotateSession(list);
  return s.exercises[exerciseIndex]?.rest_seconds.min ?? 120;
}

/** First set in draft order with no `committed_at`. Null once every set is
 *  committed — the dock then disables its START affordance rather than
 *  dispatching a start for a set that does not exist. */
function firstPendingSet(draft: LoggerDraft): SetRef | null {
  for (let ei = 0; ei < draft.exercises.length; ei++) {
    const sets = draft.exercises[ei].sets;
    for (let si = 0; si < sets.length; si++) {
      if (!sets[si].committed_at) return { exerciseIndex: ei, setIndex: si };
    }
  }
  return null;
}

/** Dock captions for a set ref: which set is in play and what it asks for. */
function describeSet(
  draft: LoggerDraft,
  ref: SetRef | null,
): { activeLabel: string; targetLabel: string } {
  if (!ref) return { activeLabel: "All sets committed", targetLabel: "tap Finish when done" };
  const ex = draft.exercises[ref.exerciseIndex];
  const set = ex?.sets[ref.setIndex];
  if (!ex || !set) return { activeLabel: draft.session_type, targetLabel: "" };
  const which = set.warmup
    ? "warm-up"
    : `set ${ex.sets.slice(0, ref.setIndex).filter((s) => !s.warmup).length + 1}`;
  const p = ex.prescribed;
  const targetLabel = p.duration_seconds != null
    ? `${p.duration_seconds}s`
    : [
        p.baseKg != null ? `${fmtNum(p.baseKg)} kg` : "BW",
        p.baseReps != null ? `× ${p.baseReps}` : null,
        p.rir != null ? `@ RIR ${p.rir}` : null,
      ].filter(Boolean).join(" ");
  return { activeLabel: `${ex.name} · ${which}`, targetLabel };
}

/** Wipe all entered sets + timer state, keep the current exercise list. */
function resetDraft(draft: LoggerDraft, weekRirTarget: number | null): LoggerDraft {
  const nowIso = new Date().toISOString();
  return {
    ...draft,
    started_at: nowIso,
    updated_at: nowIso,
    paused_at: null,
    paused_ms_total: 0,
    timer: null,
    exercises: draft.exercises.map((ex) => ({
      ...ex,
      sets: Array.from({ length: ex.prescribed.sets ?? 1 }, (_unused, j) => ({
        set_index: j,
        kg: ex.prescribed.duration_seconds != null ? null : (ex.prescribed.baseKg ?? null),
        reps: null,
        duration_seconds: null,
        warmup: !!ex.prescribed.warmup && j === 0,
        failure: false,
        // Same seed as a fresh draft (see seedRir). Reset used to blank RIR,
        // which silently switched the between-sets load call off for the rest
        // of the session — it requires a recorded RIR and cannot tell a blank
        // from "not yet reached".
        rir: (!!ex.prescribed.warmup && j === 0) || ex.prescribed.duration_seconds != null
          ? null
          : seedRir(ex.prescribed, weekRirTarget),
        committed_at: null,
      })),
    })),
  };
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Isolated elapsed-time display. Owns its own per-second tick so it never
 * triggers a re-render of the parent LoggerSheet or the exercise list.
 */
function ElapsedTimer({
  startedAt,
  pausedAt,
  pausedMsTotal,
  sessionType,
}: {
  startedAt: string;
  pausedAt: string | null;
  pausedMsTotal: number;
  sessionType: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const isPaused = !!pausedAt;

  useEffect(() => {
    if (isPaused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isPaused]);

  const elapsedMs = getElapsedMs(
    { started_at: startedAt, paused_at: pausedAt, paused_ms_total: pausedMsTotal },
    now,
  );
  const label = formatElapsed(elapsedMs);

  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${isPaused ? "bg-yellow-500" : "bg-green-500"}`}></span>
      <span className="font-mono tabular-nums">{label}</span>
      <span>· {sessionType}</span>
    </div>
  );
}

function hasFirstCommit(draft: LoggerDraft) {
  for (const ex of draft.exercises) {
    for (const s of ex.sets) {
      if (s.committed_at) return true;
    }
  }
  return false;
}

function exerciseListDiverged(draft: LoggerDraft): boolean {
  const resolvedNames = draft.resolved_plan.map((e) => e.name).sort();
  const currentNames = draft.exercises.map((e) => e.name).sort();
  if (resolvedNames.length !== currentNames.length) return true;
  for (let i = 0; i < resolvedNames.length; i++) {
    if (resolvedNames[i] !== currentNames[i]) return true;
  }
  // Also count: prescribed set count differences imply structural divergence.
  for (let i = 0; i < draft.exercises.length; i++) {
    const cur = draft.exercises[i];
    const original = draft.resolved_plan.find((p) => p.name === cur.name);
    if (!original) return true;
    if ((original.sets ?? 1) !== cur.sets.length) return true;
  }
  return false;
}

export function LoggerSheet(props: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [draft, setDraft] = useState<LoggerDraft | null>(null);
  const [resumePrompt, setResumePrompt] = useState<LoggerDraft | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"add" | { replace_index: number }>("add");
  const [saveDefaultOpen, setSaveDefaultOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [resolvedSource, setResolvedSource] = useState<string | null>(null);
  /** Per-exercise rest override, lifted out of ExerciseCard so `press_stop`
   *  can seed the session-level rest countdown with it. */
  const [restOverrides, setRestOverrides] = useState<Record<number, number>>({});

  useWakeLock(!!draft);

  // 1) Mount: load existing draft or build from resolved plan.
  //    Resume prompt shows whenever the close path preserved a draft (it sets
  //    paused_at) or there are committed sets. Truly-empty open/close cycles
  //    are auto-discarded by handleClose so they don't show here.
  useEffect(() => {
    if (props.editMode) {
      setDraft(props.editMode.initialDraft);
      return;
    }
    let cancelled = false;
    (async () => {
      const existing = await loadDraft(props.userId, props.sessionType);
      if (cancelled) return;
      if (existing && (hasFirstCommit(existing) || existing.paused_at !== null)) {
        setResumePrompt(existing);
        return;
      }
      const resolved = await resolveSessionPlan({
        supabase,
        userId: props.userId,
        sessionType: props.sessionType,
        weekdayLong: props.weekdayLong,
        weekOverrides: props.weekOverrides ?? null,
        weekPrescriptions: props.weekPrescriptions ?? null,
        manualEdits: props.manualEdits ?? null,
      });
      if (cancelled) return;
      setResolvedSource(resolved.source);
      const fresh = makeDraftFromPlan({
        userId: props.userId,
        sessionType: props.sessionType,
        date: props.date,
        plan: resolved.exercises,
        weekRirTarget: props.weekRirTarget ?? 2,
      });
      setDraft(fresh);
    })().catch((e) => console.error("LoggerSheet mount failed", e));
    return () => { cancelled = true; };
  }, [props.userId, props.sessionType, props.date, props.weekdayLong, props.weekOverrides, supabase, props.editMode]);

  // 2) Mirror to IndexedDB on every change.
  useEffect(() => {
    if (!draft) return;
    if (props.editMode) return;       // edit mode: no draft persistence
    const updated = { ...draft, updated_at: new Date().toISOString() };
    void saveDraft(updated);
  }, [draft, props.editMode]);

  // Stable callbacks for ExerciseCard — use functional setDraft so they don't
  // close over the draft snapshot and stay reference-equal across renders.
  // React.memo on ExerciseCard then skips re-renders caused by unrelated state.
  //
  // These MUST be declared before any early return below: `draft` starts null
  // and loads async, so the first render takes the `if (!draft)` guard. Hooks
  // placed after that guard run on only some renders → React error #310
  // (changed hook order). See lib/logger/__tests__/hook-order.test.ts.
  const handleExerciseChange = useCallback((index: number, next: ExerciseDraft) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, exercises: prev.exercises.map((e, j) => j === index ? next : e) };
    });
  }, []);

  const handleExerciseRemove = useCallback((index: number) => {
    // Everything after the removed exercise shifts down one slot, so the
    // timer's refs and the lifted rest overrides have to move with it.
    const mapIndex = (i: number) => (i === index ? null : i > index ? i - 1 : i);
    setRestOverrides((prev) => keepUnmovedRestOverrides(prev, mapIndex));
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        exercises: prev.exercises.filter((_, j) => j !== index),
        timer: remapTimerExercises(timerOf(prev), mapIndex),
      };
    });
  }, []);

  const handleExerciseReplace = useCallback((index: number) => {
    setPickerMode({ replace_index: index });
    setPickerOpen(true);
  }, []);

  const handleReorderAll = useCallback(() => {
    setReorderOpen(true);
  }, []);

  // --- Timer handlers. All use functional setDraft so they stay reference-
  // stable and the memo on ExerciseCard is not defeated. They also live above
  // the `!draft` early return, same hook-order rule as the callbacks above.

  const handleTimerStart = useCallback((set: SetRef) => {
    setDraft((prev) => {
      if (!prev) return prev;
      // Auto-save any open entry first: the fields are pre-filled from the
      // prescription, so the athlete can start the next set without ever
      // touching them and nothing is lost.
      const withEntrySaved = commitPendingEntry(prev);
      return withTimer(
        withEntrySaved,
        timerReducer(timerOf(withEntrySaved), { type: "press_start", set, nowMs: Date.now() }),
      );
    });
  }, []);

  const handleCountdownElapsed = useCallback(() => {
    setDraft((prev) => {
      if (!prev) return prev;
      const nowMs = Date.now();
      const next = timerReducer(timerOf(prev), { type: "countdown_elapsed", nowMs });
      if (next === timerOf(prev)) return prev;
      // Stamp the true set start on the draft set itself.
      const ref = next.activeSet;
      if (!ref) return withTimer(prev, next);
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== ref.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== ref.setIndex ? s : { ...s, started_at: new Date(nowMs).toISOString() },
          ),
        },
      );
      return withTimer({ ...prev, exercises }, next);
    });
  }, []);

  const handleStop = useCallback(() => {
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = timerOf(prev);
      const ref = cur.activeSet;
      if (cur.phase !== "running" || !ref || cur.anchorMs === null) return prev;
      const nowMs = Date.now();
      const workSeconds = workSecondsFor(cur.anchorMs, nowMs);
      const prescribedRest =
        restOverrides[ref.exerciseIndex]
        ?? annotatedRestFor(prev, ref.exerciseIndex);
      const next = timerReducer(cur, { type: "press_stop", nowMs, prescribedRestSeconds: prescribedRest });
      // Task 5 commits straight away; Task 6 moves this into the zoom's Save.
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== ref.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== ref.setIndex ? s : {
              ...s,
              work_seconds: workSeconds,
              committed_at: new Date(nowMs).toISOString(),
            },
          ),
        },
      );
      return withTimer({ ...prev, exercises }, timerReducer(next, { type: "save_entry" }));
    });
  }, [restOverrides]);

  const handleSetCleared = useCallback((set: SetRef) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== set.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== set.setIndex ? s : { ...s, started_at: null, work_seconds: null },
          ),
        },
      );
      return withTimer({ ...prev, exercises }, timerReducer(timerOf(prev), { type: "clear_for_set", set }));
    });
  }, []);

  const handleRestOverrideChange = useCallback((exerciseIndex: number, seconds: number) => {
    setRestOverrides((prev) => ({ ...prev, [exerciseIndex]: seconds }));
  }, []);

  /** Total honest time under load so far — the dock's WORK counter. */
  const workSecondsTotal = useMemo(() => {
    if (!draft) return 0;
    let total = 0;
    for (const ex of draft.exercises) {
      for (const s of ex.sets) {
        if (s.committed_at && s.work_seconds != null) total += s.work_seconds;
      }
    }
    return total;
  }, [draft]);

  // Between-sets coaching context. Fetched once (staleTime: Infinity) as soon
  // as we know which exercises are in play. Must stay above the early
  // `!draft` return below — draft starts null and loads async, so the first
  // render takes that guard, and a hook placed after it would run on only
  // some renders (React error #310, see the comment above handleExerciseChange).
  const exerciseNames = useMemo(
    () => (draft ? draft.exercises.map((e) => e.name) : []),
    [draft],
  );
  const liveContext = useLiveSessionContext(props.userId, props.date, exerciseNames);

  const isPaused = !!draft?.paused_at;

  if (resumePrompt && !draft) {
    return (
      <ResumeDraftPrompt
        draft={resumePrompt}
        onResume={() => {
          // If the draft is paused (typical — close auto-pauses), unpause and
          // fold the closed-window into paused_ms_total so elapsed picks up
          // where it left off.
          if (resumePrompt.paused_at) {
            const pausedMs = Date.now() - new Date(resumePrompt.paused_at).getTime();
            setDraft({
              ...resumePrompt,
              paused_at: null,
              paused_ms_total: resumePrompt.paused_ms_total + pausedMs,
            });
          } else {
            setDraft(resumePrompt);
          }
          setResumePrompt(null);
        }}
        onDiscard={async () => {
          await clearDraft(props.userId, props.sessionType);
          setResumePrompt(null);
          // Re-mount path: build fresh.
          const resolved = await resolveSessionPlan({
            supabase, userId: props.userId, sessionType: props.sessionType,
            weekdayLong: props.weekdayLong, weekOverrides: props.weekOverrides ?? null,
            weekPrescriptions: props.weekPrescriptions ?? null,
            manualEdits: props.manualEdits ?? null,
          });
          setResolvedSource(resolved.source);
          setDraft(makeDraftFromPlan({
            userId: props.userId, sessionType: props.sessionType,
            date: props.date, plan: resolved.exercises,
            weekRirTarget: props.weekRirTarget ?? 2,
          }));
        }}
      />
    );
  }

  if (!draft) {
    return <div className="fixed inset-0 bg-black/90 flex items-center justify-center text-zinc-500">Loading…</div>;
  }

  const diverged = exerciseListDiverged(draft);
  const timer = timerOf(draft);
  const midSet = timer.phase === "countdown" || timer.phase === "running";
  // What START dispatches. During `rest`, timer.activeSet is the set just
  // FINISHED, so the next set always comes from the pending scan.
  const nextSetRef = firstPendingSet(draft);
  const anyDialogOpen =
    pickerOpen || reorderOpen || saveDefaultOpen || finishOpen
    || closeConfirmOpen || resetConfirmOpen;
  // What the caption describes: the set in play mid-set, otherwise the next one.
  const { activeLabel, targetLabel } = describeSet(draft, midSet ? timer.activeSet : nextSetRef);

  function togglePause() {
    if (!draft) return;
    if (draft.paused_at) {
      // Resume: fold the just-completed pause interval into paused_ms_total.
      const pausedMs = Date.now() - new Date(draft.paused_at).getTime();
      setDraft({
        ...draft,
        paused_at: null,
        paused_ms_total: draft.paused_ms_total + pausedMs,
      });
    } else {
      setDraft({ ...draft, paused_at: new Date().toISOString() });
    }
  }

  function requestClose() {
    if (!draft) { props.onClose(); return; }
    const elapsed = getElapsedMs(draft, Date.now());
    // Truly-empty open/close: skip the confirm — nothing to lose.
    if (!hasFirstCommit(draft) && !draft.paused_at && elapsed < 10_000) {
      void clearDraft(draft.user_id, draft.session_type);
      props.onClose();
      return;
    }
    setCloseConfirmOpen(true);
  }

  function pauseAndClose() {
    if (!draft) { props.onClose(); return; }
    const cur = timerOf(draft);
    // An in-flight set must NOT survive the close. Pause is disabled mid-set,
    // but Close is one tap and auto-pauses here; the draft would persist
    // phase:"running" with its original absolute anchorMs, and resuming hours
    // later (within the 12h TTL) would let STOP stamp the entire gap as
    // work_seconds — which Task 7 writes to the DB, poisoning restBetweenSets,
    // the debrief, and rest-discipline math. The set was never committed, so
    // abandoning it is correct: the athlete restarts it on resume.
    const nextTimer = cur.phase === "countdown" || cur.phase === "running"
      ? timerReducer(cur, { type: "reset" })
      : cur;
    setDraft({
      ...draft,
      timer: nextTimer,
      paused_at: draft.paused_at ?? new Date().toISOString(),
    });
    setCloseConfirmOpen(false);
    props.onClose();
  }

  function discardAndClose() {
    if (!draft) { props.onClose(); return; }
    if (!props.editMode) {
      void clearDraft(draft.user_id, draft.session_type);
    }
    setCloseConfirmOpen(false);
    props.onClose();
  }

  async function commitNow() {
    if (!draft) return;
    setCommitting(true);
    const elapsedMin = Math.round(getElapsedMs(draft, Date.now()) / 60000);
    const payload: CommitSessionPayload = {
      user_id: draft.user_id,
      external_id: draft.external_id,
      date: draft.date,
      type: draft.session_type,
      duration_min: draft.duration_min !== undefined
        ? draft.duration_min
        : (elapsedMin > 0 ? elapsedMin : null),
      started_at: draft.session_started_at !== undefined
        ? draft.session_started_at
        : draft.started_at,
      exercises: draft.exercises.map((ex, i) => ({
        name: ex.name,
        position: i,
        sets: ex.sets
          .filter((s) => s.committed_at)
          .map((s, sIdx, arr) => {
            // Prefer the value already on the draft set (came from hydration of a
            // saved workout). Falls through to the timestamp-derived value for
            // fresh-logger sets where commit_at deltas are the source of truth.
            let restActual: number | null;
            if (s.rest_seconds_actual !== undefined) {
              restActual = s.rest_seconds_actual;
            } else if (props.editMode) {
              // New set added during edit — no real rest timer ran. Null is correct per
              // spec; computing from committed_at deltas would compare against the
              // original workout's creation timestamp (possibly days ago).
              restActual = null;
            } else {
              const prev = arr[sIdx - 1];
              restActual = prev?.committed_at && s.committed_at
                ? Math.round(
                    (new Date(s.committed_at).getTime() - new Date(prev.committed_at).getTime()) / 1000,
                  )
                : null;
            }
            return {
              set_index: s.set_index,
              kg: s.kg,
              reps: s.reps,
              duration_seconds: s.duration_seconds,
              warmup: s.warmup,
              failure: s.failure,
              rir: s.rir,
              rest_seconds_actual: restActual,
              // Carried on the wire from here; the RPC starts persisting them
              // in Task 7. Null for hand-logged and hydrated-historical sets.
              started_at: s.started_at ?? null,
              work_seconds: s.work_seconds ?? null,
            };
          }),
      })),
    };

    const res = await fetch("/api/logger/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      setCommitting(false);
      alert("Commit failed — your draft is preserved. Try Finish again.");
      return;
    }

    // Capture workout_id BEFORE clearing draft / closing the sheet, then
    // fire-and-forget the debrief generator. Errors are swallowed — the workout
    // itself is already committed and Carter can be re-asked for a debrief later.
    const commitResult = (await res.json().catch(() => null)) as { workout_id?: string } | null;
    if (commitResult?.workout_id) {
      fetch("/api/coach/workout-debrief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workout_id: commitResult.workout_id,
          force: !!props.editMode,
        }),
      }).catch(() => {
        /* fire-and-forget — debrief is best-effort */
      });
    }

    if (!props.editMode) {
      await clearDraft(draft.user_id, draft.session_type);
    }
    qc.invalidateQueries({ queryKey: queryKeys.workouts.all(draft.user_id) });
    router.refresh();
    props.onClose();
  }

  async function saveAsDefault() {
    if (!draft) return;
    setSavingTemplate(true);
    const exercises = draft.exercises.map((e) => {
      const lastCommittedWorking = [...e.sets]
        .reverse()
        .find((s) => s.committed_at && !s.warmup && s.kg !== null);
      const baseKg = lastCommittedWorking?.kg ?? e.prescribed.baseKg;
      return {
        ...e.prescribed,
        name: e.name,
        sets: e.sets.length,
        baseKg,
      };
    });
    const res = await fetch(`/api/logger/templates/${encodeURIComponent(draft.session_type)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exercises }),
    });
    setSavingTemplate(false);
    setSaveDefaultOpen(false);
    if (!res.ok) {
      alert("Save failed — try again.");
      return;
    }
    qc.invalidateQueries({
      queryKey: queryKeys.userSessionTemplates.one(draft.user_id, draft.session_type),
    });
  }

  return (
    <div className="fixed inset-0 bg-black z-40 flex flex-col">
      <div className="flex items-center justify-between p-3 border-b border-zinc-900 pt-[env(safe-area-inset-top)]">
        <button onClick={requestClose} className="text-zinc-400 text-lg" aria-label="Close logger">‹</button>
        <div className="text-zinc-300 text-sm flex items-center gap-2">
          {props.editMode ? (
            <span className="font-mono tabular-nums text-zinc-400">Editing · {draft.session_type}</span>
          ) : (
            <>
              <ElapsedTimer
                startedAt={draft.started_at}
                pausedAt={draft.paused_at}
                pausedMsTotal={draft.paused_ms_total}
                sessionType={draft.session_type}
              />
              <button
                onClick={togglePause}
                disabled={midSet}
                className="text-[11px] font-semibold uppercase tracking-wide text-zinc-300 bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded-md disabled:opacity-40"
                aria-label={isPaused ? "Resume timer" : "Pause timer"}
              >
                {isPaused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={() => setResetConfirmOpen(true)}
                className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 hover:text-red-400 px-1 py-1"
                aria-label="Reset session"
              >
                Reset
              </button>
            </>
          )}
        </div>
        <button onClick={() => setFinishOpen(true)} className="bg-green-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">
          Finish
        </button>
      </div>

      <div className="overflow-y-auto p-3 pb-44 flex-1">
        {!props.editMode && resolvedSource === "manual_edit" && (
          <div className="flex items-center gap-1.5 mb-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-400 bg-amber-400/10 border border-amber-400/30 px-2 py-0.5 rounded-md">
              Edited plan
            </span>
          </div>
        )}

        {!props.editMode && diverged && (
          <button
            onClick={() => setSaveDefaultOpen(true)}
            className="w-full bg-blue-500/10 border border-blue-500/30 text-blue-400 rounded-lg py-2 text-xs mb-3"
          >
            Save deviations as my {draft.session_type} default
          </button>
        )}

        {draft.exercises.map((ex, i) => (
          <ExerciseCard
            key={`${draft.started_at}-${ex.name}-${i}`}
            userId={draft.user_id}
            externalId={draft.external_id}
            exercise={ex}
            exerciseIndex={i}
            allExercises={draft.exercises}
            onExerciseChange={handleExerciseChange}
            onReplace={handleExerciseReplace}
            onRemove={handleExerciseRemove}
            onReorderAll={handleReorderAll}
            // Edit mode replays a historical workout: hydrateWorkoutAsDraft
            // stamps every set's committed_at with the workout's created_at,
            // so re-committing a set while editing a three-week-old session
            // would fire a live PR celebration (audio and all) for a lift long
            // since logged. The hook itself stays unconditional above — making
            // the CALL conditional is a hook-order violation, and with no
            // render-test harness in this repo it would pass typecheck and the
            // whole unit suite and break only in the production build.
            liveContext={props.editMode ? undefined : liveContext.data}
            timer={timer}
            // Edit mode replays a historical workout — no live timer runs, so
            // the per-row START affordance must not be offered at all.
            onTimerStart={props.editMode ? undefined : handleTimerStart}
            onSetCleared={handleSetCleared}
            onRestOverrideChange={handleRestOverrideChange}
          />
        ))}

        <button
          onClick={() => { setPickerMode("add"); setPickerOpen(true); }}
          className="bg-transparent text-zinc-500 border border-dashed border-zinc-800 w-full py-3 rounded-lg text-sm"
        >
          + Add exercise
        </button>
      </div>

      {/* The dock portals to <body>, so it paints ABOVE the sheet's own z-50
          dialogs (ExercisePicker is a bottom sheet — exactly the dock's strip).
          Unmounting while one is open is free: every value the dock shows is
          derived from absolute anchors on the draft, so it comes back exact. */}
      {!props.editMode && !anyDialogOpen && (
        <SetTimerDock
          state={timer}
          activeLabel={activeLabel}
          targetLabel={targetLabel}
          workSecondsTotal={workSecondsTotal}
          // Raw clock inputs, never a precomputed elapsed number — the dock
          // recomputes on its own tick so this parent never re-renders 4x/s.
          startedAt={draft.started_at}
          pausedAt={draft.paused_at}
          pausedMsTotal={draft.paused_ms_total}
          canStart={nextSetRef !== null}
          onStart={() => { if (nextSetRef) handleTimerStart(nextSetRef); }}
          onCountdownElapsed={handleCountdownElapsed}
          onStop={handleStop}
        />
      )}

      {pickerOpen && (
        <ExercisePicker
          onClose={() => setPickerOpen(false)}
          onPick={(name) => {
            if (pickerMode === "add") {
              const newEx: ExerciseDraft = {
                name,
                position: draft.exercises.length,
                prescribed: { name, sets: 3, baseReps: 10 },
                sets: Array.from({ length: 3 }, (_x, j) => ({
                  set_index: j, kg: null, reps: null, duration_seconds: null, warmup: false, failure: false, rir: props.weekRirTarget ?? 2, committed_at: null,
                })),
              };
              setDraft({ ...draft, exercises: [...draft.exercises, newEx] });
            } else {
              const idx = pickerMode.replace_index;
              setDraft({
                ...draft,
                exercises: draft.exercises.map((e, j) => j === idx ? { ...e, name } : e),
              });
            }
            setPickerOpen(false);
          }}
        />
      )}

      {reorderOpen && (
        <ReorderDialog
          exercises={draft.exercises}
          onCancel={() => setReorderOpen(false)}
          onConfirm={(next) => {
            // ReorderDialog splices the SAME ExerciseDraft objects, so identity
            // gives an exact old→new index map even when two exercises share a
            // name. Computed out here, not inside the setDraft updater, so the
            // updater stays a pure function of prev.
            const before = draft.exercises;
            const mapIndex = (i: number) => {
              const moved = next.indexOf(before[i]);
              return moved === -1 ? null : moved;
            };
            setRestOverrides((o) => keepUnmovedRestOverrides(o, mapIndex));
            setDraft((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                exercises: next,
                timer: remapTimerExercises(timerOf(prev), mapIndex),
              };
            });
            setReorderOpen(false);
          }}
        />
      )}

      {saveDefaultOpen && (
        <SaveAsDefaultDialog
          sessionType={draft.session_type}
          saving={savingTemplate}
          onConfirm={saveAsDefault}
          onCancel={() => setSaveDefaultOpen(false)}
        />
      )}

      {finishOpen && (
        <FinishSummary
          draft={draft}
          durationMin={
            props.editMode && draft.duration_min != null
              ? draft.duration_min
              : getElapsedMs(draft, Date.now()) / 60000
          }
          saving={committing}
          onConfirm={commitNow}
          onCancel={() => setFinishOpen(false)}
          confirmLabel={props.editMode ? "Save changes" : undefined}
        />
      )}

      {closeConfirmOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
            {props.editMode ? (
              <>
                <h3 className="text-base font-semibold text-zinc-50 mb-1">Discard changes?</h3>
                <p className="text-sm text-zinc-400 mb-4">
                  Your edits won&apos;t be saved. The original session remains unchanged.
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setCloseConfirmOpen(false)}
                    className="w-full bg-green-600 text-white rounded-lg py-2 text-sm font-medium"
                  >
                    Keep editing
                  </button>
                  <button
                    onClick={discardAndClose}
                    className="w-full bg-red-600/20 text-red-400 border border-red-500/40 rounded-lg py-2 text-sm font-medium"
                  >
                    Discard changes
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-base font-semibold text-zinc-50 mb-1">Close session?</h3>
                <p className="text-sm text-zinc-400 mb-4">
                  <strong className="text-zinc-200">Pause &amp; close</strong> saves your progress so you can resume from the strength page.{" "}
                  <strong className="text-red-400">Discard</strong> clears all current logs and the timer — this can&apos;t be undone.
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={pauseAndClose}
                    className="w-full bg-green-600 text-white rounded-lg py-2 text-sm font-medium"
                  >
                    Pause &amp; close
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCloseConfirmOpen(false)}
                      className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={discardAndClose}
                      className="flex-1 bg-red-600/20 text-red-400 border border-red-600/40 rounded-lg py-2 text-sm"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {resetConfirmOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
            <h3 className="text-base font-semibold text-zinc-50 mb-1">Are you sure you want to reset the session?</h3>
            <p className="text-sm text-zinc-400 mb-4">
              You will lose the current logs and reset the timer. The exercise list stays. This can&apos;t be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => { setDraft(resetDraft(draft, props.weekRirTarget ?? 2)); setResetConfirmOpen(false); }}
                className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm font-medium"
              >
                Reset
              </button>
              <button
                onClick={() => setResetConfirmOpen(false)}
                className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
