// lib/coach/peter-dashboard/compose-plan-adherence.ts
//
// Plan adherence: sessions done vs prescribed (last 4 training_weeks)
// and food log coverage (% days with committed entries over last 14d).
// All deterministic.
//
// DEVIATION FROM PLAN: `training_weeks.adherence_pct` does NOT exist as a
// column on `training_weeks` (see supabase/migrations/0008_weekly_planning.sql).
// Adherence is computed on-demand via `computeAdherence(...)` from
// lib/coach/adherence.ts, which returns an integer 0-100. We fetch the last
// 4 week_starts, then Promise.all the per-week computeAdherence calls and
// store ratios (0-1) for direct comparison against the existing thresholds.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  ADHERENCE_PCT_WARN,
  ADHERENCE_PCT_URGENT,
  ADHERENCE_CONSECUTIVE_WEEKS,
} from './thresholds';
import { computeAdherence } from '@/lib/coach/adherence';
import { fmtNum } from '@/lib/ui/score';

const FOOD_WINDOW_DAYS = 14;

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

  // Food log coverage in last 14 days.
  const foodStart = isoDaysAgo(today, FOOD_WINDOW_DAYS - 1);
  const { data: foodDates, error: fErr } = await supabase
    .from('food_log_entries')
    .select('eaten_at')
    .eq('user_id', userId)
    .eq('status', 'committed')
    .gte('eaten_at', `${foodStart}T00:00:00Z`)
    .lte('eaten_at', `${today}T23:59:59Z`);
  if (fErr) throw fErr;
  const foodDays = new Set(
    (foodDates ?? []).map((f) => (f.eaten_at as string).slice(0, 10)),
  );
  const foodCoveragePct = foodDays.size / FOOD_WINDOW_DAYS;

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
    one_line: oneLineFor({ latestRatio, foodCoveragePct }),
    body_md: bodyMdFor({ weekly, foodCoveragePct, severity }),
    facts: {
      latest_week_adherence_pct: latestRatio == null ? null : round2(latestRatio),
      food_log_coverage_pct_14d: round2(foodCoveragePct),
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
      'food_log_entries (status=committed, 14d)',
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

function oneLineFor(x: { latestRatio: number | null; foodCoveragePct: number }): string {
  const adh = x.latestRatio == null ? '—' : `${fmtNum(x.latestRatio * 100, 0)}%`;
  const food = `${fmtNum(x.foodCoveragePct * 100, 0)}% food`;
  return `${adh} sessions · ${food}`;
}

function bodyMdFor(x: {
  weekly: Array<{ pct_ratio: number }>;
  foodCoveragePct: number;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') {
    return 'Sessions and food logging on track. Execution is not the issue.';
  }
  const pcts = x.weekly.map((w) => `${fmtNum(w.pct_ratio * 100, 0)}%`).join('/');
  return `Last weeks ${pcts} adherence. Food coverage ${fmtNum(x.foodCoveragePct * 100, 0)}% over 14d.`;
}
