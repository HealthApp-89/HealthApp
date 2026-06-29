// lib/coach/session-debrief/compose-lifts.ts
//
// Per-exercise comparison: today's top working set vs the same exercise's
// top set in the most recent prior workout of the same `type`. Computes
// e1RM delta and tags PR / stall / regression / null.
//
// Tag thresholds (informed by the 2026-05-22 spec):
//   PR        — best e1RM across the last 4 prior sessions of this type
//   regression — e1RM > 2% below prior session's top set
//   stall     — abs(delta) within 1% of prior session
//   null      — no prior data (first session of this type for this lift)
//
// All math is in terms of e1RM (Epley). Duration-based or out-of-range
// sets fall through to null e1RM and skip tagging.

import type { SupabaseClient } from "@supabase/supabase-js";
import { topSet, type SetRow } from "@/lib/coach/derived";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";

type ExerciseWithSets = {
  name: string;
  sets: SetRow[];
};

type ComposeLiftsInput = {
  supabase: SupabaseClient;
  userId: string;
  workoutId: string;
  workoutDate: string;        // YYYY-MM-DD
  sessionType: string;
  todayExercises: ExerciseWithSets[];
};

const PR_HISTORY_DEPTH = 4;          // how many prior sessions to scan for PR
const STALL_THRESHOLD_PCT = 0.01;    // ±1% of prior e1RM = stall
const REGRESSION_THRESHOLD_PCT = 0.02; // >2% below prior e1RM = regression

