"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { LoggerDraft, ExerciseDraft, CommitSessionPayload } from "@/lib/logger/types";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadDraft, saveDraft, clearDraft } from "@/lib/logger/draft-store";
import { useWakeLock } from "@/lib/logger/rest-timer";
import { seedRir } from "@/lib/logger/seed-rir";
import { seedReps } from "@/lib/logger/seed-reps";
import { useLiveSessionContext } from "@/lib/query/hooks/useLiveSessionContext";
import { fmtNum } from "@/lib/ui/score";
import {
  IDLE_TIMER,
  timerReducer,
  remapTimerSets,
  remapTimerExercises,
  getElapsedMs,
  sameSet,
  includesSet,
  restBetweenSets,
  totalWorkSeconds,
  roundMemberStartOffsets,
  type TimerState,
  type SetRef,
} from "@/lib/logger/set-timer";
import {
  timerOf,
  withTimer,
  commitPendingEntry,
  commitPendingEntries,
  keepUnmovedRestOverrides,
  annotatedRestFor,
} from "@/lib/logger/draft-ops";
import { groupOfIndex, nextRound, roundFromLead } from "@/lib/logger/superset-groups";
import {
  evaluateSet,
  type CoachLine,
  type LiveSessionContext,
  type SessionSetRef,
} from "@/lib/coach/live-session";
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
      // Seeded like kg, and for a sharper reason since Task 6: the zoom's Save
      // and the auto-save on START both commit without a rep count being
      // typed, and a null-reps row drops silently out of e1RM, volume, the
      // debrief and the prescription engine. See lib/logger/seed-reps.ts.
      reps: seedReps(p),
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

/**
 * Between-sets coaching for the set just committed. THE evaluation site —
 * every commit path (the manual ○, the zoom's Save, and the auto-save when
 * START is pressed on the next set) funnels through it.
 *
 * This repo's documented recurring failure is a second copy of an engine rule
 * drifting out of sync with the first, so the set-collection logic exists once:
 * `sessionSets` spans ALL exercises, because the failure budget is a
 * session-level count, and `draft` is already post-commit so the just-finished
 * set is visible to the rules.
 *
 * Returns null — silence — whenever the context snapshot is unavailable. Callers
 * ALWAYS replace the displayed line with this result, never merely overwrite it
 * when non-null: the query key hashes the exercise-name list, so Add / Remove /
 * Replace mints a new key and `data` goes undefined until the refetch lands
 * (permanently, if offline), which would otherwise strand the PREVIOUS set's
 * line on screen underneath the new one.
 */
