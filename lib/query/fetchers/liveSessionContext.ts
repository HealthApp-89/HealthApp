// lib/query/fetchers/liveSessionContext.ts
//
// Everything the between-sets coaching rules need, assembled in ONE round
// trip at logger open. Rules then run synchronously on each set commit, so
// nothing touches the network in the hot path — the feature keeps working
// when gym wifi drops.
//
// Consumed by lib/coach/live-session. See
// docs/superpowers/specs/2026-08-10-live-session-coaching-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";
import { normalizeExerciseName } from "@/lib/coach/exercise-muscles";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import { computeOlsSlope } from "@/lib/coach/prescription/calibrate-target";
import { mondayOfIso } from "@/lib/time/dates";
import type { LiveSessionContext } from "@/lib/coach/live-session/types";
import type { WorkoutSetSample, BlockPhase } from "@/lib/coach/prescription/types";
import type { TrainingBlock, PrimaryLift } from "@/lib/data/types";

/** PR comparison window. Long on purpose: a "best" computed over a short
 *  recency window silently resets after any training gap. */
const PR_WINDOW_DAYS = 180;
/** Rule-history window — matches the weekly prescription engine's. */
const HISTORY_WINDOW_DAYS = 28;

type Args = {
  userId: string;
  /** Today in the user's timezone, YYYY-MM-DD. */
  today: string;
  /** Exercise names as they appear in the logger draft. */
  exerciseNames: string[];
};

