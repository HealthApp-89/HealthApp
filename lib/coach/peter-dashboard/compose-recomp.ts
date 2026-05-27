// lib/coach/peter-dashboard/compose-recomp.ts
//
// Recomp trajectory: are we losing fat while keeping muscle + strength?
// Reads from generateCoachTrends() (body + strength) and food_log
// aggregations. Pure: no LLM, no side effects.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  RECOMP_LBM_HOLD_KG_4W,
  RECOMP_BF_DOWN_PTS_4W,
  RECOMP_LIFT_HOLD_SLOPE_PCT_4W,
  RECOMP_LBM_LOSS_URGENT_KG_4W,
  RECOMP_LIFT_DROP_URGENT_PCT_4W,
} from './thresholds';
import type { CoachTrendsPayload } from '@/lib/data/types';
import { fmtNum } from '@/lib/ui/score';

export async function composeRecomp(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  trends: CoachTrendsPayload;
}): Promise<ThemePayload> {
  const { trends } = args;
  // supabase + userId reserved for future per-composer Supabase reads
  // (e.g. body-comp daily series for the sparkline). Unused in this version.
  void args.supabase;
  void args.userId;

  const lbm4w = trends.body.lbm.delta_4w_kg;
  const bf4w  = trends.body.body_fat_pct.delta_4w_pct;
  const topLiftSlopes = trends.strength.per_lift
    .slice(0, 3)
    .map((p) => p.slope_pct_per_wk_4w)
    .filter((s): s is number => s != null);

  const lbmHolding = lbm4w == null ? true : lbm4w >= RECOMP_LBM_HOLD_KG_4W;
  const bfDown     = bf4w  != null && bf4w <= RECOMP_BF_DOWN_PTS_4W;
  const liftsHolding = topLiftSlopes.length > 0 &&
    topLiftSlopes.every((s) => s > RECOMP_LIFT_HOLD_SLOPE_PCT_4W);
  const lbmCollapsing = lbm4w != null && lbm4w < RECOMP_LBM_LOSS_URGENT_KG_4W;
  const liftCollapsing = topLiftSlopes.some(
    (s) => s <= RECOMP_LIFT_DROP_URGENT_PCT_4W,
  );

  let severity: ThemePayload['severity'];
  if (lbmCollapsing && liftCollapsing) severity = 'urgent';
  else if (lbmHolding && bfDown && liftsHolding) severity = 'ok';
  else severity = 'warn';

  // Sparkline deferred: BodyTrend.body_fat_pct exposes only delta_4w/12w summary
  // fields, not a daily 12w series. Adding it requires raw daily_logs fetch which
  // isn't blocking for v1; the audit script will flag this as a future improvement.
  const sparkline = null;

  // Per-lift slope facts. Each value is %/wk (e.g. 0.04 = 4%/wk). Stored as
  // discrete numeric keys so the renderer formats them through fmtNum; a
  // joined string would skip formatting (typeof !== 'number') and leak full
  // float precision into the UI fact chips.
  const perLiftFacts: Record<string, number | null> = {};
  const topLifts = trends.strength.per_lift.slice(0, 3);
  for (let i = 0; i < topLifts.length; i++) {
    const p = topLifts[i];
    perLiftFacts[`${p.lift}_slope_pct_per_wk_4w`] =
      p.slope_pct_per_wk_4w == null ? null : round1(p.slope_pct_per_wk_4w * 100);
  }

  return {
    key: 'recomp',
    severity,
    one_line: oneLineFor({ lbm4w, bf4w }),
    body_md: bodyMdFor({ lbm4w, bf4w, severity }),
    facts: {
      lbm_delta_4w_kg: lbm4w,
      bf_pct_delta_4w_pts: bf4w,
      ...perLiftFacts,
    },
    sparkline,
    inputs_used: ['coach_trends.body', 'coach_trends.strength.per_lift'],
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function oneLineFor(x: { lbm4w: number | null; bf4w: number | null }): string {
  const lbmStr = x.lbm4w == null ? 'LBM —' :
    x.lbm4w >= -0.1 ? 'LBM flat' :
    `LBM ${fmtNum(x.lbm4w, 1)}kg`;
  const bfStr = x.bf4w == null ? 'BF —' :
    x.bf4w >= 0 ? `BF +${fmtNum(x.bf4w, 1)}pts` :
    `BF ${fmtNum(x.bf4w, 1)}pts`;
  return `${bfStr} / 4w · ${lbmStr}`;
}

function bodyMdFor(x: {
  lbm4w: number | null;
  bf4w: number | null;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') {
    return 'LBM holding, body fat trending down, strength preserved. Recomp working.';
  }
  if (x.severity === 'urgent') {
    return `LBM down ${fmtNum(x.lbm4w, 1)} kg over 4 weeks and at least one top lift dropped >5%. Cut is too aggressive.`;
  }
  if (x.bf4w != null && x.bf4w > 0) {
    return `Body fat up ${fmtNum(x.bf4w, 1)} pts over 4 weeks while LBM is ${x.lbm4w == null ? 'unknown' : x.lbm4w >= -0.1 ? 'holding' : `down ${fmtNum(Math.abs(x.lbm4w), 1)} kg`}. Deficit drift is the likely candidate.`;
  }
  return 'Recomp showing mixed signal across LBM, body fat, and strength. Check the inputs.';
}
