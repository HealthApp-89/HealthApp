// lib/coach/trends/compose-nutrition.ts
//
// Nutrition adherence + deficit magnitude trends.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NutritionAdherenceTrend } from "@/lib/data/types";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";

const KCAL_HIT_TOLERANCE = 0.05;

export async function composeNutrition(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<NutritionAdherenceTrend> {
  const { supabase, userId, today } = args;

  const windowStart12w = shiftDays(today, -7 * 12);
  const window4wCutoff = shiftDays(today, -28);

  const { data: logs, error } = await supabase
    .from("daily_logs")
    .select("date, calories_eaten, protein_g")
    .eq("user_id", userId)
    .gte("date", windowStart12w)
    .lte("date", today)
    .order("date", { ascending: true });
  if (error) throw error;

  const targets = await getTodayTargets(supabase, userId);
  const proteinTarget = targets?.protein_g ?? null;
  const kcalTarget = targets?.kcal ?? null;

  type Row = { date: string; calories_eaten: number | null; protein_g: number | null };
  const rows = (logs as Row[] | null) ?? [];

  function countHits(
    rs: Row[],
    keyFn: (r: Row) => number | null,
    hit: (v: number) => boolean,
  ): { hits: number; total: number } {
    let h = 0;
    let t = 0;
    for (const r of rs) {
      const v = keyFn(r);
      if (v == null) continue;
      t++;
      if (hit(v)) h++;
    }
    return { hits: h, total: t };
  }

  const protein4w = countHits(
    rows.filter((r) => r.date >= window4wCutoff),
    (r) => r.protein_g,
    (v) => proteinTarget != null && v >= proteinTarget,
  );
  const protein12w = countHits(
    rows,
    (r) => r.protein_g,
    (v) => proteinTarget != null && v >= proteinTarget,
  );

  const kcal4w = countHits(
    rows.filter((r) => r.date >= window4wCutoff),
    (r) => r.calories_eaten,
    (v) => kcalTarget != null && Math.abs(v - kcalTarget) / kcalTarget <= KCAL_HIT_TOLERANCE,
  );
  const kcal12w = countHits(
    rows,
    (r) => r.calories_eaten,
    (v) => kcalTarget != null && Math.abs(v - kcalTarget) / kcalTarget <= KCAL_HIT_TOLERANCE,
  );

  const avg = (xs: number[]) => xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  const kcalAvg4w = avg(
    rows.filter((r) => r.date >= window4wCutoff && r.calories_eaten != null)
      .map((r) => r.calories_eaten as number),
  );
  const kcalAvg12w = avg(
    rows.filter((r) => r.calories_eaten != null).map((r) => r.calories_eaten as number),
  );

  const deficit4w = kcalAvg4w != null && kcalTarget != null ? kcalAvg4w - kcalTarget : null;
  const deficit12w = kcalAvg12w != null && kcalTarget != null ? kcalAvg12w - kcalTarget : null;

  return {
    schema_version: 1,
    protein: {
      target_g: proteinTarget,
      days_hit_4w: protein4w.hits,
      days_total_4w: protein4w.total,
      pct_4w: protein4w.total > 0 ? protein4w.hits / protein4w.total : null,
      pct_12w: protein12w.total > 0 ? protein12w.hits / protein12w.total : null,
    },
    kcal: {
      target: kcalTarget,
      days_hit_4w: kcal4w.hits,
      days_total_4w: kcal4w.total,
      pct_4w: kcal4w.total > 0 ? kcal4w.hits / kcal4w.total : null,
      pct_12w: kcal12w.total > 0 ? kcal12w.hits / kcal12w.total : null,
      avg_4w: kcalAvg4w,
      avg_12w: kcalAvg12w,
    },
    deficit_kcal: {
      avg_4w: deficit4w,
      avg_12w: deficit12w,
    },
  };
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
