// lib/coach/trends/compose-body.ts
//
// Weight / LBM / body-fat-% trends from daily_logs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BodyTrend } from "@/lib/data/types";
import { linearRegression, type Point } from "./linear-regression";

const DEFAULT_TARGET_BAND: BodyTrend["weight"]["target_band"] = {
  lower: -0.7,
  upper: -0.2,
};

export async function composeBody(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<BodyTrend> {
  const { supabase, userId, today } = args;

  const windowStart12w = shiftDays(today, -7 * 12);

  const { data: logs, error } = await supabase
    .from("daily_logs")
    .select("date, weight_kg, fat_free_mass_kg, body_fat_pct")
    .eq("user_id", userId)
    .gte("date", windowStart12w)
    .lte("date", today)
    .order("date", { ascending: true });
  if (error) throw error;

  type Row = {
    date: string;
    weight_kg: number | null;
    fat_free_mass_kg: number | null;
    body_fat_pct: number | null;
  };
  const rows = (logs as Row[] | null) ?? [];

  const todayDate = new Date(today + "T12:00:00Z").getTime();
  const dayIndex = (d: string) =>
    Math.round((new Date(d + "T12:00:00Z").getTime() - todayDate) / (24 * 3600 * 1000));

  const window4wCutoff = shiftDays(today, -28);

  const wPoints4w: Point[] = [];
  const wPoints12w: Point[] = [];
  for (const r of rows) {
    if (r.weight_kg == null) continue;
    const xi = dayIndex(r.date);
    const p: Point = { x: xi, y: r.weight_kg };
    wPoints12w.push(p);
    if (r.date >= window4wCutoff) wPoints4w.push(p);
  }

  const w4 = linearRegression(wPoints4w);
  const w12 = linearRegression(wPoints12w);

  const weightRate4w = w4 ? w4.slope * 7 : null;
  const weightRate12w = w12 ? w12.slope * 7 : null;

  const inBand = weightRate4w != null
    ? weightRate4w >= DEFAULT_TARGET_BAND.lower && weightRate4w <= DEFAULT_TARGET_BAND.upper
    : null;

  const weightRows = rows.filter((r) => r.weight_kg != null);
  const weightNow = weightRows.length > 0 ? weightRows[weightRows.length - 1].weight_kg : null;

  const lbmRows = rows.filter((r) => r.fat_free_mass_kg != null);
  const lbmNow = lbmRows.length > 0 ? lbmRows[lbmRows.length - 1].fat_free_mass_kg : null;
  const lbm4wStart = lbmRows.find((r) => r.date >= window4wCutoff);
  const lbm12wStart = lbmRows[0];
  const lbmDelta4w = lbmNow != null && lbm4wStart?.fat_free_mass_kg != null
    ? lbmNow - lbm4wStart.fat_free_mass_kg
    : null;
  const lbmDelta12w = lbmNow != null && lbm12wStart?.fat_free_mass_kg != null
    ? lbmNow - lbm12wStart.fat_free_mass_kg
    : null;

  const bfRows = rows.filter((r) => r.body_fat_pct != null);
  const bfNow = bfRows.length > 0 ? bfRows[bfRows.length - 1].body_fat_pct : null;
  const bf4wStart = bfRows.find((r) => r.date >= window4wCutoff);
  const bf12wStart = bfRows[0];
  const bfDelta4w = bfNow != null && bf4wStart?.body_fat_pct != null
    ? bfNow - bf4wStart.body_fat_pct
    : null;
  const bfDelta12w = bfNow != null && bf12wStart?.body_fat_pct != null
    ? bfNow - bf12wStart.body_fat_pct
    : null;

  return {
    schema_version: 1,
    weight: {
      now_kg: weightNow,
      rate_kg_per_wk_4w: weightRate4w,
      rate_kg_per_wk_12w: weightRate12w,
      target_band: DEFAULT_TARGET_BAND,
      in_band: inBand,
    },
    lbm: {
      now_kg: lbmNow,
      delta_4w_kg: lbmDelta4w,
      delta_12w_kg: lbmDelta12w,
    },
    body_fat_pct: {
      now: bfNow,
      delta_4w_pct: bfDelta4w,
      delta_12w_pct: bfDelta12w,
    },
  };
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
