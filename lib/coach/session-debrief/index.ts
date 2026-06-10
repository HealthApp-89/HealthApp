// lib/coach/session-debrief/index.ts
//
// Orchestrator. Loads the workout + sets, runs the 4 composers in parallel
// where independent (lifts + volume + autoregulation), then prescription
// (depends on lifts + volume), then the single narrative call. Returns the
// fully-assembled payload + narrative for the caller to persist.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SetRow } from "@/lib/coach/derived";
import type { TrainingBlock } from "@/lib/data/types";
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { composeLifts } from "@/lib/coach/session-debrief/compose-lifts";
import { composeVolume } from "@/lib/coach/session-debrief/compose-volume";
import { composeAutoregulation } from "@/lib/coach/session-debrief/compose-autoregulation";
import { composePrescription } from "@/lib/coach/session-debrief/compose-prescription";
import { generateNarrative } from "@/lib/coach/session-debrief/narrative-prompt";
import {
  tldrFromPayload,
  type WorkoutDebriefPayload,
} from "@/lib/coach/session-debrief/payload";

export type GenerateResult =
  | { ok: true; payload: WorkoutDebriefPayload }
  | { ok: false; skipped: "no_working_sets" | "no_exercises" };

export async function generateWorkoutDebrief(opts: {
  supabase: SupabaseClient;
  userId: string;
  workoutId: string;
}): Promise<GenerateResult> {
  const { supabase, userId, workoutId } = opts;

  // 1. Load the workout.
  const { data: workout, error: wErr } = await supabase
    .from("workouts")
    .select("id, date, type")
    .eq("id", workoutId)
    .eq("user_id", userId)
    .maybeSingle();
  if (wErr) throw new Error(`workout lookup failed: ${wErr.message}`);
  if (!workout) throw new Error(`workout ${workoutId} not found for user`);

  // 2. Load its exercises + sets.
  const { data: exs, error: exErr } = await supabase
    .from("exercises")
    .select("id, name, position")
    .eq("workout_id", workoutId)
    .order("position");
  if (exErr) throw new Error(`exercises lookup failed: ${exErr.message}`);
  if (!exs || exs.length === 0) return { ok: false, skipped: "no_exercises" };

  const { data: allSets, error: setsErr } = await supabase
    .from("exercise_sets")
    .select("exercise_id, kg, reps, duration_seconds, warmup, failure")
    .in(
      "exercise_id",
      exs.map((e) => e.id as string),
    );
  if (setsErr) throw new Error(`sets lookup failed: ${setsErr.message}`);

  const todayExercises: Array<{ name: string; sets: SetRow[] }> = exs.map((e) => ({
    name: e.name as string,
    sets: ((allSets ?? []) as Array<{ exercise_id: string } & SetRow>)
      .filter((s) => s.exercise_id === e.id)
      .map((s) => ({
        kg: s.kg,
        reps: s.reps,
        duration_seconds: s.duration_seconds,
        warmup: s.warmup,
        failure: s.failure,
      })),
  }));

  const totalWorking = todayExercises.reduce(
    (n, ex) => n + ex.sets.filter((s) => !s.warmup).length,
    0,
  );
  if (totalWorking === 0) return { ok: false, skipped: "no_working_sets" };

  // 3. Run composers in parallel where independent.
  const [lifts, volume, autoregulation, blockProgress, activeBlock] = await Promise.all([
    composeLifts({
      supabase,
      userId,
      workoutId,
      workoutDate: workout.date as string,
      sessionType: workout.type as string,
      todayExercises,
    }),
    composeVolume({
      supabase,
      userId,
      workoutId,
      workoutDate: workout.date as string,
      todayExercises,
    }),
    composeAutoregulation({
      supabase,
      userId,
      workoutDate: workout.date as string,
    }),
    computeBlockProgress(supabase, userId),
    loadActiveBlock(supabase, userId),
  ]);

  const block: WorkoutDebriefPayload["block"] = (() => {
    if (!blockProgress || "active" in blockProgress) {
      return { week_num: null, total_weeks: null, phase: null, rir_target: null, primary_lift: activeBlock?.primary_lift ?? null };
    }
    return {
      week_num: blockProgress.current_week,
      total_weeks: blockProgress.total_weeks,
      phase: blockProgress.research_phase,
      rir_target: blockProgress.rir_target,
      primary_lift: activeBlock?.primary_lift ?? null,
    };
  })();

  const prescription = composePrescription({
    sessionType: workout.type as string,
    lifts,
    volume,
    todayExercises,
    block: activeBlock,
    todayIso: workout.date as string,
  });

  // 4. Body comp (best-effort; null if unavailable).
  const body_comp = await loadBodyComp(supabase, userId);

  // 5. Assemble payload (without narrative / tldr) and generate narrative.
  const partial: Omit<WorkoutDebriefPayload, "narrative_md" | "tldr"> = {
    workout_id: workoutId,
    date: workout.date as string,
    session_type: workout.type as string,
    block,
    lifts,
    volume,
    autoregulation,
    body_comp,
    prescription,
  };

  const narrative_md = await generateNarrative(partial);
  const full: WorkoutDebriefPayload = {
    ...partial,
    narrative_md,
    tldr: "",
  };
  full.tldr = tldrFromPayload(full);

  return { ok: true, payload: full };
}

async function loadActiveBlock(
  supabase: SupabaseClient,
  userId: string,
): Promise<TrainingBlock | null> {
  const { data } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  return (data?.[0] as TrainingBlock | undefined) ?? null;
}

async function loadBodyComp(
  supabase: SupabaseClient,
  userId: string,
): Promise<WorkoutDebriefPayload["body_comp"]> {
  const tz = await getUserTimezone(userId);
  const today = todayInUserTz(new Date(), tz);
  const { data, error } = await supabase
    .from("daily_logs")
    .select("weight_kg, fat_free_mass_kg")
    .eq("user_id", userId)
    .lte("date", today)
    .not("weight_kg", "is", null)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    weight_kg: data.weight_kg as number | null,
    fat_free_mass_kg: data.fat_free_mass_kg as number | null,
    strength_per_lbm: null, // future iteration; needs a top-lift selection rule
  };
}