function evaluateCommittedSet(
  draft: LoggerDraft,
  ref: SetRef,
  liveContext: LiveSessionContext | undefined,
): CoachLine | null {
  if (!liveContext) return null;
  const ex = draft.exercises[ref.exerciseIndex];
  const set = ex?.sets[ref.setIndex];
  if (!ex || !set) return null;
  const sessionSets: SessionSetRef[] = draft.exercises.flatMap((e) =>
    e.sets
      .filter((s) => !s.warmup && s.committed_at != null)
      .map((s) => ({ exerciseName: e.name, set: s })),
  );
  return evaluateSet({ set, exercise: ex, sessionSets, context: liveContext });
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

/** Dock captions for a round: which sets are in play and what they ask for. */
function describeRound(
  draft: LoggerDraft,
  refs: SetRef[],
): { activeLabel: string; targetLabel: string } {
  if (refs.length === 0) return { activeLabel: "All sets committed", targetLabel: "tap Finish when done" };
  if (refs.length === 1) return describeSet(draft, refs[0]);
  const group = groupOfIndex(draft.exercises, refs[0].exerciseIndex);
  const lead = draft.exercises[refs[0].exerciseIndex];
  const roundNumber = lead ? lead.sets.slice(0, refs[0].setIndex).filter((s) => !s.warmup).length + 1 : 1;
  const targets = refs.map((r) => {
    const ex = draft.exercises[r.exerciseIndex];
    const p = ex?.prescribed;
    if (!ex || !p) return "";
    const short = ex.name.split("(")[0].trim();
    return p.baseKg != null
      ? `${short} ${fmtNum(p.baseKg)}×${p.baseReps ?? "?"}`
      : `${short} ×${p.baseReps ?? "?"}`;
  });
  return {
    activeLabel: `Superset ${group.tag} · round ${roundNumber}`,
    targetLabel: targets.join(" → "),
  };
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
        reps: seedReps(ex.prescribed),
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
  /** Which card has its RestTimeDialog up, if any. Lifted for the same reason
   *  the sheet's own dialogs are tracked: the dock portals to <body> and must
   *  unmount while a modal is over the sheet. */
  const [restDialogOpenIndex, setRestDialogOpenIndex] = useState<number | null>(null);
  /** The between-sets line and the set it belongs to, as one value so the
   *  clear/remap rules below stay pure single-setState updates. */
  const [coach, setCoach] = useState<{ line: CoachLine; set: SetRef } | null>(null);
  /** Sets just committed and awaiting evaluation. A LIST because one START
   *  auto-saves every member of the round it is leaving. The handlers only
   *  record WHICH sets; the effect below evaluates once the draft carrying that
   *  commit has rendered. Keeping evaluateSet out of the setDraft updaters is
   *  what lets those updaters stay pure functions of `prev`. */
  const [pendingCoachEval, setPendingCoachEval] = useState<SetRef[] | null>(null);
  /** Latest open entry rows, readable from the stable timer callbacks. They use
   *  functional setDraft (so they never close over a draft snapshot) and so
   *  cannot see `pendingEntries` — but the auto-save on START has to know which
   *  sets it just committed in order to coach on them. Written only from the
   *  effect below, read only from event handlers, which run after that effect
   *  has flushed. */
  const pendingEntryRefs = useRef<SetRef[]>([]);
  /** Latest draft, readable from the stable timer callbacks. Same reason as
   *  `pendingEntryRefs`: those callbacks use functional setDraft so they never
   *  close over a draft snapshot and stay reference-equal for the memoized
   *  cards — but expanding a row-level START into its whole round needs to READ
   *  the exercise list. Written only from the mirroring effect below. */
  const draftRef = useRef<LoggerDraft | null>(null);

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
    // The line is transient UI anchored to a positional ref; the list edit
    // moves every ref below. Taking it down beats remapping it (and matches
    // what used to happen for free when the card remounted).
    setCoach(null);
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

  const handleTimerStart = useCallback((sets: SetRef[]) => {
    const autoSaved = pendingEntryRefs.current;
    // Clock read hoisted OUT of the updater: React may invoke a setState
    // updater more than once per commit (StrictMode double-invokes them), so
    // reading the wall clock inside one is a Rules-of-React violation and can
    // yield two different timestamps for one tap.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    setDraft((prev) => {
      if (!prev) return prev;
      // Auto-save every open entry first: the fields are pre-filled from the
      // prescription, so the athlete can start the next round without ever
      // touching them and nothing is lost.
      const withEntrySaved = commitPendingEntries(prev, nowIso);
      return withTimer(
        withEntrySaved,
        timerReducer(timerOf(withEntrySaved), { type: "press_start", sets, nowMs }),
        nowIso,
      );
    });
    // Coach on everything the auto-save just committed — a superset round hands
    // over more than one set at a time, and the effect below picks the first
    // line any of them earns.
    if (autoSaved.length > 0) setPendingCoachEval(autoSaved);
  }, []);

  /** The round a set belongs to. A row-level START must not begin half a
   *  superset, and the dock's START goes through `nextRound` already — so this
   *  is the same rule with the lead supplied instead of scanned for, which is
   *  exactly `roundFromLead`. Written out here it would be a second copy of
   *  that loop living in the one file this repo's vitest setup cannot reach.
   *
   *  `pendingEntryRefs` is what excludes a member whose zoom is still open: that
   *  set is uncommitted but already PERFORMED, and START commits it on the way,
   *  so including it would re-run — and re-stamp `work_seconds` / `started_at`
   *  on — a set the athlete has just finished. Reachable by saving one member's
   *  entry row and tapping "Start this set" on the partner, which the card
   *  offers because it only knows about its OWN pending entry. */
  const roundForSet = useCallback((set: SetRef): SetRef[] => {
    const d = draftRef.current;
    if (!d) return [set];
    return roundFromLead(d.exercises, set, pendingEntryRefs.current);
  }, []);

  const handleRowStart = useCallback((set: SetRef) => {
    handleTimerStart(roundForSet(set));
  }, [handleTimerStart, roundForSet]);

  /** Manual ○ commit. Lives here, not in ExerciseCard, so both commit paths
   *  reach `evaluateCommittedSet` through the same signal. */
  const handleSetCommit = useCallback((exerciseIndex: number, setIndex: number) => {
    const nowIso = new Date().toISOString();
    setDraft((prev) => {
      if (!prev) return prev;
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== setIndex || s.committed_at ? s : { ...s, committed_at: nowIso },
          ),
        },
      );
      // The dock stays armed on the set in play, so a manual ○ on THAT set
      // would leave phase:"running" pointing at an already-committed row. The
      // circle still reads STOP, and the athlete may well tap it minutes later
      // — "Start this set" is hidden mid-set, so the dock is the only thing
      // offering an action — at which point `handleStop` stamps the whole gap
      // as `work_seconds` and it reaches `exercise_sets`, poisoning
      // restBetweenSets, the work:rest ratio and `rest_seconds_actual`. Same
      // failure class, same remedy as `pauseAndClose`: drop the timer. The
      // set was committed by hand, so it is untimed by definition — its
      // `work_seconds` stays null, which every consumer already reads as
      // "not timed".
      const cur = timerOf(prev);
      const midSet = cur.phase === "countdown" || cur.phase === "running";
      const timer = midSet && includesSet(cur.activeSets, { exerciseIndex, setIndex })
        ? timerReducer(cur, { type: "reset" })
        : prev.timer ?? null;
      return { ...prev, exercises, timer, updated_at: nowIso };
    });
    setPendingCoachEval([{ exerciseIndex, setIndex }]);
  }, []);

  /** Save the zoomed entry row. Writes the numbers, closes the zoom, and
   *  deliberately touches NO clock — rest keeps running underneath. */
  const handleEntrySave = useCallback((ref: SetRef) => {
    // Guards a second tap landing before the re-render: the entry is already
    // saved, so re-committing (and re-coaching) it would be noise.
    if (!pendingEntryRefs.current.some((r) => sameSet(r, ref))) return;
    const nowIso = new Date().toISOString();
    setDraft((prev) => (prev ? commitPendingEntry(prev, ref, nowIso) : prev));
    setPendingCoachEval([{ exerciseIndex: ref.exerciseIndex, setIndex: ref.setIndex }]);
  }, []);

  const handleCoachLineDismiss = useCallback(() => setCoach(null), []);

  const handleCountdownElapsed = useCallback(() => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    setDraft((prev) => {
      if (!prev) return prev;
      const next = timerReducer(timerOf(prev), { type: "countdown_elapsed", nowMs });
      if (next === timerOf(prev)) return prev;
      // Stamp the true set start on the draft set itself. Only the FIRST
      // member of the round starts at countdown end; the later members are
      // still waiting their turn, so `handleStop` stamps those from
      // roundMemberStartOffsets once the round's total work is known.
      const ref = next.activeSets[0];
      if (!ref) return withTimer(prev, next, nowIso);
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== ref.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== ref.setIndex ? s : { ...s, started_at: nowIso },
          ),
        },
      );
      return withTimer({ ...prev, exercises }, next, nowIso);
    });
  }, []);

  const handleStop = useCallback(() => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = timerOf(prev);
      if (cur.phase !== "running" || cur.activeSets.length === 0 || cur.anchorMs === null) return prev;
      const roundStartMs = cur.anchorMs;
      // Group rest, not per-exercise rest: the pair is one unit, so the longer
      // of the members' prescriptions is what the athlete owes.
      const prescribedRest = Math.max(
        ...cur.activeSets.map((r) =>
          restOverrides[r.exerciseIndex] ?? annotatedRestFor(prev, r.exerciseIndex),
        ),
      );
      const next = timerReducer(cur, { type: "press_stop", nowMs, prescribedRestSeconds: prescribedRest });
      // Read the shares OFF the new state rather than recomputing them — one
      // split, one source of truth for both the entry rows and the DB stamps.
      const shares = next.pendingEntries.map((e) => e.workSeconds);
      const offsets = roundMemberStartOffsets(shares);
      let exercises = prev.exercises;
      // Stop records the honest work time and opens the zooms; it does NOT
      // commit. Commit is the Save tap (or the auto-save when START is pressed
      // on the next round), which is what lets entry and rest run concurrently.
      next.pendingEntries.forEach((entry, i) => {
        // Member 0's started_at was stamped at countdown end; later members
        // start when the earlier ones finish, plus one transition allowance.
        const startedAt = i === 0
          ? null
          : new Date(roundStartMs + offsets[i] * 1000).toISOString();
        exercises = exercises.map((ex, ei) =>
          ei !== entry.exerciseIndex ? ex : {
            ...ex,
            sets: ex.sets.map((s, si) =>
              si !== entry.setIndex ? s : {
                ...s,
                work_seconds: entry.workSeconds,
                started_at: startedAt ?? s.started_at ?? null,
              },
            ),
          },
        );
      });
      return withTimer({ ...prev, exercises }, next, nowIso);
    });
  }, [restOverrides]);

  const handleSetCleared = useCallback((set: SetRef) => {
    const nowIso = new Date().toISOString();
    setDraft((prev) => {
      if (!prev) return prev;
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== set.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) => {
            if (si !== set.setIndex) return s;
            // Edit mode runs no live timer, so there is nothing to clear here
            // — and blanking would be destructive: a hydrated set's
            // started_at/work_seconds are the saved workout's GENUINE timing
            // (Task 7), not timer scratch state. Un-committing during an edit
            // must leave them intact so a re-commit doesn't write nulls over
            // real recorded data.
            if (props.editMode) return s;
            return { ...s, started_at: null, work_seconds: null };
          }),
        },
      );
      return withTimer(
        { ...prev, exercises },
        timerReducer(timerOf(prev), { type: "clear_for_set", set }),
        nowIso,
      );
    });
    // The verdict was about a set that no longer counts as committed.
    setCoach((c) => (c && sameSet(c.set, set) ? null : c));
    // `[]` deliberately: `props.editMode` is fixed for the lifetime of a
    // mounted LoggerSheet (every caller either always passes it or never
    // does — see EditSessionButton vs. the fresh-session callers), so a
    // stale closure over it can never actually go stale. Keeping it out of
    // the deps array preserves this callback's referential identity across
    // re-renders, which ExerciseCard (memo-wrapped) depends on.
  }, []);

  /**
   * Delete one set of one exercise.
   *
   * Lives here rather than in ExerciseCard because the three things a delete
   * does — drop the row, re-index the survivors' `set_index` (the RPC writes
   * it verbatim, so gaps would persist in the DB), and re-point the timer's
   * refs — have to be ONE atomic draft update. Split across two callbacks it
   * was not: `clear_for_set` only matches an exact ref, so deleting a set
   * BELOW the one in play left `activeSets` / `pendingEntries` one index too
   * high, silently naming the row that slid up into the deleted slot.
   *
   * The deleted row's own `started_at` / `work_seconds` need no blanking —
   * they go with the row.
   */
  const handleSetRemove = useCallback((exerciseIndex: number, setIndex: number) => {
    const mapSetIndex = (i: number) => (i === setIndex ? null : i > setIndex ? i - 1 : i);
    const nowIso = new Date().toISOString();
    setDraft((prev) => {
      if (!prev) return prev;
      const target = prev.exercises[exerciseIndex];
      if (!target || setIndex < 0 || setIndex >= target.sets.length) return prev;
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets
            .filter((_unused, si) => si !== setIndex)
            .map((s, si) => ({ ...s, set_index: si })),
        },
      );
      return withTimer(
        { ...prev, exercises },
        remapTimerSets(timerOf(prev), exerciseIndex, mapSetIndex),
        nowIso,
      );
    });
    // The coach line is anchored to a positional ref too — same shift.
    setCoach((c) => {
      if (!c || c.set.exerciseIndex !== exerciseIndex) return c;
      const moved = mapSetIndex(c.set.setIndex);
      return moved === null ? null : { ...c, set: { ...c.set, setIndex: moved } };
    });
  }, []);

  const handleRestOverrideChange = useCallback((exerciseIndex: number, seconds: number) => {
    setRestOverrides((prev) => ({ ...prev, [exerciseIndex]: seconds }));
  }, []);

  const handleRestDialogOpenChange = useCallback((exerciseIndex: number, open: boolean) => {
    setRestDialogOpenIndex((prev) =>
      open ? exerciseIndex : prev === exerciseIndex ? null : prev,
    );
  }, []);

  /** Total honest time under load so far — the dock's WORK counter. */
  const workSecondsTotal = useMemo(() => {
    if (!draft) return 0;
    return totalWorkSeconds(draft.exercises);
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

  // Mirror the draft and its open entry rows into refs the stable timer
  // callbacks can read. See the declarations above for why they cannot read
  // either from `draft` directly.
  useEffect(() => {
    draftRef.current = draft;
    // Via timerOf, not `draft.timer` — a draft resumed from IndexedDB across
    // the round refactor carries the old single-set shape and normalises here.
    pendingEntryRefs.current = timerOf(draft).pendingEntries.map((e) => ({
      exerciseIndex: e.exerciseIndex,
      setIndex: e.setIndex,
    }));
  }, [draft]);

  // THE between-sets evaluation. Runs once per committed set, after the draft
  // carrying that commit has rendered, for every commit path alike.
  //
  // Edit mode passes no context, so the rules go silent: hydrateWorkoutAsDraft
  // stamps every set's committed_at with the workout's created_at, and
  // re-committing a set while editing a three-week-old session would otherwise
  // celebrate a PR for a lift long since logged.
  useEffect(() => {
    if (!pendingCoachEval || pendingCoachEval.length === 0 || !draft) return;
    // At most one line per commit, still — a round commits two sets, so the
    // first rule that fires in group order wins and the rest stay silent.
    let shown: { line: CoachLine; set: SetRef } | null = null;
    for (const ref of pendingCoachEval) {
      const line = evaluateCommittedSet(draft, ref, props.editMode ? undefined : liveContext.data);
      if (line) { shown = { line, set: ref }; break; }
    }
    setCoach(shown);
    setPendingCoachEval(null);
  }, [pendingCoachEval, draft, liveContext.data, props.editMode]);

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
  // What START dispatches. During `rest`, activeSets holds the sets just
  // FINISHED, so the next round always comes from the pending scan — and the
  // members whose zoom is still open are excluded, because START commits them
  // on the way.
  const nextRoundRefs = nextRound(draft, timer.pendingEntries);
  const anyDialogOpen =
    pickerOpen || reorderOpen || saveDefaultOpen || finishOpen
    || closeConfirmOpen || resetConfirmOpen || restDialogOpenIndex !== null;
  // What the caption describes: the round in play mid-set, otherwise the next.
  const { activeLabel, targetLabel } = describeRound(
    draft,
    midSet ? timer.activeSets : nextRoundRefs,
  );

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
    // An in-flight set must NOT survive the close. Pause is disabled mid-set,
    // but Close is one tap and auto-pauses here; the draft would persist
    // phase:"running" with its original absolute anchorMs, and resuming hours
    // later (within the 12h TTL) would let STOP stamp the entire gap as
    // work_seconds — which Task 7 writes to the DB, poisoning restBetweenSets,
    // the debrief, and rest-discipline math. The set was never committed, so
    // abandoning it is correct: the athlete restarts it on resume.
    //
    // A `rest` phase must not survive either. Its anchor is absolute, so a
    // draft closed mid-rest and resumed later reopens on a countdown that is
    // hours negative — and rest genuinely did elapse, so there is nothing left
    // to count. Reset covers every phase.
    //
    // Close is also an EXIT PATH, so like Finish it flushes every open entry
    // row first: stopping a set, not tapping Save, then closing must not leave
    // the set's kg/reps/work_seconds parked in a zoom that the reset then
    // closes.
    const nowIso = new Date().toISOString();
    const flushed = commitPendingEntries(draft, nowIso);
    setDraft({
      ...flushed,
      timer: timerReducer(timerOf(flushed), { type: "reset" }),
      updated_at: nowIso,
      paused_at: draft.paused_at ?? nowIso,
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
            // saved workout). Falls through to restBetweenSets for fresh-logger
            // sets.
            let restActual: number | null;
            if (s.rest_seconds_actual !== undefined) {
              restActual = s.rest_seconds_actual;
            } else if (props.editMode) {
              // New set added during edit — no real rest timer ran. Null is correct per
              // spec; computing from committed_at deltas would compare against the
              // original workout's creation timestamp (possibly days ago).
              restActual = null;
            } else {
              // NOT a commit-timestamp delta. Task 6 moved `committed_at` from
              // the stop press to the Save tap, so that subtraction now means
              // "the gap between two arbitrary Save taps" — and means something
              // DIFFERENT per set depending on whether the athlete saved
              // promptly or let START auto-save. The old proxy was at least
              // consistently wrong; this would have been junk in a column the
              // debrief and the rest-discipline rule both read.
              //
              // restBetweenSets measures from the previous set's true END
              // (started_at + work_seconds) to the next set's true START, both
              // already on the draft, and falls back to the old commit-delta
              // proxy only for sets that carry no timer data at all.
              const prev = arr[sIdx - 1];
              restActual = prev ? restBetweenSets(prev, s) : null;
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
        {/* Flush every open zoom BEFORE the summary opens. Splitting commit out
            of stop created a window in which a finished set is not yet
            committed, and every other exit flushes it (Save, START on the next
            set) — Finish did not. The header button is never covered by the
            zoom, so the reachable path is the most ordinary one there is:
            last set of the session, STOP, then Finish. `commitNow` filters on
            `committed_at`, so that set's kg / reps / rir / work_seconds /
            started_at left with it, and FinishSummary's totals read one low.
            Flushing here fixes both at once: the re-render hands the summary
            and the commit payload the same, complete draft. */}
        <button
          onClick={() => {
            const nowIso = new Date().toISOString();
            setDraft((p) => (p ? commitPendingEntries(p, nowIso) : p));
            setFinishOpen(true);
          }}
          className="bg-green-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
        >
          Finish
        </button>
      </div>

      {/* Bottom padding clears the docked timer. Edit mode renders no dock, so
          reserving its height there is 176px of dead scroll. */}
      <div className={`overflow-y-auto p-3 flex-1 ${props.editMode ? "pb-6" : "pb-44"}`}>
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
            timer={timer}
            // Edit mode replays a historical workout — no live timer runs, so
            // the per-row START affordance must not be offered at all.
            onTimerStart={props.editMode ? undefined : handleRowStart}
            editMode={!!props.editMode}
            onSetCommit={handleSetCommit}
            onEntrySave={handleEntrySave}
            onSetCleared={handleSetCleared}
            onSetRemove={handleSetRemove}
            onRestOverrideChange={handleRestOverrideChange}
            onRestDialogOpenChange={handleRestDialogOpenChange}
            coachLine={coach && coach.set.exerciseIndex === i ? coach.line : null}
            coachLineSetIndex={coach && coach.set.exerciseIndex === i ? coach.set.setIndex : null}
            onCoachLineDismiss={handleCoachLineDismiss}
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
          canStart={nextRoundRefs.length > 0}
          onStart={() => { if (nextRoundRefs.length) handleTimerStart(nextRoundRefs); }}
          onCountdownElapsed={handleCountdownElapsed}
          onStop={handleStop}
        />
      )}

      {pickerOpen && (
        <ExercisePicker
          onClose={() => setPickerOpen(false)}
          onPick={(name) => {
            if (pickerMode === "add") {
              const prescribed: PlannedExercise = { name, sets: 3, baseReps: 10 };
              const newEx: ExerciseDraft = {
                name,
                position: draft.exercises.length,
                prescribed,
                sets: Array.from({ length: 3 }, (_x, j) => ({
                  set_index: j, kg: null, reps: seedReps(prescribed), duration_seconds: null, warmup: false, failure: false, rir: props.weekRirTarget ?? 2, committed_at: null,
                })),
              };
              setDraft({ ...draft, exercises: [...draft.exercises, newEx] });
            } else {
              const idx = pickerMode.replace_index;
              // The line named the exercise that just got replaced.
              setCoach(null);
              // ExerciseCard's key embeds `ex.name`, so the rename remounts
              // the card and resets its LOCAL restOverrideSeconds to null.
              // The lifted copy has to go with it or `press_stop` would seed
              // rest from an override belonging to the exercise that is no
              // longer there, while the card's "+ Add set (m:ss)" label shows
              // the new exercise's prescription. Same invariant
              // keepUnmovedRestOverrides exists to hold, different trigger.
              setRestOverrides((o) => {
                if (!(idx in o)) return o;
                const next = { ...o };
                delete next[idx];
                return next;
              });
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
            setCoach(null);
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
                onClick={() => { setCoach(null); setDraft(resetDraft(draft, props.weekRirTarget ?? 2)); setResetConfirmOpen(false); }}
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
