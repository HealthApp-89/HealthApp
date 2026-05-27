// lib/coach/peter-dashboard/compose-plan-adherence.ts
//
// Plan adherence: sessions done vs prescribed (last 4 training_weeks)
// and nutrition coverage (% days with any kcal recorded over last 14d).
// All deterministic.
//
// DEVIATION FROM PLAN: `training_weeks.adherence_pct` does NOT exist as a
// column on `training_weeks` (see supabase/migrations/0008_weekly_planning.sql).
// Adherence is computed on-demand via `computeAdherence(...)` from
// lib/coach/adherence.ts, which returns an integer 0-100. We fetch the last
// 4 week_starts, then Promise.all the per-week computeAdherence calls and
// store ratios (0-1) for direct comparison against the existing thresholds.
//
// Nutrition coverage reads daily_logs.calories_eaten (source-agnostic) instead
// of counting committed food_log_entries directly. Both Yazio CSV ingest and
// in-app meal logging eventually update daily_logs.calories_eaten, so this
// counts a day as "logged" regardless of which entry path the user used.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  ADHERENCE_PCT_WARN,
  ADHERENCE_PCT_URGENT,
  ADHERENCE_CONSECUTIVE_WEEKS,
} from './thresholds';
import { computeAdherence } from '@/lib/coach/adherence';
import { fmtNum } from '@/lib/ui/score';

const NUTRITION_WINDOW_DAYS = 14;

export async function composePlanAdherence(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ThemePayload> {
  const { supabase, userId, today } = args;

  // Last 4 training_weeks (week_start only — adherence is derived).
  const { data: weeks, error: wErr } = await supabase
    .from('training_weeks')
    .select('week_start')
    .eq('user_id', userId)
    .lte('week_start', today)
    .order('week_start', { ascending: false })
    .limit(4);
  if (wErr) throw wErr;

  const weekStarts = (weeks ?? [])
    .map((w) => w.week_start as string)
    .reverse();

  // Parallelize the per-week computeAdherence calls.
  const adherenceResults = await Promise.all(
    weekStarts.map((ws) => computeAdherence(supabase, userId, ws)),
  );

  // Store as ratio (0-1) for direct comparison with the 0-1 thresholds.
  const weekly = weekStarts.map((ws, i) => ({
    week_start: ws,
    pct_ratio: adherenceResults[i].adherence_pct / 100,
  }));

  // Nutrition coverage in last 14 days. Source-agnostic: counts any day
  // with calories_eaten > 0 on daily_logs (Yazio + in-app + manual all land
  // there). The earlier food_log_entries-only count under-reported users on
  // the Yazio CSV path by ~70%.
  const nutritionStart = isoDaysAgo(today, NUTRITION_WINDOW_DAYS - 1);
  const { data: nutritionRows, error: nErr } = await supabase
    .from('daily_logs')
    .select('date, calories_eaten')
    .eq('user_id', userId)
    .gte('date', nutritionStart)
    .lte('date', today);
  if (nErr) throw nErr;
  const nutritionDays = (nutritionRows ?? []).filter(
    (r) => (r.calories_eaten as number | null) != null && (r.calories_eaten as number) > 0,
  ).length;
  const nutritionCoveragePct = nutritionDays / NUTRITION_WINDOW_DAYS;

  // Severity from weekly adherence trend (last N consecutive weeks).
  const recent = weekly.slice(-ADHERENCE_CONSECUTIVE_WEEKS);
  const allBelowUrgent =
    recent.length >= ADHERENCE_CONSECUTIVE_WEEKS &&
    recent.every((w) => w.pct_ratio < ADHERENCE_PCT_URGENT);
  const allBelowWarn =
    recent.length >= ADHERENCE_CONSECUTIVE_WEEKS &&
    recent.every((w) => w.pct_ratio < ADHERENCE_PCT_WARN);

  let severity: ThemePayload['severity'];
  if (allBelowUrgent) severity = 'urgent';
  else if (allBelowWarn) severity = 'warn';
  else severity = 'ok';

  const latestRatio = weekly[weekly.length - 1]?.pct_ratio ?? null;

  return {
    key: 'plan_adherence',
    severity,
    one_line: oneLineFor({ latestRatio, nutritionCoveragePct }),
    body_md: bodyMdFor({ weekly, nutritionCoveragePct, severity }),
    facts: {
      latest_week_adherence_pct: latestRatio == null ? null : round2(latestRatio),
      nutrition_coverage_pct_14d: round2(nutritionCoveragePct),
      training_weeks_considered: weekly.length,
    },
    sparkline:
      weekly.length >= 2
        ? {
            label: 'Weekly adherence',
            series: weekly.map((w) => ({ x: w.week_start, y: round2(w.pct_ratio) })),
          }
        : null,
    inputs_used: [
      'training_weeks.week_start',
      'computeAdherence(workouts, training_weeks)',
      'daily_logs.calories_eaten (14d)',
    ],
  };
}

function isoDaysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function oneLineFor(x: { latestRatio: number | null; nutritionCoveragePct: number }): string {
  const adh = x.latestRatio == null ? '—' : `${fmtNum(x.latestRatio * 100, 0)}%`;
  const food = `${fmtNum(x.nutritionCoveragePct * 100, 0)}% nutrition`;
  return `${adh} sessions · ${food}`;
}

function bodyMdFor(x: {
  weekly: Array<{ pct_ratio: number }>;
  nutritionCoveragePct: number;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') {
    return 'Sessions and nutrition logging on track. Execution is not the issue.';
  }
  const pcts = x.weekly.map((w) => `${fmtNum(w.pct_ratio * 100, 0)}%`).join('/');
  return `Last weeks ${pcts} adherence. Nutrition coverage ${fmtNum(x.nutritionCoveragePct * 100, 0)}% over 14d.`;
}