export async function composeLifts(
  input: ComposeLiftsInput,
): Promise<WorkoutDebriefPayload["lifts"]> {
  const { supabase, userId, workoutId, workoutDate, sessionType, todayExercises } = input;

  // Pull the last N prior workouts of the same session type (excluding today).
  // We need them all to detect a PR (best top e1RM across the window).
  const { data: priorWorkouts, error: pwErr } = await supabase
    .from("workouts")
    .select("id, date")
    .eq("user_id", userId)
    .eq("type", sessionType)
    .lt("date", workoutDate)
    .order("date", { ascending: false })
    .limit(PR_HISTORY_DEPTH);
  if (pwErr) throw new Error(`prior workouts lookup failed: ${pwErr.message}`);

  const priorWorkoutIds = (priorWorkouts ?? []).map((w) => w.id as string);

  // Pull all exercises across those prior workouts in one shot, then their sets.
  let priorExercises: Array<{ id: string; workout_id: string; name: string }> = [];
  let priorSets: Array<{ exercise_id: string; kg: number | null; reps: number | null; duration_seconds: number | null; warmup: boolean; failure: boolean; rir: number | null }> = [];
  if (priorWorkoutIds.length > 0) {
    const exRes = await supabase
      .from("exercises")
      .select("id, workout_id, name")
      .in("workout_id", priorWorkoutIds);
    if (exRes.error) throw new Error(`prior exercises lookup failed: ${exRes.error.message}`);
    priorExercises = (exRes.data ?? []) as typeof priorExercises;

    const exIds = priorExercises.map((e) => e.id);
    if (exIds.length > 0) {
      const setsRes = await supabase
        .from("exercise_sets")
        .select("exercise_id, kg, reps, duration_seconds, warmup, failure, rir")
        .in("exercise_id", exIds);
      if (setsRes.error) throw new Error(`prior sets lookup failed: ${setsRes.error.message}`);
      priorSets = (setsRes.data ?? []) as typeof priorSets;
    }
  }

  // Index: workout_id -> exercise_name -> sets[]
  const byWorkoutByName = new Map<string, Map<string, SetRow[]>>();
  for (const ex of priorExercises) {
    const wmap = byWorkoutByName.get(ex.workout_id) ?? new Map();
    wmap.set(ex.name.toLowerCase().trim(), []);
    byWorkoutByName.set(ex.workout_id, wmap);
  }
  for (const s of priorSets) {
    const ex = priorExercises.find((e) => e.id === s.exercise_id);
    if (!ex) continue;
    const wmap = byWorkoutByName.get(ex.workout_id);
    if (!wmap) continue;
    const arr = wmap.get(ex.name.toLowerCase().trim());
    if (!arr) continue;
    arr.push({
      kg: s.kg,
      reps: s.reps,
      duration_seconds: s.duration_seconds,
      warmup: s.warmup,
      failure: s.failure,
      rir: s.rir,
    });
  }

  // Pairwise comparable e1RM: use effort-adjusted values only when BOTH tops
  // carry RIR (symmetric — avoids a transition artifact where a held-back
  // session today would falsely outrank a pre-RIR to-failure session).
  const comparablePair = (
    a: { e1RM: number | null; e1RM_effort: number | null; rir: number | null } | null,
    b: { e1RM: number | null; e1RM_effort: number | null; rir: number | null } | null,
  ): [number | null, number | null] => {
    if (a?.rir != null && b?.rir != null) return [a.e1RM_effort, b.e1RM_effort];
    return [a?.e1RM ?? null, b?.e1RM ?? null];
  };

  // For each of today's exercises, build the lift entry.
  const lifts: WorkoutDebriefPayload["lifts"] = [];
  for (const todayEx of todayExercises) {
    const key = todayEx.name.toLowerCase().trim();
    const todayTop = topSet(todayEx.sets);

    // Find the most recent prior session that has this exercise.
    let lastTop: ReturnType<typeof topSet> = null;
    let lastDate: string | null = null;
    for (const pw of priorWorkouts ?? []) {
      const wmap = byWorkoutByName.get(pw.id as string);
      const sets = wmap?.get(key);
      if (sets && sets.length > 0) {
        const t = topSet(sets);
        if (t !== null) {
          lastTop = t;
          lastDate = pw.date as string;
          break;
        }
      }
    }

    // delta_e1rm is always in RAW terms (physically meaningful kg delta).
    const todayE1rm = todayTop?.e1RM ?? null;
    const lastE1rm = lastTop?.e1RM ?? null;
    const deltaE1rm = todayE1rm != null && lastE1rm != null
      ? Math.round((todayE1rm - lastE1rm) * 10) / 10
      : null;

    // Regression / stall: compare today vs most recent prior on the same footing.
    const [todayCmpLast, lastCmp] = comparablePair(todayTop, lastTop);

    // PR detection: find the best prior session's top set (by its pairwise-
    // comparable value vs today), then compare today vs that best on the same
    // footing. This keeps the comparison symmetric per-pair.
    let tag: "PR" | "stall" | "regression" | null = null;
    let bestPriorTop: ReturnType<typeof topSet> = null;
    let bestPriorCmp: number | null = null;
    for (const pw of priorWorkouts ?? []) {
      const wmap = byWorkoutByName.get(pw.id as string);
      const sets = wmap?.get(key);
      if (sets && sets.length > 0) {
        const t = topSet(sets);
        const [, priorCmp] = comparablePair(todayTop, t);
        if (priorCmp != null && (bestPriorCmp == null || priorCmp > bestPriorCmp)) {
          bestPriorCmp = priorCmp;
          bestPriorTop = t;
        }
      }
    }

    const [todayCmpBest, bestCmp] = comparablePair(todayTop, bestPriorTop);
    if (todayCmpBest != null && bestCmp != null && todayCmpBest > bestCmp) {
      tag = "PR";
    } else if (todayCmpLast != null && lastCmp != null) {
      const ratio = todayCmpLast / lastCmp;
      if (ratio < 1 - REGRESSION_THRESHOLD_PCT) tag = "regression";
      else if (Math.abs(ratio - 1) <= STALL_THRESHOLD_PCT) tag = "stall";
    }

    lifts.push({
      name: todayEx.name,
      top_set_today: {
        kg: todayTop?.kg ?? null,
        reps: todayTop?.reps ?? null,
        e1rm: todayE1rm,
      },
      top_set_last: {
        kg: lastTop?.kg ?? null,
        reps: lastTop?.reps ?? null,
        e1rm: lastE1rm,
        date: lastDate,
      },
      delta_e1rm: deltaE1rm,
      rir_today: todayTop?.rir ?? null,
      tag,
    });
  }

  return lifts;
}
