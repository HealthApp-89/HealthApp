// lib/coach/proactive/check-training-undereat.ts
//
// Joins workouts × daily_logs over the last 28 days. A "lift day" is any
// date with a non-empty workout row. Undereating = kcal eaten on that
// date < (kcal_target − 300). Fires when ratio of undereating lift days
// over total lift days ≥ 0.50 AND total lift days ≥ 6.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  TRAINING_UNDEREAT_KCAL_GAP,
  TRAINING_UNDEREAT_HIT_RATIO,
  TRAINING_UNDEREAT_MIN_DAYS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export async function checkTrainingUndereat(
  trends: CoachTrendsPayload,
  args: { supabase: SupabaseClient; userId: string; today: string },
): Promise<ProactiveEvent[]> {
  const { supabase, userId, today } = args;
  const target = trends.nutrition.kcal.target;
  if (target == null) return [];

  const fourAgo = shiftDays(today, -28);

  // 1. Lift days = distinct workout dates with at least one non-empty session.
  const { data: workouts } = await supabase
    .from("workouts")
    .select("date")
    .eq("user_id", userId)
    .gte("date", fourAgo)
    .lte("date", today);
  const liftDates = new Set<string>(
    ((workouts as Array<{ date: string }> | null) ?? []).map((w) => w.date),
  );
  if (liftDates.size < TRAINING_UNDEREAT_MIN_DAYS) return [];

  // 2. Pull daily_logs for those dates only.
  const { data: logs } = await supabase
    .from("daily_logs")
    .select("date, calories_eaten")
    .eq("user_id", userId)
    .in("date", [...liftDates]);

  let undereatCount = 0;
  let observed = 0;
  for (const r of (logs as Array<{ date: string; calories_eaten: number | null }> | null) ?? []) {
    if (r.calories_eaten == null) continue;
    observed += 1;
    if (r.calories_eaten < target - TRAINING_UNDEREAT_KCAL_GAP) undereatCount += 1;
  }
  if (observed < TRAINING_UNDEREAT_MIN_DAYS) return [];
  const ratio = undereatCount / observed;
  if (ratio < TRAINING_UNDEREAT_HIT_RATIO) return [];

  return [{
    trigger_type: "training_day_undereat",
    trigger_key: "training_day_undereat",
    payload: {
      undereat_count: undereatCount,
      lift_days_observed: observed,
      ratio,
      kcal_target: target,
      gap_kcal: TRAINING_UNDEREAT_KCAL_GAP,
    },
  }];
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
