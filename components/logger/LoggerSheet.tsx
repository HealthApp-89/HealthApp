"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { LoggerDraft, ExerciseDraft, CommitSessionPayload } from "@/lib/logger/types";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadDraft, saveDraft, clearDraft } from "@/lib/logger/draft-store";
import { useWakeLock } from "@/lib/logger/rest-timer";
import { ExerciseCard } from "@/components/logger/ExerciseCard";
import { ExercisePicker } from "@/components/logger/ExercisePicker";
import { ResumeDraftPrompt } from "@/components/logger/ResumeDraftPrompt";
import { SaveAsDefaultDialog } from "@/components/logger/SaveAsDefaultDialog";
import { FinishSummary } from "@/components/logger/FinishSummary";
import { queryKeys } from "@/lib/query/keys";

type Props = {
  userId: string;
  sessionType: string;
  date: string;            // YYYY-MM-DD
  weekdayLong: string;     // "Monday"
  weekOverrides: Record<string, PlannedExercise[]> | null;
  weekPrescriptions?: import("@/lib/data/types").SessionPrescriptions | null;
  onClose: () => void;
  /** When set, LoggerSheet boots in edit mode: seeds state from initialDraft,
   *  skips draft-store reads/writes, hides timer controls. */
  editMode?: { initialDraft: LoggerDraft };
};

function makeDraftFromPlan(args: {
  userId: string;
  sessionType: string;
  date: string;
  plan: PlannedExercise[];
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
  };
}

function getElapsedMs(draft: LoggerDraft, now: number): number {
  const start = new Date(draft.started_at).getTime();
  const end = draft.paused_at ? new Date(draft.paused_at).getTime() : now;
  return Math.max(0, end - start - draft.paused_ms_total);
}

/** Wipe all entered sets + timer state, keep the current exercise list. */
function resetDraft(draft: LoggerDraft): LoggerDraft {
  const nowIso = new Date().toISOString();
  return {
    ...draft,
    started_at: nowIso,
    updated_at: nowIso,
    paused_at: null,
    paused_ms_total: 0,
    exercises: draft.exercises.map((ex) => ({
      ...ex,
      sets: Array.from({ length: ex.prescribed.sets ?? 1 }, (_unused, j) => ({
        set_index: j,
        kg: ex.prescribed.duration_seconds != null ? null : (ex.prescribed.baseKg ?? null),
        reps: null,
        duration_seconds: null,
        warmup: !!ex.prescribed.warmup && j === 0,
        failure: false,
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
  const [committing, setCommitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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
      });
      if (cancelled) return;
      const fresh = makeDraftFromPlan({
        userId: props.userId,
        sessionType: props.sessionType,
        date: props.date,
        plan: resolved.exercises,
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

  // 3) Tick clock for elapsed. Skip ticks while paused — the displayed value
  //    is derived from draft.paused_at, which doesn't move.
  useEffect(() => {
    if (draft?.paused_at) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [draft?.paused_at]);

  const elapsedMs = draft ? getElapsedMs(draft, now) : 0;
  const elapsedLabel = formatElapsed(elapsedMs);
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
          });
          setDraft(makeDraftFromPlan({
            userId: props.userId, sessionType: props.sessionType,
            date: props.date, plan: resolved.exercises,
          }));
        }}
      />
    );
  }

  if (!draft) {
    return <div className="fixed inset-0 bg-black/90 flex items-center justify-center text-zinc-500">Loading…</div>;
  }

  const diverged = exerciseListDiverged(draft);

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
      setNow(Date.now());
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
    if (!draft.paused_at) {
      setDraft({ ...draft, paused_at: new Date().toISOString() });
    }
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
              rest_seconds_actual: restActual,
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
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${isPaused ? "bg-yellow-500" : "bg-green-500"}`}></span>
                <span className="font-mono tabular-nums">{elapsedLabel}</span>
                <span>· {draft.session_type}</span>
              </div>
              <button
                onClick={togglePause}
                className="text-[11px] font-semibold uppercase tracking-wide text-zinc-300 bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded-md"
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

      <div className="overflow-y-auto p-3 pb-32 flex-1">
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
            onChange={(next) => setDraft({ ...draft, exercises: draft.exercises.map((e, j) => j === i ? next : e) })}
            onReplace={() => { setPickerMode({ replace_index: i }); setPickerOpen(true); }}
            onRemove={() => setDraft({ ...draft, exercises: draft.exercises.filter((_, j) => j !== i) })}
          />
        ))}

        <button
          onClick={() => { setPickerMode("add"); setPickerOpen(true); }}
          className="bg-transparent text-zinc-500 border border-dashed border-zinc-800 w-full py-3 rounded-lg text-sm"
        >
          + Add exercise
        </button>
      </div>

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
                  set_index: j, kg: null, reps: null, duration_seconds: null, warmup: false, failure: false, committed_at: null,
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
                onClick={() => { setDraft(resetDraft(draft)); setNow(Date.now()); setResetConfirmOpen(false); }}
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
