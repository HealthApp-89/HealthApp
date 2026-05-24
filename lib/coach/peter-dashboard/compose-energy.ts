// lib/coach/peter-dashboard/compose-energy.ts
//
// Energy availability: intake vs target, split by training-day vs rest-day,
// with GLP-1 mode awareness. Reads daily_logs aggregations + getTodayTargets
// + workouts presence-per-date for the rest/training split.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  ENERGY_UNDER_TARGET_KCAL,
  ENERGY_UNDER_WINDOW_DAYS_WARN,
  ENERGY_GLP1_DEFICIT_PCT_TDEE_URGENT,
} from './thresholds';
import { getTodayTargets } from '@/lib/morning/brief/get-today-targets';
import { fmtNum } from '@/lib/ui/score';

const WINDOW_DAYS = 14;

export async function composeEnergy(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ThemePayload> {
  const { supabase, userId, today } = args;
  const start = isoDaysAgo(today, WINDOW_DAYS - 1);

  // Targets — kcal target + GLP-1 mode.
  // getTodayTargets takes (supabase, userId); "today" comes from todayInUserTz()
  // inside the helper. The `today` arg here drives our 14d window only.
  const targets = await getTodayTargets(supabase, userId);
  const kcalTarget = targets?.kcal ?? null;
  const isGlp1Active =
    targets?.mode === 'glp1_active' || targets?.mode === 'glp1_tapering';

  // 14d of daily_logs (kcal + active_calories for TDEE estimate).
  const { data: logs, error: logsErr } = await supabase
    .from('daily_logs')
    .select('date, calories_eaten, active_calories, strain')
    .eq('user_id', userId)
    .gte('date', start)
    .lte('date', today)
    .order('date', { ascending: true });
  if (logsErr) throw logsErr;

  // Workouts in window — used as the training-day vs rest-day flag.
  const { data: workouts, error: woErr } = await supabase
    .from('workouts')
    .select('date')
    .eq('user_id', userId)
    .gte('date', start)
    .lte('date', today);
  if (woErr) throw woErr;
  const trainingDates = new Set((workouts ?? []).map((w) => w.date as string));

  const rows = (logs ?? []).map((r) => ({
    date: r.date as string,
    kcal: (r.calories_eaten as number | null) ?? null,
    active: (r.active_calories as number | null) ?? null,
    trained: trainingDates.has(r.date as string),
  }));

  // Under-target day count.
  let underDays = 0;
  let totalDelta = 0;
  let deltaCount = 0;
  for (const r of rows) {
    if (r.kcal == null || kcalTarget == null) continue;
    const delta = r.kcal - kcalTarget;
    totalDelta += delta;
    deltaCount++;
    if (delta <= -ENERGY_UNDER_TARGET_KCAL) underDays++;
  }
  const avgDelta = deltaCount > 0 ? totalDelta / deltaCount : null;

  // Training vs rest day average kcal.
  const trainKcals = rows.filter((r) => r.trained && r.kcal != null).map((r) => r.kcal!);
  const restKcals  = rows.filter((r) => !r.trained && r.kcal != null).map((r) => r.kcal!);
  const trainAvg = avg(trainKcals);
  const restAvg  = avg(restKcals);

  // GLP-1 deficit alarm (rough TDEE = average daily intake - average daily delta).
  let glp1DeficitUrgent = false;
  if (isGlp1Active && avgDelta != null && kcalTarget != null) {
    const tdeeEst = kcalTarget; // target is calibrated to TDEE in GLP-1 modes
    glp1DeficitUrgent = Math.abs(avgDelta) / tdeeEst > ENERGY_GLP1_DEFICIT_PCT_TDEE_URGENT;
  }

  let severity: ThemePayload['severity'];
  if (glp1DeficitUrgent) severity = 'urgent';
  else if (underDays >= ENERGY_UNDER_WINDOW_DAYS_WARN) severity = 'warn';
  else severity = 'ok';

  return {
    key: 'energy',
    severity,
    one_line: oneLineFor({ underDays, avgDelta }),
    body_md: bodyMdFor({ underDays, avgDelta, trainAvg, restAvg, severity, isGlp1Active }),
    facts: {
      under_target_days_14d: underDays,
      avg_kcal_delta_vs_target: avgDelta == null ? null : Math.round(avgDelta),
      training_day_avg_kcal: trainAvg == null ? null : Math.round(trainAvg),
      rest_day_avg_kcal: restAvg == null ? null : Math.round(restAvg),
      kcal_target: kcalTarget,
      glp1_mode_active: isGlp1Active ? 'true' : 'false',
    },
    sparkline: kcalTarget == null ? null : {
      label: 'kcal vs target (14d)',
      series: rows
        .filter((r) => r.kcal != null)
        .map((r) => ({ x: r.date, y: r.kcal!, ref: kcalTarget })),
    },
    inputs_used: [
      'daily_logs.calories_eaten',
      'daily_logs.active_calories',
      'workouts.date',
      'getTodayTargets',
    ],
  };
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function isoDaysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function oneLineFor(x: { underDays: number; avgDelta: number | null }): string {
  if (x.avgDelta == null) return 'No intake data';
  const sign = x.avgDelta >= 0 ? '+' : '';
  return `${sign}${fmtNum(x.avgDelta, 0)} kcal × ${x.underDays}d under`;
}

function bodyMdFor(x: {
  underDays: number;
  avgDelta: number | null;
  trainAvg: number | null;
  restAvg: number | null;
  severity: ThemePayload['severity'];
  isGlp1Active: boolean;
}): string {
  if (x.severity === 'ok') return 'Intake tracking target across the window.';
  if (x.severity === 'urgent') {
    const mag = x.avgDelta != null ? fmtNum(Math.abs(x.avgDelta), 0) : '—';
    return `Under target by ${mag} kcal/d on average with the medication active — risk of muscle and adherence loss.`;
  }
  const split = (x.trainAvg != null && x.restAvg != null)
    ? ` Training-day avg ${fmtNum(x.trainAvg, 0)} kcal vs rest-day avg ${fmtNum(x.restAvg, 0)} kcal.`
    : '';
  const deltaStr = x.avgDelta != null ? fmtNum(x.avgDelta, 0) : '—';
  return `Under target ${x.underDays} of last 14 days, averaging ${deltaStr} kcal/d delta.${split}`;
}
