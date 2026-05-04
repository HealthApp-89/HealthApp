// lib/coach/snapshot.ts
//
// Build the plain-text health snapshot used by both the daily insights
// generator and the chat coach. Pipe-delimited rows, ~2-4K tokens, byte-stable
// for prompt caching.

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadWorkouts } from "@/lib/data/workouts";

export type SnapshotInputs = {
  userId: string;
};

export async function buildSnapshotText({ userId }: SnapshotInputs): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);

  const [{ data: profile }, { data: logs }, workouts] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, goal, whoop_baselines, training_plan")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select(
        "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories, weight_kg, protein_g, carbs_g, fat_g",
      )
      .eq("user_id", userId)
      .gte("date", since)
      .order("date", { ascending: true }),
    loadWorkouts(userId),
  ]);

  const recent = workouts.slice(0, 5).map((w) => ({
    date: w.date,
    type: w.type,
    sets: w.sets,
    vol_kg: Math.round(w.vol),
    top: w.exercises.slice(0, 4).map((e) => {
      const best = e.sets
        .filter((s) => !s.warmup && s.kg && s.reps)
        .sort((a, b) => (b.kg! - a.kg!))[0];
      return best ? `${e.name} ${best.kg}×${best.reps}` : e.name;
    }),
  }));

  const fmt = (v: number | null | undefined, unit = "") =>
    v === null || v === undefined ? "—" : `${v}${unit}`;

  const logLines = (logs ?? [])
    .map(
      (l) =>
        `  ${l.date} | hrv ${fmt(l.hrv)} | rhr ${fmt(l.resting_hr)} | recov ${fmt(l.recovery)} | sleep ${fmt(l.sleep_hours, "h")} (deep ${fmt(l.deep_sleep_hours)}) | strain ${fmt(l.strain)} | steps ${fmt(l.steps)} | kcal ${fmt(l.calories)} | prot ${fmt(l.protein_g, "g")} | weight ${fmt(l.weight_kg, "kg")}`,
    )
    .join("\n");

  const workoutLines = recent
    .map(
      (w) =>
        `  ${w.date} ${w.type ?? "—"} | ${w.sets} sets | ${w.vol_kg} kg vol | top: ${w.top.join(", ") || "—"}`,
    )
    .join("\n");

  return [
    `ATHLETE: ${profile?.name ?? "Athlete"}. GOAL: "${profile?.goal ?? "general health"}".`,
    `BASELINES: ${JSON.stringify(profile?.whoop_baselines ?? {})}`,
    `TRAINING PLAN: ${JSON.stringify(profile?.training_plan ?? {})}`,
    ``,
    `LAST 14 DAYS:`,
    logLines || `  (no logs in window)`,
    ``,
    `RECENT WORKOUTS (most recent first):`,
    workoutLines || `  (no workouts)`,
  ].join("\n");
}
