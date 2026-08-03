// lib/coach/carter-context/volume-signals.ts
//
// Surfaces the engine's withheld set bumps to Carter. When a muscle sits
// below MEV at one exposure per week, the fix is another exposure, not more
// sets in the one session — the engine stops bumping and says so here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { VolumeFrequencySignal } from "@/lib/data/types";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { currentWeekMonday } from "@/lib/coach/week";

export async function buildVolumeSignalsBlock(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string | null> {
  const { supabase, userId } = args;
  const tz = await getUserTimezone(userId);
  const weekStart = currentWeekMonday(new Date(), tz);

  const { data } = await supabase
    .from("training_weeks")
    .select("volume_signals")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();

  const signals = (data?.volume_signals ?? null) as VolumeFrequencySignal[] | null;
  if (!signals || signals.length === 0) return null;

  const lines = signals.map(
    (s) =>
      `- ${s.muscle}: ${fmt(s.weekly_sets)} sets/week vs MEV ${s.mev}, across ${s.weekly_exposures} ` +
      `session${s.weekly_exposures === 1 ? "" : "s"}/week. Set bump withheld on: ${s.suppressed_exercises.join(", ")}.`,
  );

  return [
    "<volume_signals>",
    "These muscles are below their minimum effective volume, but the engine has",
    "STOPPED adding sets because previously-added sets were not performed.",
    lines.join("\n"),
    "",
    "RULE: when a muscle is below MEV at one exposure per week, recommend a",
    "SECOND weekly exposure. Do NOT recommend more sets in the existing session —",
    "that is the lever that already failed. Never re-prescribe the withheld sets.",
    "</volume_signals>",
  ].join("\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