function daysBefore(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

type SetRowShape = {
  kg: number | null;
  reps: number | null;
  warmup: boolean | null;
  failure: boolean | null;
  rir: number | null;
};

/** A history set carrying the date it was performed — the week index for the
 *  OLS slope is derived from it. bestComparisonValue ignores the extra field. */
type DatedSet = SetRowShape & { performed_on: string };

/** Whether a (normalized) exercise name is an instance of the block's primary
 *  lift. Mirrors the switch in lib/query/fetchers/blockProgress.ts:liftMatches
 *  rather than a bare substring test — "ohp" as a PrimaryLift never appears as
 *  a substring of "overhead press" (the exercise library's actual name), so a
 *  naive `.includes(primary_lift)` silently fails to find the OHP block's lift
 *  and disables off_pace detection for every OHP-focused block. */
function matchesPrimaryLift(normalizedName: string, lift: PrimaryLift): boolean {
  switch (lift) {
    case "squat":
      return normalizedName.includes("squat");
    case "bench":
      return normalizedName.includes("bench") && normalizedName.includes("press");
    case "deadlift":
      return normalizedName.includes("deadlift");
    case "ohp":
      return (
        (normalizedName.includes("overhead") || normalizedName.includes("ohp")) &&
        normalizedName.includes("press")
      );
  }
}

const liveSessionContextFetcher = createFetcher(
  async (supabase: SupabaseClient, args: Args): Promise<LiveSessionContext> => {
    const names = args.exerciseNames.filter((n) => n.trim().length > 0);
    const empty: LiveSessionContext = {
      historyByExercise: {},
      bestByExercise: {},
      blockPhase: "pre_target",
      rirTarget: 2,
    };
    if (names.length === 0) return empty;

    const prFrom = daysBefore(args.today, PR_WINDOW_DAYS);
    const historyFrom = daysBefore(args.today, HISTORY_WINDOW_DAYS);

    const { data: workouts, error } = await supabase
      .from("workouts")
      .select(
        "date, exercises(name, exercise_sets(kg, reps, warmup, failure, rir))",
      )
      .eq("user_id", args.userId)
      .gte("date", prFrom)
      .lt("date", args.today)
      .order("date", { ascending: false });
    if (error) throw error;

    // Map normalized name -> draft name, so "Bench Press" in history resolves
    // to "Bench Press (Barbell)" in today's plan.
    const byNormalized = new Map<string, string>();
    for (const n of names) {
      const key = normalizeExerciseName(n);
      if (key) byNormalized.set(key, n);
    }

    const historyByExercise: Record<string, WorkoutSetSample[]> = {};
    const prSetsByExercise: Record<string, DatedSet[]> = {};
    for (const n of names) {
      historyByExercise[n] = [];
      prSetsByExercise[n] = [];
    }

    for (const w of workouts ?? []) {
      const date = w.date as string;
      const exercises = (w.exercises ?? []) as Array<{
        name: string;
        exercise_sets: SetRowShape[] | null;
      }>;
      for (const ex of exercises) {
        const draftName = byNormalized.get(normalizeExerciseName(ex.name));
        if (!draftName) continue;
        for (const s of ex.exercise_sets ?? []) {
          if (s.warmup) continue;
          if (s.kg == null || s.reps == null) continue;
          prSetsByExercise[draftName].push({ ...s, performed_on: date });
          if (date >= historyFrom) {
            historyByExercise[draftName].push({
              exercise_name: ex.name,
              exercise_key: null,
              kg: s.kg,
              reps: s.reps,
              warmup: false,
              failure: s.failure === true,
              performed_on: date,
              rir: s.rir,
            });
          }
        }
      }
    }

    const bestByExercise: Record<string, number | null> = {};
    for (const n of names) {
      bestByExercise[n] = bestComparisonValue(prSetsByExercise[n], "e1rm");
    }

    // Block phase. recentProgressionRatePerWeek is derived from the same
    // 180d set stream via the engine's own OLS helper, so the off_pace branch
    // is live rather than silently skipped.
    const { data: block, error: blockErr } = await supabase
      .from("training_blocks")
      .select("*")
      .eq("user_id", args.userId)
      .eq("status", "active")
      .maybeSingle();
    if (blockErr) throw blockErr;

    let blockPhase: BlockPhase = "pre_target";
    if (block) {
      const b = block as TrainingBlock;
      const liftName = names.find(
        (n) => b.primary_lift != null && matchesPrimaryLift(normalizeExerciseName(n), b.primary_lift),
      );
      const liftSets = liftName ? prSetsByExercise[liftName] : [];
      const metric = b.target_metric ?? "working_weight";
      const currentWorkingKg = bestComparisonValue(liftSets, metric);

      // Per-week max comparison value, week index measured from the window
      // start so it increases with time (computeOlsSlope requires 0-indexed,
      // monotonically increasing indices and >= 3 samples).
      const windowStartMs = Date.parse(`${prFrom}T00:00:00Z`);
      const perWeek = new Map<number, number>();
      for (const s of liftSets) {
        if (s.kg == null || s.reps == null) continue;
        const v = bestComparisonValue([s], metric);
        if (v == null) continue;
        const idx = Math.floor(
          (Date.parse(`${s.performed_on}T00:00:00Z`) - windowStartMs) / (7 * 86_400_000),
        );
        if (!Number.isFinite(idx)) continue;
        const prior = perWeek.get(idx);
        if (prior == null || v > prior) perWeek.set(idx, v);
      }
      const samples = [...perWeek.entries()]
        .map(([weekIndex, e1rm]) => ({ weekIndex, e1rm }))
        .sort((a, z) => a.weekIndex - z.weekIndex);

      blockPhase = evaluateBlockPhase({
        block: b,
        currentWorkingKg,
        recentProgressionRatePerWeek: computeOlsSlope(samples),
        todayIso: args.today,
      });
    }

    // rir_target for the current week. `?? 2` is the SAME fallback expression
    // prescribeWeek uses — that is what keeps the two from disagreeing.
    const { data: week, error: weekErr } = await supabase
      .from("training_weeks")
      .select("rir_target")
      .eq("user_id", args.userId)
      .eq("week_start", mondayOfIso(args.today))
      .maybeSingle();
    if (weekErr) throw weekErr;

    return {
      historyByExercise,
      bestByExercise,
      blockPhase,
      rirTarget: (week?.rir_target as number | null) ?? 2,
    };
  },
);

export const fetchLiveSessionContextServer = liveSessionContextFetcher.server;
export const fetchLiveSessionContextBrowser = liveSessionContextFetcher.browser;
