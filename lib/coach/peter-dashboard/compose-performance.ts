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

/** Maps the canonical PrimaryLift key to substrings that match the lift names
 *  appearing in coach_trends.strength.per_lift (e.g. "Deadlift (Barbell)",
 *  "Overhead Press (Barbell)"). Case-insensitive contains match. */
const FOCUS_LIFT_NAME_NEEDLES: Record<string, string[]> = {
  squat: ['squat'],
  bench: ['bench press'],
  deadlift: ['deadlift'],
  ohp: ['overhead press'],
};

function liftMatchesFocus(liftName: string, focusLift: string): boolean {
  const needles = FOCUS_LIFT_NAME_NEEDLES[focusLift];
  if (!needles) return false;
  const n = liftName.toLowerCase();
  return needles.some((needle) => n.includes(needle));
}

function liftMatchesGoal(liftName: string, goalMetric: string): boolean {
  return liftName.toLowerCase().includes(goalMetric.toLowerCase());
}

export async function composePerformance(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  trends: CoachTrendsPayload;
  /** Active block's primary lift (one of 'squat'|'bench'|'deadlift'|'ohp') or
   *  null when no focus block is active. Drives headline priority + body
   *  framing so off-focus plateaus aren't conflated with block-critical stalls. */
  focusLift: string | null;
  /** Goal metric from athlete_profile_documents.goal_metric (raw lift name,
   *  e.g. "Deadlift"). Used to tag whether the goal lift specifically is
   *  plateaued — required for the performance-goal cluster gate in
   *  link-themes.ts. */
  goalLiftMetric: string | null;
}): Promise<ThemePayload> {
  const { trends, focusLift, goalLiftMetric } = args;
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

  const focusPlateaued = focusLift
    ? activePlateaus.find((p) => liftMatchesFocus(p.lift, focusLift)) ?? null
    : null;
  const goalPlateaued = goalLiftMetric
    ? activePlateaus.find((p) => liftMatchesGoal(p.lift, goalLiftMetric)) ?? null
    : null;

  // Headline picks the focus-lift plateau when one exists; falls back to
  // longest. The body always discloses the focus relationship so the narrative
  // wrapper can't conflate an off-focus plateau with a block-critical concern.
  const headline = focusPlateaued ?? longestPlateau;
  const headlineIsOffFocus =
    focusLift != null &&
    focusPlateaued == null &&
    headline != null;

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
    headline != null &&
    headline.plateau_weeks_flat >= PERFORMANCE_PLATEAU_WEEKS_WARN
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
    one_line: oneLineFor({ headline, headlineIsOffFocus }),
    body_md: bodyMdFor({
      headline,
      bigFourPlateaued,
      severity,
      focusLift,
      focusPlateaued,
      headlineIsOffFocus,
    }),
    facts: {
      active_plateau_count: activePlateaus.length,
      longest_plateau_weeks: longestPlateau?.plateau_weeks_flat ?? null,
      longest_plateau_lift: longestPlateau?.lift ?? null,
      bigfour_plateaued_count: bigFourPlateaued.length,
      focus_lift: focusLift,
      focus_lift_plateau_active: focusPlateaued != null ? 1 : 0,
      focus_lift_plateau_weeks: focusPlateaued?.plateau_weeks_flat ?? null,
      goal_lift: goalLiftMetric,
      goal_lift_plateau_active: goalPlateaued != null ? 1 : 0,
    },
    sparkline,
    inputs_used: ['coach_trends.strength.per_lift', 'training_blocks.primary_lift', 'athlete_profile_documents.goal_metric'],
  };
}

function shortName(lift: string): string {
  return lift.replace(/\s*\([^)]+\)/, '');
}

function oneLineFor(x: {
  headline: PerLiftSlope | null;
  headlineIsOffFocus: boolean;
}): string {
  if (x.headline == null) return 'Lifts moving';
  const tag = x.headlineIsOffFocus ? ' (off-focus)' : '';
  return `${shortName(x.headline.lift)} flat ${fmtNum(x.headline.plateau_weeks_flat, 0)}wk${tag}`;
}

function bodyMdFor(x: {
  headline: PerLiftSlope | null;
  bigFourPlateaued: PerLiftSlope[];
  severity: ThemePayload['severity'];
  focusLift: string | null;
  focusPlateaued: PerLiftSlope | null;
  headlineIsOffFocus: boolean;
}): string {
  if (x.severity === 'ok') {
    if (x.focusLift && x.focusPlateaued == null) {
      return `${labelFor(x.focusLift)} progressing; no active plateaus on focus lift.`;
    }
    return 'No active plateaus; lifts trending up.';
  }
  if (x.bigFourPlateaued.length >= 2) {
    const names = x.bigFourPlateaued.map((p) => shortName(p.lift)).join(' and ');
    return `${names} both plateaued simultaneously. Deload candidate.`;
  }
  if (x.focusPlateaued != null) {
    return `Focus lift ${shortName(x.focusPlateaued.lift)} flat ${fmtNum(x.focusPlateaued.plateau_weeks_flat, 0)} weeks — block-critical. Rep-shift or deload at the next weekly review.`;
  }
  if (x.headlineIsOffFocus && x.headline != null) {
    return `${shortName(x.headline.lift)} flat ${fmtNum(x.headline.plateau_weeks_flat, 0)} weeks — this is an off-focus lift (block focus is ${labelFor(x.focusLift!)}); address at weekly review without disrupting the focus-block work.`;
  }
  if (x.headline != null) {
    return `${shortName(x.headline.lift)} flat ${fmtNum(x.headline.plateau_weeks_flat, 0)} weeks — rep-shift or deload at the next weekly review.`;
  }
  return 'Performance flagged but no single dominant pattern.';
}

function labelFor(focusLift: string): string {
  switch (focusLift) {
    case 'squat': return 'Squat';
    case 'bench': return 'Bench Press';
    case 'deadlift': return 'Deadlift';
    case 'ohp': return 'Overhead Press';
    default: return focusLift;
  }
}
