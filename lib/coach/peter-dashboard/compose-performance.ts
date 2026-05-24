// lib/coach/peter-dashboard/compose-performance.ts
//
// Performance trajectory: per-lift e1RM slopes + active plateau spans.
// Reads from generateCoachTrends().strength (already has slopes + plateau
// flags + weeks-flat counts). Pure: no LLM, no side effects.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  PERFORMANCE_PLATEAU_WEEKS_WARN,
  PERFORMANCE_LIFT_DROP_URGENT_PCT_4W,
  PERFORMANCE_BIGFOUR_PLATEAU_COUNT_URGENT,
} from './thresholds';
import type { CoachTrendsPayload, PerLiftSlope } from '@/lib/data/types';
import { fmtNum } from '@/lib/ui/score';

const BIG_FOUR = new Set(['squat', 'deadlift', 'bench', 'ohp']);

export async function composePerformance(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  trends: CoachTrendsPayload;
}): Promise<ThemePayload> {
  const { trends } = args;
  // supabase + userId reserved for future per-composer Supabase reads
  // (e.g. exercise_sets-derived e1RM weekly history for the headline-lift
  // sparkline — see TODO below). Unused in this version.
  void args.supabase;
  void args.userId;
  void args.today;

  const perLift = trends.strength.per_lift;
  const activePlateaus = perLift.filter((p) => p.plateau_active);
  const longestPlateau = activePlateaus.reduce<PerLiftSlope | null>(
    (a, b) => (a == null || b.plateau_weeks_flat > a.plateau_weeks_flat ? b : a),
    null,
  );
  const bigFourPlateaued = activePlateaus.filter((p) => {
    const name = p.lift.toLowerCase().replace(/\s*\([^)]+\)/, '');
    return BIG_FOUR.has(name);
  });

  const topDropping = perLift.find(
    (p) =>
      p.slope_pct_per_wk_4w != null &&
      p.slope_pct_per_wk_4w <= PERFORMANCE_LIFT_DROP_URGENT_PCT_4W,
  );

  let severity: ThemePayload['severity'];
  if (
    bigFourPlateaued.length >= PERFORMANCE_BIGFOUR_PLATEAU_COUNT_URGENT ||
    topDropping != null
  ) {
    severity = 'urgent';
  } else if (
    longestPlateau != null &&
    longestPlateau.plateau_weeks_flat >= PERFORMANCE_PLATEAU_WEEKS_WARN
  ) {
    severity = 'warn';
  } else {
    severity = 'ok';
  }

  // Sparkline deferred: PerLiftSlope exposes only slope/plateau summary fields,
  // not a weekly e1RM series. Adding it requires a raw exercise_sets fetch for
  // the headline lift which isn't blocking for v1; the audit script will flag
  // this as a future improvement.
  // TODO: query exercise_sets directly for headlineLift.lift's e1RM weekly
  // history (12w) and emit a SparklineSeries here.
  const sparkline = null;

  return {
    key: 'performance',
    severity,
    one_line: oneLineFor({
      longestPlateau,
      totalPlateaus: activePlateaus.length,
    }),
    body_md: bodyMdFor({ longestPlateau, bigFourPlateaued, severity }),
    facts: {
      active_plateau_count: activePlateaus.length,
      longest_plateau_weeks: longestPlateau?.plateau_weeks_flat ?? null,
      longest_plateau_lift: longestPlateau?.lift ?? null,
      bigfour_plateaued_count: bigFourPlateaued.length,
    },
    sparkline,
    inputs_used: ['coach_trends.strength.per_lift'],
  };
}

function shortName(lift: string): string {
  return lift.replace(/\s*\([^)]+\)/, '');
}

function oneLineFor(x: {
  longestPlateau: PerLiftSlope | null;
  totalPlateaus: number;
}): string {
  if (x.longestPlateau == null) return 'Lifts moving';
  return `${shortName(x.longestPlateau.lift)} flat ${fmtNum(x.longestPlateau.plateau_weeks_flat, 0)}wk`;
}

function bodyMdFor(x: {
  longestPlateau: PerLiftSlope | null;
  bigFourPlateaued: PerLiftSlope[];
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') return 'No active plateaus; lifts trending up.';
  if (x.bigFourPlateaued.length >= 2) {
    const names = x.bigFourPlateaued.map((p) => shortName(p.lift)).join(' and ');
    return `${names} both plateaued simultaneously. Deload candidate.`;
  }
  if (x.longestPlateau != null) {
    return `${shortName(x.longestPlateau.lift)} flat ${fmtNum(x.longestPlateau.plateau_weeks_flat, 0)} weeks — rep-shift or deload at the next weekly review.`;
  }
  return 'Performance flagged but no single dominant pattern.';
}
