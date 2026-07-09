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
import type { EnduranceSessionPlan } from "@/lib/coach/endurance/types";
import { WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
import { weekdayInUserTz } from "@/lib/time";
import { getTodayTargets, type TodayTargets } from "@/lib/morning/brief/get-today-targets";
import type { BriefInputs, YesterdayWorkoutSummary, WhoopBaselineForBand } from "@/lib/morning/brief/assembler";
import type { YesterdayWorkoutForBlock } from "@/lib/morning/brief/yesterday-vs-plan";
import { loadPlannedActivities } from "@/lib/coach/activity/read-planned";
import { activityRegions, recoveryWindowHours } from "@/lib/coach/activity/model";
import type { RecentActivitySignal } from "@/lib/coach/activity/reactive-ladder";

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
function weeklySessionKey(today: string, tz: string): string {
  return weekdayInUserTz(new Date(`${today}T12:00:00Z`), tz);
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
  tz: string,
): Promise<BriefInputs> {
  const yesterday = yesterdayOf(today);
  const weeklyKey = weeklySessionKey(today, tz);  // "Monday".."Sunday"

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

  const wb = (profileRes.data as { whoop_baselines?: WhoopBaselineForBand } | null)?.whoop_baselines ?? null;
  const hrvBaseline = typeof wb?.hrv_6mo_avg === "number" ? wb.hrv_6mo_avg : 33;

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
    whoopBaselines: wb,
    hrvBaseline,
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
    thisWeekEndurancePlan: null,
    yesterdayWorkoutForBlock: null,
    swapAppliedYesterday: false,
    phaseTransitionThisWeek: false,
    // Populated by the orchestrator (prepareBriefExceptAdvice) in parallel
    // with other sub-project fields. Defaulted empty so the base fetcher's
    // return is a valid BriefInputs; the orchestrator overwrites via spread.
    recentActivity: [],
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
 * for the week containing today, paired with the latest `committed`
 * `weekly_reviews` row for that same `week_start` when one exists.
 * Used by the brief assembler to:
 *   - populate session numbers unconditionally (trainingWeek always present)
 *   - populate the kickoff / analytical ritual blocks only when review is
 *     non-null (those are review-gated to stay byte-identical to before)
 *
 * Returns null ONLY when no `training_weeks` row exists for today's week.
 * When the training_weeks row exists but the committed review is missing
 * (or row-mismatch defensive case below), returns { trainingWeek, review: null }.
 *
 * Caller should fall back to legacy 'training' variant ONLY when the whole
 * pair is null.
 */
export async function getThisWeekPrescription(
  supabase: SupabaseClient,
  userId: string,
  today: string,           // "YYYY-MM-DD"
): Promise<{ trainingWeek: TrainingWeek; review: WeeklyReviewRow | null } | null> {
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

  // No training_weeks row → still no session data; full null is the right signal.
  if (!trainingWeek) return null;

  // Defensive: if the review was committed against a different (likely deleted
  // and recreated) training_weeks row, treat the ritual blocks as unavailable
  // by returning review: null — the session numbers still come from the row.
  if (review && review.committed_training_week_id && review.committed_training_week_id !== trainingWeek.id) {
    return { trainingWeek, review: null };
  }

  return { trainingWeek, review };
}

/**
 * Read this week's prescribed endurance plan from `training_weeks` directly,
 * keyed only on the current Monday — independent of `weekly_reviews` state.
 *
 * Distinct from `getThisWeekPrescription` (above), which gates on a committed
 * `weekly_reviews` row. `commit_endurance_week` writes to `training_weeks`
 * without touching `weekly_reviews`, so reading the endurance plan through
 * the prescription gate would silently drop Carter's prescriptions for any
 * week without a committed review. The brief's endurance block stands on
 * its own data source.
 *
 * Returns null when no `training_weeks` row exists for this week or when the
 * row's `endurance_session_plan` is null.
 */
export async function getThisWeekEndurancePlan(
  supabase: SupabaseClient,
  userId: string,
  today: string,           // "YYYY-MM-DD"
): Promise<EnduranceSessionPlan | null> {
  const weekStart = mondayOf(today);
  const { data, error } = await supabase
    .from("training_weeks")
    .select("endurance_session_plan")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;
  return (data?.endurance_session_plan ?? null) as EnduranceSessionPlan | null;
}

/** Reads yesterday's workout in the flat shape composeYesterdayVsPlan expects.
 *  Distinct from the aggregated YesterdayWorkoutSummary in the main fetchBrief
 *  fan-out (which exposes only top_e1rm). The flat shape exposes every working
 *  set so the analytical block can compare per-lift planned vs actual.
 *
 *  Returns null when no workout was logged for the date. */
export async function getYesterdayWorkoutFlat(
  supabase: SupabaseClient,
  userId: string,
  yesterday: string,
): Promise<YesterdayWorkoutForBlock | null> {
  type Row = {
    type: string | null;
    exercises: Array<{
      name: string;
      sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }>;
    }>;
  };
  // The `workouts` table doesn't enforce a unique constraint on
  // (user_id, date), so .maybeSingle() throws PGRST116 when two rows happen
  // to exist for the same day. Use order/limit instead and pick the first —
  // mirrors the pattern in fetchBriefInputs which reads workouts[0].
  const { data, error } = await supabase
    .from("workouts")
    .select("type, exercises (name, sets:exercise_sets (kg, reps, warmup))")
    .eq("user_id", userId)
    .eq("date", yesterday)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  const row = data[0] as Row;
  const flat: YesterdayWorkoutForBlock = {
    type: row.type ?? "",
    sets: row.exercises.flatMap((ex) =>
      ex.sets.map((s) => ({
        exercise: ex.name,
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
      })),
    ),
  };
  return flat;
}

/**
 * Loads recent activities for today's week and converts them to
 * `RecentActivitySignal[]` for the reactive ladder.
 *
 * Conversion: for each PlannedActivity with a date BEFORE today, compute
 * whether the activity is still within its recovery window as of the
 * moment `today` starts (midnight of today in UTC).
 *
 * Graceful: any DB error returns [] so the reactive ladder falls back
 * to its grace-rule (no signals → none rung → existing brief unchanged).
 */
export async function loadRecentActivityForBrief(
  supabase: SupabaseClient,
  userId: string,
  today: string,       // "YYYY-MM-DD" in user's timezone
): Promise<RecentActivitySignal[]> {
  try {
    const weekStart = mondayOf(today);

    // Fetch the minimal training_weeks fields needed by loadPlannedActivities.
    const { data: twData, error: twErr } = await supabase
      .from("training_weeks")
      .select("week_start, planned_activities")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();

    if (twErr) return [];
    if (!twData) return [];

    const week = twData as Pick<TrainingWeek, "week_start" | "planned_activities">;
    const allActivities = await loadPlannedActivities(supabase, userId, week, today);

    // Convert to RecentActivitySignal[]: keep only activities before today
    // that load at least one muscle region (type="other" loads nothing).
    const todayMs = new Date(`${today}T00:00:00Z`).getTime();

    return allActivities
      .filter((a) => {
        if (a.date >= today) return false; // exclude today and future
        const regions = activityRegions(a.type);
        return regions.length > 0;
      })
      .map((a): RecentActivitySignal => {
        const actMs = new Date(`${a.date}T00:00:00Z`).getTime();
        const elapsedHours = (todayMs - actMs) / 3_600_000;
        const windowHours = recoveryWindowHours(a.type, a.intensity_estimate);
        return {
          regions: activityRegions(a.type),
          intensity: a.intensity_estimate,
          withinRecoveryWindow: elapsedHours < windowHours,
        };
      });
  } catch {
    // Graceful: any uncaught error → empty signals → grace rule fires.
    return [];
  }
}

/** Reads the most recent committed weekly_review for the week immediately
 *  before `weekStart`. Used by the orchestrator to derive
 *  phase_transition_this_week. Returns null when no prior committed review
 *  exists (first-ever week → upstream flag treats as a transition). */
export async function getPreviousCommittedReview(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string,        // Monday of THIS week ("YYYY-MM-DD")
): Promise<WeeklyReviewRow | null> {
  const prevMonday = new Date(`${weekStart}T12:00:00Z`);
  prevMonday.setUTCDate(prevMonday.getUTCDate() - 7);
  const prev = prevMonday.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("weekly_reviews")
    .select(`
      id, user_id, week_start, next_week_start, version, status, block_id,
      payload, narrative_md, reconfirm_responses,
      committed_at, committed_training_week_id,
      generated_at, updated_at, created_at
    `)
    .eq("user_id", userId)
    .eq("week_start", prev)
    .eq("status", "committed")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as WeeklyReviewRow | null;
}
