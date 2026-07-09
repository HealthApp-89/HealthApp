// lib/coach/strength-per-lbm-trend.ts
//
// Deterministic "is my strength holding on the cut?" answer: pairs weekly
// best e1RM (Brzycki, non-warmup, 1..12 reps) with weekly average lean body
// mass and returns the ratio series + OLS slope + categorical verdict.
// Pure core — the get_strength_per_lbm_trend tool executor in
// lib/coach/tools.ts fetches the window and calls this. The coach narrates
// the verdict; it never recomputes or extrapolates (house philosophy: the
// math computes, the coach speaks).
//
// Weeks missing either side are OMITTED, never interpolated — absence is the
// signal, matching the adherence convention. Fewer than 3 paired weeks →
// "insufficient_data" with whatever series exists.
//
// Spec: docs/superpowers/specs/2026-07-09-carter-reads-the-cut-design.md

import type { PrimaryLift } from "@/lib/data/types";
import { brzycki } from "@/lib/coach/e1rm";
import { strengthPerLbm } from "@/lib/coach/progress-metrics";
import { olsSlope } from "@/lib/coach/trends/linear-regression";
import { mondayOfIso } from "@/lib/time/dates";

export type StrengthLbmSetSample = {
  kg: number;
  reps: number;
  warmup: boolean;
  performed_on: string; // YYYY-MM-DD
};

export type BodyCompRow = {
  date: string; // YYYY-MM-DD
  fat_free_mass_kg: number | null;
  weight_kg: number | null;
  body_fat_pct: number | null;
};

export type StrengthPerLbmTrend = {
  lift: PrimaryLift;
  weeks_requested: number;
  weeks_with_data: number;
  series: Array<{ week_start: string; best_e1rm: number; avg_lbm_kg: number; ratio: number }>;
  slope_per_week: number | null;
  relative_slope_pct_per_week: number | null;
  verdict: "rising" | "holding" | "falling" | "insufficient_data";
};

const MIN_PAIRED_WEEKS = 3;
const HOLDING_BAND_PCT = 0.5; // |relative weekly slope| ≤ 0.5% → holding

/** Lean body mass for one reading: prefer the measured fat-free mass; derive
 *  from weight × (1 − bf%) when both components exist; null otherwise. */
function lbmForRow(r: BodyCompRow): number | null {
  if (r.fat_free_mass_kg != null && r.fat_free_mass_kg > 0) return r.fat_free_mass_kg;
  if (r.weight_kg != null && r.weight_kg > 0 && r.body_fat_pct != null && r.body_fat_pct >= 0 && r.body_fat_pct < 100) {
    return r.weight_kg * (1 - r.body_fat_pct / 100);
  }
  return null;
}

export function computeStrengthPerLbmTrend(opts: {
  lift: PrimaryLift;
  weeksRequested: number;
  sets: StrengthLbmSetSample[];
  bodyRows: BodyCompRow[];
}): StrengthPerLbmTrend {
  // Weekly best e1RM (Brzycki window: non-warmup, 1..12 reps).
  const e1rmByWeek = new Map<string, number>();
  for (const s of opts.sets) {
    if (s.warmup) continue;
    if (s.reps < 1 || s.reps > 12) continue;
    const v = brzycki(s.kg, s.reps);
    if (v == null) continue;
    const wk = mondayOfIso(s.performed_on);
    const cur = e1rmByWeek.get(wk);
    if (cur == null || v > cur) e1rmByWeek.set(wk, v);
  }

  // Weekly average LBM.
  const lbmByWeek = new Map<string, number[]>();
  for (const r of opts.bodyRows) {
    const lbm = lbmForRow(r);
    if (lbm == null) continue;
    const wk = mondayOfIso(r.date);
    const list = lbmByWeek.get(wk) ?? [];
    list.push(lbm);
    lbmByWeek.set(wk, list);
  }

  // Pair, oldest-first. Weeks missing either side are omitted.
  const series: StrengthPerLbmTrend["series"] = [];
  const weeks = [...e1rmByWeek.keys()].filter((wk) => lbmByWeek.has(wk)).sort();
  for (const wk of weeks) {
    const best = e1rmByWeek.get(wk)!;
    const lbms = lbmByWeek.get(wk)!;
    const avgLbm = lbms.reduce((a, b) => a + b, 0) / lbms.length;
    const ratio = strengthPerLbm(best, avgLbm);
    if (ratio == null) continue;
    series.push({ week_start: wk, best_e1rm: best, avg_lbm_kg: avgLbm, ratio });
  }

  if (series.length < MIN_PAIRED_WEEKS) {
    return {
      lift: opts.lift,
      weeks_requested: opts.weeksRequested,
      weeks_with_data: series.length,
      series,
      slope_per_week: null,
      relative_slope_pct_per_week: null,
      verdict: "insufficient_data",
    };
  }

  const slope = olsSlope(series.map((p, i) => ({ x: i, y: p.ratio })));
  const meanRatio = series.reduce((a, p) => a + p.ratio, 0) / series.length;
  const relPct = slope != null && meanRatio > 0 ? (slope / meanRatio) * 100 : null;

  let verdict: StrengthPerLbmTrend["verdict"] = "holding";
  if (relPct != null && relPct > HOLDING_BAND_PCT) verdict = "rising";
  else if (relPct != null && relPct < -HOLDING_BAND_PCT) verdict = "falling";

  return {
    lift: opts.lift,
    weeks_requested: opts.weeksRequested,
    weeks_with_data: series.length,
    series,
    slope_per_week: slope,
    relative_slope_pct_per_week: relPct,
    verdict,
  };
}
