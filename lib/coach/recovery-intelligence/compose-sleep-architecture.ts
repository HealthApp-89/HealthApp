// lib/coach/recovery-intelligence/compose-sleep-architecture.ts
//
// 14 daily points (oldest first) with deep / REM / light breakdown.
// "light" is derived: max(0, total_sleep − deep − REM). Total < deep+REM
// (rare WHOOP artifact) clamps to 0 to keep the stacked-bar viz coherent.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SleepArchitecturePoint } from "./types";

const WINDOW_DAYS = 14;
const SELECT_COLS = "date,sleep_hours,deep_sleep_hours,rem_sleep_hours";

export async function composeSleepArchitecture(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<SleepArchitecturePoint[]> {
  const { supabase, userId, today } = args;

  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  type Row = { date: string; sleep_hours: number | null; deep_sleep_hours: number | null; rem_sleep_hours: number | null };
  const byDate = new Map<string, Row>();
  for (const r of (data ?? []) as Row[]) byDate.set(r.date, r);

  const out: SleepArchitecturePoint[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const row = byDate.get(iso);
    const total = row?.sleep_hours ?? null;
    const deep  = row?.deep_sleep_hours ?? null;
    const rem   = row?.rem_sleep_hours ?? null;
    const light =
      total != null && deep != null && rem != null
        ? Math.max(0, total - deep - rem)
        : null;
    out.push({ date: iso, deep_hours: deep, rem_hours: rem, light_hours: light, total_hours: total });
  }
  return out;
}
