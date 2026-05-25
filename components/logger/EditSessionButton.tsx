"use client";

import { useState } from "react";
import { LoggerSheet } from "@/components/logger/LoggerSheet";
import { fetchWorkoutForEditBrowser } from "@/lib/data/fetch-workout-for-edit";
import { hydrateWorkoutAsDraft } from "@/lib/logger/hydrate-from-workout";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { LoggerDraft } from "@/lib/logger/types";

type Props = {
  workoutId: string;
  /** When false (or omitted), the button renders nothing. Caller decides
   *  eligibility (source === 'logger'). */
  eligible: boolean;
  /** Tailwind className passthrough so callers can tune spacing. */
  className?: string;
  /** Optional label override. Default: "Edit". */
  label?: string;
};

export function EditSessionButton(props: Props) {
  const [initialDraft, setInitialDraft] = useState<LoggerDraft | null>(null);
  const [loading, setLoading] = useState(false);

  if (!props.eligible) return null;

  async function openEdit() {
    setLoading(true);
    try {
      const workout = await fetchWorkoutForEditBrowser(props.workoutId);
      if (!workout) {
        alert("Workout not found.");
        return;
      }
      if (workout.source !== "logger") {
        alert("This workout can't be edited (not logger-sourced).");
        return;
      }
      // Best-effort plan resolution: weekday inferred from the workout's date.
      // weekOverrides null is acceptable — falls through to user template /
      // SESSION_PLANS via resolveSessionPlan.
      const weekdayLong = new Date(workout.date + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "long",
      });
      const supabase = createSupabaseBrowserClient();
      const resolved = await resolveSessionPlan({
        supabase,
        userId: workout.user_id,
        sessionType: workout.type ?? "",
        weekdayLong,
        weekOverrides: null,
      });
      const draft = hydrateWorkoutAsDraft(workout, resolved.exercises);
      setInitialDraft(draft);
    } catch (e) {
      console.error("EditSessionButton open failed", e);
      alert("Failed to open edit. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={openEdit}
        disabled={loading}
        className={
          props.className ??
          "text-[11px] font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-200 px-2 py-1 disabled:opacity-50"
        }
        aria-label="Edit session"
      >
        {loading ? "…" : (props.label ?? "Edit")}
      </button>

      {initialDraft && (
        <LoggerSheet
          userId={initialDraft.user_id}
          sessionType={initialDraft.session_type}
          date={initialDraft.date}
          weekdayLong={new Date(initialDraft.date + "T00:00:00").toLocaleDateString("en-US", {
            weekday: "long",
          })}
          weekOverrides={null}
          editMode={{ initialDraft }}
          onClose={() => setInitialDraft(null)}
        />
      )}
    </>
  );
}
