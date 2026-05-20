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
  onClose: () => void;
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
      kg: p.baseKg ?? null,
      reps: null,
      warmup: !!p.warmup && j === 0,
      failure: false,
      committed_at: null,
    })),
  }));
  return {
    user_id: args.userId,
    session_type: args.sessionType,
    date: args.date,
    started_at: nowIso, // overwritten on first ✓
    updated_at: nowIso,
    exercises,
    resolved_plan: args.plan,
    external_id: externalId,
  };
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
  const [committing, setCommitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useWakeLock(!!draft);

  // 1) Mount: load existing draft or build from resolved plan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = await loadDraft(props.userId, props.sessionType);
      if (cancelled) return;
      if (existing && hasFirstCommit(existing)) {
        setResumePrompt(existing);
        return;
      }
      const resolved = await resolveSessionPlan({
        supabase,
        userId: props.userId,
        sessionType: props.sessionType,
        weekdayLong: props.weekdayLong,
        weekOverrides: props.weekOverrides ?? null,
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
  }, [props.userId, props.sessionType, props.date, props.weekdayLong, props.weekOverrides, supabase]);

  // 2) Mirror to IndexedDB on every change.
  useEffect(() => {
    if (!draft) return;
    const updated = { ...draft, updated_at: new Date().toISOString() };
    void saveDraft(updated);
  }, [draft]);

  // 3) Tick clock for elapsed.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startedAt = useMemo(() => {
    if (!draft) return null;
    for (const ex of draft.exercises) {
      for (const s of ex.sets) {
        if (s.committed_at) return new Date(s.committed_at).getTime();
      }
    }
    return null;
  }, [draft]);

  const elapsedMs = startedAt ? now - startedAt : 0;
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
  const elapsedLabel = `${elapsedMin}:${elapsedSec.toString().padStart(2, "0")}`;

  if (resumePrompt && !draft) {
    return (
      <ResumeDraftPrompt
        draft={resumePrompt}
        onResume={() => { setDraft(resumePrompt); setResumePrompt(null); }}
        onDiscard={async () => {
          await clearDraft(props.userId, props.sessionType);
          setResumePrompt(null);
          // Re-mount path: build fresh.
          const resolved = await resolveSessionPlan({
            supabase, userId: props.userId, sessionType: props.sessionType,
            weekdayLong: props.weekdayLong, weekOverrides: props.weekOverrides ?? null,
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

  async function commitNow() {
    if (!draft) return;
    setCommitting(true);
    const payload: CommitSessionPayload = {
      user_id: draft.user_id,
      external_id: draft.external_id,
      date: draft.date,
      type: draft.session_type,
      duration_min: startedAt ? Math.round((Date.now() - startedAt) / 60000) : null,
      exercises: draft.exercises.map((ex, i) => ({
        name: ex.name,
        position: i,
        sets: ex.sets
          .filter((s) => s.committed_at)
          .map((s, sIdx, arr) => {
            const prev = arr[sIdx - 1];
            const restActual = prev?.committed_at && s.committed_at
              ? Math.round(
                  (new Date(s.committed_at).getTime() - new Date(prev.committed_at).getTime()) / 1000,
                )
              : null;
            return {
              set_index: s.set_index,
              kg: s.kg,
              reps: s.reps,
              duration_seconds: null,
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

    await clearDraft(draft.user_id, draft.session_type);
    qc.invalidateQueries({ queryKey: ["workouts"] });
    router.refresh();
    props.onClose();
  }

  async function saveAsDefault() {
    if (!draft) return;
    setSavingTemplate(true);
    const exercises = draft.exercises.map((e) => ({ ...e.prescribed, name: e.name, sets: e.sets.length }));
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
        <button onClick={props.onClose} className="text-zinc-400 text-lg" aria-label="Close logger">‹</button>
        <div className="text-zinc-300 text-sm flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span>
          <span className="font-mono tabular-nums">{startedAt ? elapsedLabel : "0:00"}</span>
          <span>· {draft.session_type}</span>
        </div>
        <button onClick={() => setFinishOpen(true)} className="bg-green-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">
          Finish
        </button>
      </div>

      <div className="overflow-y-auto p-3 pb-32 flex-1">
        {diverged && (
          <button
            onClick={() => setSaveDefaultOpen(true)}
            className="w-full bg-blue-500/10 border border-blue-500/30 text-blue-400 rounded-lg py-2 text-xs mb-3"
          >
            Save deviations as my {draft.session_type} default
          </button>
        )}

        {draft.exercises.map((ex, i) => (
          <ExerciseCard
            key={`${ex.name}-${i}`}
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
                  set_index: j, kg: null, reps: null, warmup: false, failure: false, committed_at: null,
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
          durationMin={startedAt ? (Date.now() - startedAt) / 60000 : 0}
          saving={committing}
          onConfirm={commitNow}
          onCancel={() => setFinishOpen(false)}
        />
      )}
    </div>
  );
}
