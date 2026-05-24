// lib/coach/trends/compose-nutrition.ts
//
// Nutrition adherence + deficit magnitude trends.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NutritionAdherenceTrend } from "@/lib/data/types";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";
import type { MealSlot } from "@/lib/food/types";
import { targetsForAllSlots, DEFAULT_MEAL_RATIOS, type MealRatios } from "@/lib/food/meal-targets";

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

  // ── Per-meal-slot 14d averages ─────────────────────────────────────────
  // Reads food_log_entries.totals (jsonb) per entry. One entry = one meal
  // with its items already aggregated to a totals object. We aggregate
  // entry totals by (date, slot) so a same-slot multi-entry day still
  // contributes one (averaged) value per day.
  const slot14wCutoff = shiftDays(today, -14);
  type SlotTotalsRow = {
    meal_slot: MealSlot;
    eaten_at: string;
    totals: { kcal?: number; protein_g?: number; carbs_g?: number; fat_g?: number; fiber_g?: number } | null;
  };
  const { data: slotEntries, error: slotErr } = await supabase
    .from("food_log_entries")
    .select("meal_slot, totals, eaten_at")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${slot14wCutoff}T00:00:00Z`)
    .lte("eaten_at", `${today}T23:59:59Z`);
  if (slotErr) throw slotErr;
  const slotRows = (slotEntries as SlotTotalsRow[] | null) ?? [];

  // Aggregate by (date, slot) — collapse multiple entries in same slot/day
  // into one sum, then average across days observed for that slot.
  const byDaySlot = new Map<string, { protein: number; kcal: number }>();
  for (const r of slotRows) {
    const dateKey = r.eaten_at.slice(0, 10);
    const k = `${dateKey}|${r.meal_slot}`;
    const cell = byDaySlot.get(k) ?? { protein: 0, kcal: 0 };
    cell.protein += r.totals?.protein_g ?? 0;
    cell.kcal    += r.totals?.kcal      ?? 0;
    byDaySlot.set(k, cell);
  }

  type SlotAggregate = { proteinSum: number; kcalSum: number; daysObserved: number };
  const slotTotals: Record<MealSlot, SlotAggregate> = {
    breakfast: { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
    lunch:     { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
    dinner:    { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
    snack:     { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
  };
  for (const [k, cell] of byDaySlot.entries()) {
    const slot = k.split("|")[1] as MealSlot;
    slotTotals[slot].proteinSum += cell.protein;
    slotTotals[slot].kcalSum    += cell.kcal;
    slotTotals[slot].daysObserved += 1;
  }

  // Per-slot targets: kcal via meal_ratios; protein distributed proportional
  // to the same meal_ratios (so a 5%-kcal snack also targets ~5% of protein).
  // Future: surface a per-slot protein ratio in profiles.nutrition_overrides
  // if athletes want protein-weighted differently from kcal.
  const ratios: MealRatios = DEFAULT_MEAL_RATIOS;
  const slotKcalTargets = kcalTarget != null ? targetsForAllSlots(kcalTarget, ratios) : null;
  const slotProteinTargets = proteinTarget != null ? {
    breakfast: proteinTarget * ratios.breakfast,
    lunch:     proteinTarget * ratios.lunch,
    dinner:    proteinTarget * ratios.dinner,
    snack:     proteinTarget * ratios.snacks,
  } : null;

  function buildProteinSlot(slot: MealSlot) {
    const t = slotTotals[slot];
    const avg = t.daysObserved > 0 ? t.proteinSum / t.daysObserved : null;
    const target = slotProteinTargets?.[slot] ?? null;
    const pct = avg != null && target != null && target > 0 ? avg / target : null;
    return { avg_14d: avg, target_g: target, pct_of_target: pct };
  }
  function buildKcalSlot(slot: MealSlot) {
    const t = slotTotals[slot];
    const avg = t.daysObserved > 0 ? t.kcalSum / t.daysObserved : null;
    const target = slotKcalTargets?.[slot] ?? null;
    const pct = avg != null && target != null && target > 0 ? avg / target : null;
    return { avg_14d: avg, target_kcal: target, pct_of_target: pct };
  }

  const per_meal_slot = {
    protein_g: {
      breakfast: buildProteinSlot("breakfast"),
      lunch:     buildProteinSlot("lunch"),
      dinner:    buildProteinSlot("dinner"),
      snack:     buildProteinSlot("snack"),
    },
    kcal: {
      breakfast: buildKcalSlot("breakfast"),
      lunch:     buildKcalSlot("lunch"),
      dinner:    buildKcalSlot("dinner"),
      snack:     buildKcalSlot("snack"),
    },
  };

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
    per_meal_slot,
  };
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
