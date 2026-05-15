// lib/morning/brief/data-sources.ts
//
// Parallel data fetcher for the morning brief. Single Promise.all over
// 6 reads — kept tight so the brief generation pipeline stays under ~200ms
// before the AI call.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AthleteProfileDocument,
  CheckinRow,
  DailyLog,
  IntensityModifier,
  PrimaryLift,
  TrainingBlock,
  TrainingWeek,
  WeeklyReviewRow,
} from "@/lib/data/types";
import { WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
import { weekdayInUserTz } from "@/lib/time";
import { getTodayTargets, type TodayTargets } from "@/lib/morning/brief/get-today-targets";
import type { BriefInputs, YesterdayWorkoutSummary, WhoopBaselineForBand } from "@/lib/morning/brief/assembler";

const PRIMARY_LIFT_REGEX: Record<PrimaryLift, RegExp> = {
  squat: /\b(back\s+squat|squat)\b/i,
  bench: /\b(bench\s+press|bench)\b/i,
  deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
  ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
};

function epley(kg: number, reps: number): number | null {
  if (reps <= 0 || reps > 12) return null;
  return Math.round(kg * (1 + reps / 30));
}

function inferLiftFromName(name: string): PrimaryLift | null {
  for (const lift of ["squat", "bench", "deadlift", "ohp"] as const) {
    if (PRIMARY_LIFT_REGEX[lift].test(name)) return lift;
  }
  return null;
}

/** Maps a Date object to the keys used in WEEKLY_SESSIONS ("Monday".."Sunday").
 *  weekdayInUserTz returns the same shape. */
function weeklySessionKey(today: string): string {
  return weekdayInUserTz(new Date(`${today}T12:00:00Z`));
}

function yesterdayOf(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function fetchBriefInputs(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<BriefInputs> {
  const yesterday = yesterdayOf(today);
  const weeklyKey = weeklySessionKey(today);  // "Monday".."Sunday"

  // Parallel reads (Promise.all):
  // 1. Active training_blocks (for primary_lift)
  // 2. Training_week containing today (for session_plan + intensity_modifier)
  // 3. Today's targets (via athlete_profile_documents abstraction)
  // 4. Yesterday's daily_log
  // 5. Yesterday's workouts
  // 6. Today's checkin
  // 7. Today's daily_log
  // 8. Profile (for whoop_baselines)
  // 9. Active athlete_profile_document (for flags input)
  const [
    activeBlockRes,
    trainingWeekRes,
    todayTargets,
    yesterdayLogRes,
    yesterdayWorkoutsRes,
    todayCheckinRes,
    todayLogRes,
    profileRes,
    activeAthleteProfileRes,
  ] = await Promise.all([
    supabase
      .from("training_blocks")
      .select("id, primary_lift")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("training_weeks")
      .select("session_plan, intensity_modifier, week_start")
      .eq("user_id", userId)
      .lte("week_start", today)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getTodayTargets(supabase, userId),
    supabase
      .from("daily_logs")
      .select("*")
      .eq("user_id", userId)
      .eq("date", yesterday)
      .maybeSingle(),
    supabase
      .from("workouts")
      .select("id, type, exercises (name, sets:exercise_sets (kg, reps, warmup))")
      .eq("user_id", userId)
      .eq("date", yesterday),
    supabase
      .from("checkins")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .maybeSingle(),
    supabase
      .from("profiles")
      .select("whoop_baselines")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("athlete_profile_documents")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
  ]);

  // Throw on any read error (consistent with codebase fetcher pattern).
  for (const r of [
    activeBlockRes, trainingWeekRes, yesterdayLogRes, yesterdayWorkoutsRes,
    todayCheckinRes, todayLogRes, profileRes, activeAthleteProfileRes,
  ]) {
    if (r.error) throw r.error;
  }

  // Resolve session type with training_weeks → WEEKLY_SESSIONS fallback.
  const activeBlock = activeBlockRes.data as Pick<TrainingBlock, "id" | "primary_lift"> | null;
  const trainingWeek = trainingWeekRes.data as Pick<TrainingWeek, "session_plan" | "intensity_modifier" | "week_start"> | null;
  let sessionType: string;
  let intensityModifier: IntensityModifier = {};
  if (trainingWeek && isWeekStartCoveringToday(trainingWeek.week_start, today)) {
    // Dual-key defensive lookup — see lib/coach/session-plan-reader.ts for the
    // full explanation of the 3-letter vs full-name key convention drift.
    const sessionPlan = (trainingWeek.session_plan ?? {}) as Record<string, string>;
    sessionType =
      readSessionForDay(sessionPlan, weeklyKey) ??
      WEEKLY_SESSIONS[weeklyKey] ??
      "REST";
    intensityModifier = (trainingWeek.intensity_modifier ?? {}) as IntensityModifier;
  } else {
    sessionType = WEEKLY_SESSIONS[weeklyKey] ?? "REST";
  }

  // Aggregate yesterday's workouts into a YesterdayWorkoutSummary.
  const yesterdayWorkout = aggregateYesterdayWorkout(yesterdayWorkoutsRes.data as Array<{
    id: string;
    type: string | null;
    exercises: Array<{ name: string; sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }> }>;
  }> | null);

  return {
    today,
    yesterday,
    sessionType,
    sessionStartTime: sessionType === "REST" ? null : "13:00", // spec-locked default; configurable in v1.1
    intensityModifier,
    primaryLift: activeBlock?.primary_lift ?? null,
    todayTargets,
    yesterdayLog: yesterdayLogRes.data as DailyLog | null,
    yesterdayWorkout,
    todayCheckin: todayCheckinRes.data as CheckinRow | null,
    todayLog: todayLogRes.data as DailyLog | null,
    whoopBaselines: (profileRes.data as { whoop_baselines?: WhoopBaselineForBand } | null)?.whoop_baselines ?? null,
    activeProfile: activeAthleteProfileRes.data as AthleteProfileDocument | null,
    hasTrainingWeek: trainingWeek !== null && isWeekStartCoveringToday(trainingWeek.week_start, today),
    // The four sub-project #2 fields are populated by the orchestrator
    // (`buildMorningBrief`) before it calls `assembleBriefExceptAdvice` —
    // they require additional queries (this-week prescription, yesterday
    // workout flat shape, prior-week review for phase transition) that
    // live in the orchestrator's parallel fetch. Defaulted here so the
    // base fetcher's return remains a valid `BriefInputs` for typecheck;
    // the orchestrator overwrites these via spread before assembly.
    thisWeekPrescription: null,
    yesterdayWorkoutForBlock: null,
    swapAppliedYesterday: false,
    phaseTransitionThisWeek: false,
  };
}

/** A training_week's week_start covers today if today is in [week_start, week_start + 6d]. */
function isWeekStartCoveringToday(weekStart: string, today: string): boolean {
  const ws = new Date(`${weekStart}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const diffDays = Math.round((t - ws) / 86_400_000);
  return diffDays >= 0 && diffDays <= 6;
}

function aggregateYesterdayWorkout(
  workouts: Array<{
    id: string;
    type: string | null;
    exercises: Array<{ name: string; sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }> }>;
  }> | null,
): YesterdayWorkoutSummary | null {
  if (!workouts || workouts.length === 0) return null;
  // Single workout per day expected; take the first.
  const w = workouts[0];
  let topE1rm: { lift: string; kg: number } | null = null;
  for (const ex of w.exercises ?? []) {
    const lift = inferLiftFromName(ex.name);
    if (!lift) continue;
    for (const s of ex.sets ?? []) {
      if (s.warmup) continue;
      if (s.kg === null || s.reps === null) continue;
      const e1rm = epley(s.kg, s.reps);
      if (e1rm !== null && (topE1rm === null || e1rm > topE1rm.kg)) {
        topE1rm = { lift, kg: e1rm };
      }
    }
  }
  return {
    type: w.type,
    top_e1rm: topE1rm,
  };
}

// ── This-week prescription (sub-project #2) ─────────────────────────────────

/**
 * Read this week's prescription. Returns the current `training_weeks` row
 * for the week containing today + the latest `committed` `weekly_reviews`
 * row for that same `week_start`. Used by the brief assembler to populate
 * the kickoff block on Monday and to anchor today's prescribed loads on
 * Tue-Sat.
 *
 * Returns null when either:
 *   - no `training_weeks` row exists for today's week, OR
 *   - no `committed` `weekly_reviews` row exists for that week.
 *
 * Caller should gracefully fall back to legacy 'training' variant.
 */
export async function getThisWeekPrescription(
  supabase: SupabaseClient,
  userId: string,
  today: string,           // "YYYY-MM-DD"
): Promise<{ trainingWeek: TrainingWeek; review: WeeklyReviewRow } | null> {
  const weekStart = mondayOf(today);

  const [twResult, revResult] = await Promise.all([
    supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle(),
    supabase
      .from("weekly_reviews")
      .select(`
        id, user_id, week_start, next_week_start, version, status, block_id,
        payload, narrative_md, reconfirm_responses,
        committed_at, committed_training_week_id,
        generated_at, updated_at, created_at
      `)
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .eq("status", "committed")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (twResult.error) throw twResult.error;
  if (revResult.error) throw revResult.error;

  const trainingWeek = twResult.data as TrainingWeek | null;
  const review = revResult.data as WeeklyReviewRow | null;
  if (!trainingWeek || !review) return null;

  // Defensive: if the review was committed against a different (likely deleted
  // and recreated) training_weeks row, treat the prescription as unavailable
  // rather than pairing a fresh blank row with an old committed review.
  if (review.committed_training_week_id && review.committed_training_week_id !== trainingWeek.id) {
    return null;
  }
  return { trainingWeek, review };
}
