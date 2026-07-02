// lib/coach/peter-dashboard/compose-goal-distance.ts
//
// Goal distance: structured goal fields × current trajectory × projected ETA.
// Degrades to "Set a structured goal" card when fields are null
// (migration 0035 just added them; backfill is user-driven).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  GOAL_PACE_RATIO_OK,
  GOAL_PACE_RATIO_WARN,
  GOAL_ETA_MISS_DAYS_URGENT,
} from './thresholds';
import type { CoachTrendsPayload } from '@/lib/data/types';
import { fmtNum } from '@/lib/ui/score';
import { daysBetweenIso } from '@/lib/time/dates';

export async function composeGoalDistance(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  trends: CoachTrendsPayload;
}): Promise<ThemePayload> {
  const { supabase, userId, today, trends } = args;

  // Active (acknowledged) athlete profile document.
  const { data: doc, error } = await supabase
    .from('athlete_profile_documents')
    .select('goal_kind, goal_metric, goal_target, goal_target_date, acknowledged_at')
    .eq('user_id', userId)
    .not('acknowledged_at', 'is', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (!doc || !doc.goal_kind || doc.goal_target == null || !doc.goal_target_date) {
    return degradedCard();
  }

  const targetDate = doc.goal_target_date as string;
  const daysToTarget = daysBetweenIso(today, targetDate);
  if (daysToTarget == null || daysToTarget <= 0) {
    return {
      key: 'goal_distance',
      severity: 'warn',
      one_line: 'Target date passed',
      body_md: 'Goal target date has passed. Refresh the goal in /profile.',
      facts: {
        goal_kind: doc.goal_kind as string,
        days_past_target: -(daysToTarget ?? 0),
      },
      sparkline: null,
      inputs_used: ['athlete_profile_documents'],
    };
  }

  // Current value + slope from coach trends, by goal_kind.
  const cur = currentAndSlope({
    kind: doc.goal_kind as 'lift_e1rm' | 'bodyweight_kg' | 'bodyfat_pct',
    metric: doc.goal_metric as string | null,
    trends,
  });

  if (cur.current == null) {
    return {
      key: 'goal_distance',
      severity: 'warn',
      one_line: 'No current reading',
      body_md: `Goal set to ${fmtNum(doc.goal_target as number, 1)} ${unitFor(doc.goal_kind as string)} by ${targetDate}, but no current reading is available to project from.`,
      facts: {
        goal_kind: doc.goal_kind as string,
        goal_target: doc.goal_target as number,
        days_to_target: daysToTarget,
      },
      sparkline: null,
      inputs_used: ['athlete_profile_documents', 'coach_trends'],
    };
  }

  const target = doc.goal_target as number;
  const delta = target - cur.current;
  const requiredRatePerDay = delta / daysToTarget;

  // Project ETA from current trajectory.
  const slopePerDay = cur.slope_per_day;
  const etaDays = slopePerDay !== 0 && Math.sign(slopePerDay) === Math.sign(delta)
    ? Math.abs(delta / slopePerDay)
    : Infinity;
  const etaMissDays = isFinite(etaDays) ? Math.round(etaDays - daysToTarget) : Infinity;

  // pace_ratio: current rate / required rate.
  const paceRatio = requiredRatePerDay === 0
    ? 1
    : slopePerDay / requiredRatePerDay;

  let severity: ThemePayload['severity'];
  if (paceRatio < GOAL_PACE_RATIO_WARN || etaMissDays > GOAL_ETA_MISS_DAYS_URGENT) {
    severity = 'urgent';
  } else if (paceRatio < GOAL_PACE_RATIO_OK) {
    severity = 'warn';
  } else {
    severity = 'ok';
  }

  return {
    key: 'goal_distance',
    severity,
    one_line: oneLineFor({ paceRatio, daysToTarget }),
    body_md: bodyMdFor({
      goalKind: doc.goal_kind as string,
      metric: doc.goal_metric as string | null,
      target,
      current: cur.current,
      daysToTarget,
      paceRatio,
      etaMissDays,
      severity,
    }),
    facts: {
      goal_kind: doc.goal_kind as string,
      goal_metric: (doc.goal_metric as string | null) ?? null,
      goal_target: target,
      current_value: cur.current,
      days_to_target: daysToTarget,
      pace_ratio: round2(paceRatio),
      eta_miss_days: isFinite(etaMissDays) ? etaMissDays : null,
    },
    sparkline: null,
    inputs_used: ['athlete_profile_documents', 'coach_trends'],
  };
}

function degradedCard(): ThemePayload {
  return {
    key: 'goal_distance',
    severity: 'ok',
    one_line: 'Set a structured goal',
    body_md: 'Add goal kind, target value, and target date in /profile to enable projections.',
    facts: { has_structured_goal: 'false' },
    sparkline: null,
    inputs_used: ['athlete_profile_documents'],
  };
}

function currentAndSlope(args: {
  kind: 'lift_e1rm' | 'bodyweight_kg' | 'bodyfat_pct';
  metric: string | null;
  trends: CoachTrendsPayload;
}): { current: number | null; slope_per_day: number } {
  if (args.kind === 'bodyweight_kg') {
    const cur = args.trends.body.weight.now_kg ?? null;
    const ratePerWk = args.trends.body.weight.rate_kg_per_wk_4w ?? 0;
    return { current: cur, slope_per_day: ratePerWk / 7 };
  }
  if (args.kind === 'bodyfat_pct') {
    const cur = args.trends.body.body_fat_pct.now ?? null;
    const deltaPts4w = args.trends.body.body_fat_pct.delta_4w_pct ?? 0;
    return { current: cur, slope_per_day: deltaPts4w / 28 };
  }
  // lift_e1rm
  const needle = (args.metric ?? '').toLowerCase();
  const lift = needle
    ? args.trends.strength.per_lift.find((p) => p.lift.toLowerCase().includes(needle))
    : undefined;
  if (!lift) return { current: null, slope_per_day: 0 };
  const cur = lift.e1rm_kg_now ?? null;
  const slopePctPerWk = lift.slope_pct_per_wk_4w ?? 0;
  const slopeKgPerWk = cur != null ? (slopePctPerWk / 100) * cur : 0;
  return { current: cur, slope_per_day: slopeKgPerWk / 7 };
}

function unitFor(kind: string): string {
  if (kind === 'lift_e1rm') return 'kg';
  if (kind === 'bodyweight_kg') return 'kg';
  if (kind === 'bodyfat_pct') return '%';
  return '';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function oneLineFor(x: { paceRatio: number; daysToTarget: number }): string {
  if (x.paceRatio >= 1) return `On pace · ${x.daysToTarget}d`;
  return `${Math.round(x.paceRatio * 100)}% pace · ${x.daysToTarget}d`;
}

function bodyMdFor(x: {
  goalKind: string;
  metric: string | null;
  target: number;
  current: number;
  daysToTarget: number;
  paceRatio: number;
  etaMissDays: number;
  severity: ThemePayload['severity'];
}): string {
  const what = x.metric ? `${x.metric}` : x.goalKind.replace(/_/g, ' ');
  const unit = unitFor(x.goalKind);
  if (x.severity === 'ok') {
    return `${what} on pace for ${fmtNum(x.target, 1)}${unit} by target date — current ${fmtNum(x.current, 1)}${unit}.`;
  }
  if (x.severity === 'urgent') {
    const miss = isFinite(x.etaMissDays) ? ` Current trajectory misses by ~${x.etaMissDays} days.` : '';
    return `${what} at ${Math.round(x.paceRatio * 100)}% of required pace toward ${fmtNum(x.target, 1)}${unit}.${miss}`;
  }
  return `${what} pace running slightly behind — ${Math.round(x.paceRatio * 100)}% of what's needed for ${fmtNum(x.target, 1)}${unit}.`;
}
