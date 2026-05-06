// lib/coach/snapshot.ts
//
// Shared LLM snapshot builder used by /api/insights, /api/insights/weekly,
// and the chat coach. Returns the cacheable `body` (profile + daily-log rows
// + workout rows with relative-day labels) and the uncached `nowLine`
// separately so callers can keep `nowLine` out of any cached prompt prefix.
//
// Convenience wrapper `buildSnapshotText` returns the two concatenated as a
// single string, for callers that don't care about the cache-placement split.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadWorkouts } from "@/lib/data/workouts";
import { nowInUserTz, relativeDateLabel, todayInUserTz } from "@/lib/time";

type ProfileRow = {
  name?: string | null;
  goal?: string | null;
  whoop_baselines?: unknown;
  training_plan?: unknown;
} | null;

type DailyLogRow = {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  strain: number | null;
  steps: number | null;
  calories: number | null;
  weight_kg: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

export type SnapshotInputs = {
  supabase: SupabaseClient;
  userId: string;
  /** Inclusive YYYY-MM-DD lower bound for daily_logs / workouts. */
  since: string;
  /** Optional inclusive upper bound. Omit for daily mode (loads recent N). */
  until?: string;
  /** Workouts to include in daily mode (ignored when `until` is set). */
  workoutLimit?: number;
};

export type SnapshotResult = {
  /** PER-TURN line. MUST NOT be placed inside a cached prompt prefix. */
  nowLine: string;
  /** Cacheable body. Stable until underlying daily/workout data changes. */
  body: string;
};

const DAY_REFERENCE_INSTRUCTION =
  'When the user references a day (e.g. "Monday"), interpret it relative to NOW above. "Monday" without other qualifiers means the most recent Monday on or before today. If ambiguous, ask.';

/** Append this to your existing system prompt so the model uses NOW as the
 *  reference frame for relative day references. */
export function withDayReferenceInstruction(systemPrompt: string): string {
  return `${systemPrompt}\n\n${DAY_REFERENCE_INSTRUCTION}`;
}

export async function buildSnapshot(inputs: SnapshotInputs): Promise<SnapshotResult> {
  const { supabase, userId, since, until, workoutLimit = 5 } = inputs;
  const today = todayInUserTz();

  let logsQ = supabase
    .from("daily_logs")
    .select(
      "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories, weight_kg, protein_g, carbs_g, fat_g",
    )
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: true });
  if (until) logsQ = logsQ.lte("date", until);

  const [{ data: profile }, { data: logs }, allWorkouts] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, goal, whoop_baselines, training_plan")
      .eq("user_id", userId)
      .maybeSingle(),
    logsQ,
    loadWorkouts(userId),
  ]);

  const workouts = until
    ? allWorkouts.filter((w) => w.date >= since && w.date <= until)
    : allWorkouts.slice(0, workoutLimit);

  const recent = workouts.map((w) => ({
    date: w.date,
    type: w.type,
    sets: w.sets,
    vol_kg: Math.round(w.vol),
    top: w.exercises.slice(0, 4).map((e) => {
      // Prefer the heaviest weighted working set for this session. If the
      // exercise has only bodyweight working sets in this session, fall back
      // to the set with the most reps and label "BW×<reps>".
      const weighted = e.sets
        .filter((s) => !s.warmup && s.kg && s.reps)
        .sort((a, b) => b.kg! - a.kg!)[0];
      if (weighted) return `${e.name} ${weighted.kg}×${weighted.reps}`;
      const bw = e.sets
        .filter((s) => !s.warmup && !s.kg && s.reps)
        .sort((a, b) => b.reps! - a.reps!)[0];
      if (bw) return `${e.name} BW×${bw.reps}`;
      return e.name;
    }),
  }));

  const fmt = (v: number | null | undefined, unit = "") =>
    v === null || v === undefined ? "—" : `${v}${unit}`;

  const logLines = ((logs ?? []) as DailyLogRow[])
    .map((l) => {
      const rel = relativeDateLabel(l.date, today);
      return `  ${l.date} (${rel}) | hrv ${fmt(l.hrv)} | rhr ${fmt(l.resting_hr)} | recov ${fmt(l.recovery)} | sleep ${fmt(l.sleep_hours, "h")} (deep ${fmt(l.deep_sleep_hours)}) | strain ${fmt(l.strain)} | steps ${fmt(l.steps)} | kcal ${fmt(l.calories)} | prot ${fmt(l.protein_g, "g")} | weight ${fmt(l.weight_kg, "kg")}`;
    })
    .join("\n");

  const workoutLines = recent
    .map((w) => {
      const rel = relativeDateLabel(w.date, today);
      return `  ${w.date} (${rel}) ${w.type ?? "—"} | ${w.sets} sets | ${w.vol_kg} kg vol | top: ${w.top.join(", ") || "—"}`;
    })
    .join("\n");

  const p = profile as ProfileRow;
  const body = [
    `ATHLETE: ${p?.name ?? "Athlete"}. GOAL: "${p?.goal ?? "general health"}".`,
    `BASELINES: ${JSON.stringify(p?.whoop_baselines ?? {})}`,
    `TRAINING PLAN: ${JSON.stringify(p?.training_plan ?? {})}`,
    ``,
    `DAILY LOGS (${since} → ${until ?? today}):`,
    logLines || `  (no logs in window)`,
    ``,
    `RECENT WORKOUTS (most recent first):`,
    workoutLines || `  (no workouts)`,
  ].join("\n");

  const n = nowInUserTz();
  const nowLine = `NOW: ${n.date} (${n.weekday}) ${n.time} ${n.tz} (UTC${n.utcOffset})`;

  return { nowLine, body };
}

/** Convenience wrapper: returns NOW anchor + body concatenated as one string.
 *  Used by callers that don't need separate cache-placement (chat coach,
 *  current /api/insights). New callers should prefer buildSnapshot() when
 *  prompt-cache placement matters. */
export async function buildSnapshotText({
  userId,
}: {
  userId: string;
}): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const sinceDate = new Date(`${todayInUserTz()}T00:00:00Z`);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - 14);
  const since = sinceDate.toISOString().slice(0, 10);
  const { nowLine, body } = await buildSnapshot({
    supabase: supabase as unknown as SupabaseClient,
    userId,
    since,
    workoutLimit: 5,
  });
  return `${nowLine}\n\n${body}`;
}
