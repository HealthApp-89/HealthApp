// lib/query/fetchers/blockProgress.ts
//
// Computes the full BlockProgressCard payload on demand. Single source of
// truth for: current week of block, RIR target, e1RM rolling means,
// body-comp-aware relative metrics, adherence aggregates, on-pace boolean.
//
// Used by /api/coach/block-progress (GET) for the browser fetcher path.

import type { SupabaseClient } from "@supabase/supabase-js";
import { epley, topSet, type SetRow } from "@/lib/coach/derived";
import { computeAdherence } from "@/lib/coach/adherence";
import {
  allometric,
  deltaPct,
  ipfGl,
  strengthPerLbm,
} from "@/lib/coach/progress-metrics";
import { todayInUserTz } from "@/lib/time";
import type { PrimaryLift, TrainingBlock } from "@/lib/data/types";

export type BlockProgressPayload =
  | {
      active: false;
    }
  | {
      block: TrainingBlock;
      current_week: number;
      total_weeks: 5;
      research_phase: "accumulate" | "deload";
      rir_target: number | null;

      e1rm_at_block_start: number | null;
      e1rm_now: number | null;
      e1rm_delta: number | null;
      e1rm_remaining_to_goal: number | null;
      on_pace: boolean | null;

      strength_per_lbm_at_start: number | null;
      strength_per_lbm_now: number | null;
      strength_per_lbm_delta_pct: number | null;
      allometric_at_start: number | null;
      allometric_now: number | null;
      allometric_delta_pct: number | null;
      ipf_gl_at_start: number | null;
      ipf_gl_now: number | null;
      ipf_gl_delta_pct: number | null;

      lbm_now_kg: number | null;
      bf_pct_now: number | null;
      weight_now_kg: number | null;

      sessions_planned_to_date: number;
      sessions_done: number;
      adherence_pct: number;
    };

const RIR_BY_WEEK: Record<number, number | null> = { 1: 4, 2: 3, 3: 2, 4: 1, 5: null };
const PHASE_BY_WEEK: Record<number, "accumulate" | "deload"> = {
  1: "accumulate", 2: "accumulate", 3: "accumulate", 4: "accumulate", 5: "deload",
};

