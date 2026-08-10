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
import { PRIMARY_LIFT_NAME_PATTERNS } from "@/lib/coach/prescription/current-comparison-value";
import { mondayOfIso, isoDaysAgo } from "@/lib/time/dates";
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

/** Resolve which of today's draft exercise names is the block's primary lift,
 *  using the canonical exact-name table (PRIMARY_LIFT_NAME_PATTERNS) rather
 *  than substring matching. Substring matching is a live bug here, not a
 *  style nit: "Romanian Deadlift (Barbell)" normalizes to "romanian deadlift",
 *  which CONTAINS "deadlift" — a naive substring test would pick the RDL
 *  (Legs day's second hinge) for a deadlift-focused block and compute
 *  currentWorkingKg / the OLS progression samples / blockPhase off the wrong
 *  lift on every Legs day. Same failure mode for squat blocks when Front/
 *  Hack/Goblet Squat is present, and bench blocks with incline/decline/
 *  close-grip variants.
 *
 *  Both sides are compared through normalizeExerciseName so a stored name and
 *  a plan name that differ only in case/spacing still line up. When more than
 *  one of today's exercises matches (bench has three patterns), the earliest
 *  entry in PRIMARY_LIFT_NAME_PATTERNS wins — that array is ordered by
 *  primacy (see its doc comment in current-comparison-value.ts). */
function resolvePrimaryLiftDraftName(
  names: readonly string[],
  lift: PrimaryLift,
): string | undefined {
  const patterns = PRIMARY_LIFT_NAME_PATTERNS[lift].map((p) => normalizeExerciseName(p));
  for (const pattern of patterns) {
    const match = names.find((n) => normalizeExerciseName(n) === pattern);
    if (match) return match;
  }
  return undefined;
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

    const prFrom = isoDaysAgo(args.today, PR_WINDOW_DAYS);
    const historyFrom = isoDaysAgo(args.today, HISTORY_WINDOW_DAYS);

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
      const liftName = b.primary_lift != null ? resolvePrimaryLiftDraftName(names, b.primary_lift) : undefined;
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
