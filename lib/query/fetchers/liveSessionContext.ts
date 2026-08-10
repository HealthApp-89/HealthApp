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
import { computeWholeBlockPhase } from "@/lib/coach/prescription/whole-block-phase";
import { mondayOfIso, isoDaysAgo } from "@/lib/time/dates";
import type { LiveSessionContext } from "@/lib/coach/live-session/types";
import type { WorkoutSetSample, BlockPhase } from "@/lib/coach/prescription/types";
import type { TrainingBlock, TrainingWeek } from "@/lib/data/types";

/** PR comparison window. Long on purpose: a "best" computed over a short
 *  recency window silently resets after any training gap, which would
 *  manufacture fake PRs. Used for bestByExercise and NOTHING else — the block
 *  phase deliberately does not see this window (see below). */
const PR_WINDOW_DAYS = 180;
/** Rule-history window — matches the weekly prescription engine's. Both
 *  historyByExercise and every input to the block-phase computation are cut
 *  to it. */
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

/** A history set carrying the date it was performed. bestComparisonValue
 *  ignores the extra field. */
type DatedSet = SetRowShape & { performed_on: string };

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
        "date, exercises(name, exercise_sets(kg, reps, warmup, failure, rir, set_index))",
      )
      .eq("user_id", args.userId)
      .gte("date", prFrom)
      .lt("date", args.today)
      .order("date", { ascending: false })
      // Same contractual ordering prescribeWeek's fetchRecentSets declares.
      // The 28d stream below is handed to the same engine helpers, and
      // estimateProgressionRate reads samples[0] as the newest.
      .order("set_index", { referencedTable: "exercises.exercise_sets", ascending: true });
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

    // Every set in the 28-day window, across ALL exercises — not only the ones
    // in today's draft. This is the stream the block-phase computation
    // consumes, and it resolves the focus lift from the WEEK's session_plan,
    // which may well name a lift today's session does not contain. Newest
    // first, matching the query order and prescribeWeek's fetchRecentSets.
    const recentSets28: WorkoutSetSample[] = [];

    for (const w of workouts ?? []) {
      const date = w.date as string;
      const exercises = (w.exercises ?? []) as Array<{
        name: string;
        exercise_sets: SetRowShape[] | null;
      }>;
      const within28d = date >= historyFrom;
      for (const ex of exercises) {
        const draftName = byNormalized.get(normalizeExerciseName(ex.name));
        for (const s of ex.exercise_sets ?? []) {
          if (s.kg == null || s.reps == null) continue;
          if (within28d) {
            recentSets28.push({
              exercise_name: ex.name,
              exercise_key: null,
              kg: s.kg,
              reps: s.reps,
              warmup: !!s.warmup,
              failure: !!s.failure,
              performed_on: date,
              rir: s.rir ?? null,
            });
          }
          if (s.warmup) continue;
          if (!draftName) continue;
          prSetsByExercise[draftName].push({ ...s, performed_on: date });
          if (within28d) {
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

    // rir_target + session_plan for the current week. `?? 2` is the SAME
    // fallback expression prescribeWeek uses — that is what keeps the two from
    // disagreeing.
    const { data: week, error: weekErr } = await supabase
      .from("training_weeks")
      .select("rir_target, session_plan")
      .eq("user_id", args.userId)
      .eq("week_start", mondayOfIso(args.today))
      .maybeSingle();
    if (weekErr) throw weekErr;
    const rirTarget = (week?.rir_target as number | null) ?? 2;

    const { data: block, error: blockErr } = await supabase
      .from("training_blocks")
      .select("*")
      .eq("user_id", args.userId)
      .eq("status", "active")
      .maybeSingle();
    if (blockErr) throw blockErr;

    // Block phase comes from the engine's own function, not a local
    // re-derivation. The live rule gates load calls on this value, so any
    // divergence means the coach offers a load increase on a set the weekly
    // engine froze. computeWholeBlockPhase resolves the focus lift from the
    // week's session_plan and reads BOTH currentWorkingKg and the progression
    // rate off the 28-day stream. The 180-day window above is for PR
    // comparison only and is deliberately not visible here — a 180d max reads
    // a lift the athlete has since detrained away from as current.
    const b = block as TrainingBlock | null;
    const blockPhase: BlockPhase =
      b != null && b.primary_lift != null
        ? computeWholeBlockPhase({
            block: b,
            focusLift: b.primary_lift,
            week: { session_plan: (week?.session_plan ?? null) as TrainingWeek["session_plan"] },
            recentSets: recentSets28,
            rirTarget,
            todayIso: args.today,
          })
        : "pre_target";

    return {
      historyByExercise,
      bestByExercise,
      blockPhase,
      rirTarget,
    };
  },
);

export const fetchLiveSessionContextServer = liveSessionContextFetcher.server;
export const fetchLiveSessionContextBrowser = liveSessionContextFetcher.browser;