export async function computeBlockProgress(
  supabase: SupabaseClient,
  userId: string,
  tz: string,
): Promise<BlockProgressPayload> {
  const today = todayInUserTz(new Date(), tz);
  const { data: rawBlock, error: blockErr } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (blockErr) throw blockErr;
  if (!rawBlock) return { active: false };

  let block = rawBlock as TrainingBlock;
  if (block.end_date < today) {
    const { data: flipped, error: flipErr } = await supabase
      .from("training_blocks")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", block.id)
      .select()
      .single();
    if (flipErr) throw flipErr;
    return { active: false };
  }
  // Block is in the DB as active but hasn't started yet — treat as inactive
  // so the UI hides Mesocycle badge and session debrief omits the week-num
  // section. (Was silently clamping to "Week 1" because the original
  // computation only handled the end_date case.)
  if (block.start_date > today) {
    return { active: false };
  }

  const start = new Date(block.start_date + "T00:00:00Z");
  const todayD = new Date(today + "T00:00:00Z");
  const weeksElapsed = Math.floor((todayD.getTime() - start.getTime()) / (7 * 86_400_000));
  const currentWeek = Math.min(5, Math.max(1, weeksElapsed + 1));
  const rirTarget = RIR_BY_WEEK[currentWeek];
  const phase = PHASE_BY_WEEK[currentWeek];

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startMinus28 = new Date(start); startMinus28.setUTCDate(start.getUTCDate() - 28);
  const todayMinus28 = new Date(todayD); todayMinus28.setUTCDate(todayD.getUTCDate() - 28);

  const e1rmAtStart = block.primary_lift
    ? await rolling4wE1rmMean(supabase, userId, block.primary_lift, fmt(startMinus28), block.start_date)
    : null;
  const e1rmNow = block.primary_lift
    ? await rolling4wE1rmMean(supabase, userId, block.primary_lift, fmt(todayMinus28), today)
    : null;
  const e1rmDelta = e1rmAtStart !== null && e1rmNow !== null ? e1rmNow - e1rmAtStart : null;
  const e1rmRemaining =
    block.target_metric === "e1rm" && block.target_value && e1rmNow !== null
      ? block.target_value - e1rmNow
      : null;
  const onPace = computeOnPace(block, e1rmAtStart, e1rmNow, weeksElapsed);

  const lbmAtStart = await mostRecentColumnNear(supabase, userId, "fat_free_mass_kg", block.start_date, 14);
  const bwAtStart  = await mostRecentColumnNear(supabase, userId, "weight_kg", block.start_date, 14);
  const lbmNow     = await mostRecentColumnNear(supabase, userId, "fat_free_mass_kg", today, 7);
  const bwNow      = await mostRecentColumnNear(supabase, userId, "weight_kg", today, 7);
  const bfNow      = await mostRecentColumnNear(supabase, userId, "body_fat_pct", today, 7);

  const sPerLbmStart = strengthPerLbm(e1rmAtStart, lbmAtStart);
  const sPerLbmNow   = strengthPerLbm(e1rmNow, lbmNow);
  const allomStart   = allometric(e1rmAtStart, bwAtStart);
  const allomNow     = allometric(e1rmNow, bwNow);

  const ipfStart = await maybeIpfGl(supabase, userId, fmt(startMinus28), block.start_date, bwAtStart);
  const ipfNow   = await maybeIpfGl(supabase, userId, fmt(todayMinus28), today, bwNow);

  const adh = await aggregateBlockAdherence(supabase, userId, block.start_date, today);

  return {
    block,
    current_week: currentWeek,
    total_weeks: 5,
    research_phase: phase,
    rir_target: rirTarget,
    e1rm_at_block_start: e1rmAtStart,
    e1rm_now: e1rmNow,
    e1rm_delta: e1rmDelta,
    e1rm_remaining_to_goal: e1rmRemaining,
    on_pace: onPace,
    strength_per_lbm_at_start: sPerLbmStart,
    strength_per_lbm_now: sPerLbmNow,
    strength_per_lbm_delta_pct: deltaPct(sPerLbmStart, sPerLbmNow),
    allometric_at_start: allomStart,
    allometric_now: allomNow,
    allometric_delta_pct: deltaPct(allomStart, allomNow),
    ipf_gl_at_start: ipfStart,
    ipf_gl_now: ipfNow,
    ipf_gl_delta_pct: deltaPct(ipfStart, ipfNow),
    lbm_now_kg: lbmNow,
    bf_pct_now: bfNow,
    weight_now_kg: bwNow,
    sessions_planned_to_date: adh.planned,
    sessions_done: adh.done,
    adherence_pct: adh.pct,
  };
}

async function rolling4wE1rmMean(
  supabase: SupabaseClient,
  userId: string,
  lift: PrimaryLift,
  fromDate: string,
  toDate: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, set_index, duration_seconds, failure))")
    .eq("user_id", userId)
    .gte("date", fromDate)
    .lte("date", toDate);
  if (error) throw error;

  const e1rms: number[] = [];
  for (const w of data ?? []) {
    for (const e of w.exercises ?? []) {
      if (!liftMatches(e.name, lift)) continue;
      const top = topSet((e.exercise_sets ?? []) as SetRow[]);
      if (top && top.kg && top.reps) e1rms.push(epley(top.kg, top.reps) ?? 0);
    }
  }
  if (e1rms.length === 0) return null;
  return e1rms.reduce((a, b) => a + b, 0) / e1rms.length;
}

function liftMatches(name: string, lift: PrimaryLift): boolean {
  const n = name.toLowerCase();
  switch (lift) {
    case "squat":    return n.includes("squat");
    case "bench":    return n.includes("bench") && n.includes("press");
    case "deadlift": return n.includes("deadlift");
    case "ohp":      return (n.includes("overhead") || n.includes("ohp")) && n.includes("press");
  }
}

async function mostRecentColumnNear(
  supabase: SupabaseClient,
  userId: string,
  column: string,
  asOf: string,
  windowDays: number,
): Promise<number | null> {
  const asOfD = new Date(asOf + "T00:00:00Z");
  const lowerD = new Date(asOfD); lowerD.setUTCDate(asOfD.getUTCDate() - windowDays);
  const upperD = new Date(asOfD); upperD.setUTCDate(asOfD.getUTCDate() + windowDays);
  const { data, error } = await supabase
    .from("daily_logs")
    .select(`date, ${column}`)
    .eq("user_id", userId)
    .gte("date", lowerD.toISOString().slice(0, 10))
    .lte("date", upperD.toISOString().slice(0, 10))
    .not(column, "is", null)
    .order("date", { ascending: false });
  if (error) throw error;
  if (!data || data.length === 0) return null;
  let best: { d: number; v: number } | null = null;
  for (const row of (data as unknown) as Array<Record<string, unknown>>) {
    const dist = Math.abs(new Date((row.date as string) + "T00:00:00Z").getTime() - asOfD.getTime());
    const v = row[column] as number;
    if (typeof v === "number" && Number.isFinite(v)) {
      if (!best || dist < best.d) best = { d: dist, v };
    }
  }
  return best?.v ?? null;
}

async function maybeIpfGl(
  supabase: SupabaseClient,
  userId: string,
  fromDate: string,
  toDate: string,
  bw: number | null,
): Promise<number | null> {
  if (bw === null) return null;
  const sq = await rolling4wE1rmMean(supabase, userId, "squat", fromDate, toDate);
  const bp = await rolling4wE1rmMean(supabase, userId, "bench", fromDate, toDate);
  const dl = await rolling4wE1rmMean(supabase, userId, "deadlift", fromDate, toDate);
  if (sq === null || bp === null || dl === null) return null;
  return ipfGl(sq, bp, dl, bw, "M");
}

function computeOnPace(
  block: TrainingBlock,
  e1rmAtStart: number | null,
  e1rmNow: number | null,
  weeksElapsed: number,
): boolean | null {
  if (
    !block.primary_lift ||
    block.target_metric !== "e1rm" ||
    block.target_value === null ||
    e1rmAtStart === null ||
    e1rmNow === null ||
    weeksElapsed <= 0
  ) {
    return null;
  }
  const targetDelta = block.target_value - e1rmAtStart;
  if (targetDelta <= 0) return true;
  const requiredPerWeek = targetDelta / 5;
  const actualPerWeek = (e1rmNow - e1rmAtStart) / weeksElapsed;
  return actualPerWeek >= requiredPerWeek;
}

async function aggregateBlockAdherence(
  supabase: SupabaseClient,
  userId: string,
  blockStart: string,
  today: string,
): Promise<{ planned: number; done: number; pct: number }> {
  const { data, error } = await supabase
    .from("training_weeks")
    .select("week_start")
    .eq("user_id", userId)
    .gte("week_start", blockStart)
    .lte("week_start", today);
  if (error) throw error;

  let planned = 0;
  let done = 0;
  for (const row of (data ?? []) as { week_start: string }[]) {
    const r = await computeAdherence(supabase, userId, row.week_start);
    planned += r.sessions_planned;
    done += r.sessions_on_plan;
  }
  return {
    planned,
    done,
    pct: planned === 0 ? 0 : Math.round((done / planned) * 100),
  };
}

/** Browser fetcher used by the TanStack Query hook. */
export async function fetchBlockProgressBrowser(): Promise<BlockProgressPayload> {
  const res = await fetch("/api/coach/block-progress", { method: "GET" });
  if (!res.ok) throw new Error(`block-progress: ${res.status}`);
  return res.json();
}
