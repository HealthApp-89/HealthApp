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
import { loadWorkouts } from "@/lib/data/workouts-server";
import type { WorkoutSession } from "@/lib/data/workouts";
import { nowInUserTz, relativeDateLabel, todayInUserTz } from "@/lib/time";
import { renderProfileSummary } from "@/lib/coach/profile-renderer";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
import { topSet } from "@/lib/coach/derived";
import type { IntakePayload, PlanPayload } from "@/lib/data/types";

/** Compose the NOW header for the LLM snapshot prefix. Includes an explicit
 *  "current week" anchor (Mon→Sun of the user's current week) because LLMs
 *  frequently miscompute the Monday of "this week" from just a NOW date.
 *  Pre-computing the anchor here keeps the model from inventing dates like
 *  "Week of 2026-05-12" when today is Saturday 2026-05-16. */
function composeNowLine(n: {
  date: string;
  weekday: string;
  time: string;
  tz: string;
  utcOffset: string;
}): string {
  const weekMon = mondayOf(n.date);
  const weekSunDt = new Date(weekMon + "T12:00:00Z");
  weekSunDt.setUTCDate(weekSunDt.getUTCDate() + 6);
  const weekSun = weekSunDt.toISOString().slice(0, 10);
  return [
    `NOW: ${n.date} (${n.weekday}) ${n.time} ${n.tz} (UTC${n.utcOffset})`,
    `CURRENT WEEK: ${weekMon} (Mon) → ${weekSun} (Sun) — use these dates verbatim when referring to "this week", "Monday", or any weekday this week. Do not recompute.`,
  ].join("\n");
}

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
  /** Nutrition intake (Yazio) — what shows up as "kcal" in the coach summary.
   *  This deliberately excludes the `calories` (energy burned) column, which
   *  is from Apple Health and surfaces elsewhere via strain/active metrics. */
  calories_eaten: number | null;
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

/** Window (days, relative to `asOf`) bounding what counts as a "current" lift
 *  in the live top-set block. Lifts not performed within this window are
 *  excluded — beyond ~4 months, the notion of "current top set" stops being
 *  meaningful and would just bloat the cached prefix. */
const CURRENT_LIFT_WINDOW_DAYS = 120;

/** Number of days between two YYYY-MM-DD strings (negative if `b` is before `a`). */
function daysBetween(a: string, b: string): number {
  const ms = Date.UTC(
    Number(a.slice(0, 4)),
    Number(a.slice(5, 7)) - 1,
    Number(a.slice(8, 10)),
  ) - Date.UTC(
    Number(b.slice(0, 4)),
    Number(b.slice(5, 7)) - 1,
    Number(b.slice(8, 10)),
  );
  return Math.round(ms / 86_400_000);
}

/** For every distinct lift the athlete has performed within
 *  CURRENT_LIFT_WINDOW_DAYS of `asOf`, emit the top working set of its
 *  most-recent session (with e1RM when reps ≤ 12). This gives the coach AI
 *  a LIVE anchor for "current top set per lift" so it never cites the
 *  frozen intake-time `current_e1rm` baseline from the profile block.
 *
 *  Ordering: most-recent first — frequently-trained lifts naturally float
 *  to the top. Bodyweight-only sets (kg=null, no duration) render as
 *  `BW×reps`. Returns "" when nothing renders so callers can skip the
 *  section cleanly. */
function buildCurrentTopSetsBlock(
  workouts: WorkoutSession[],
  asOf: string,
): string {
  type Hit = {
    name: string;
    date: string;
    ts: NonNullable<ReturnType<typeof topSet>> | null;
    /** BW-reps fallback when topSet returns null but reps-only sets exist. */
    bwReps: number | null;
  };

  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const w of workouts) {
    if (w.date > asOf) continue;
    if (daysBetween(asOf, w.date) > CURRENT_LIFT_WINDOW_DAYS) break; // workouts is desc — older lifts won't requalify
    for (const ex of w.exercises) {
      if (seen.has(ex.name)) continue;
      const ts = topSet(ex.sets);
      let bwReps: number | null = null;
      if (!ts) {
        const bw = ex.sets
          .filter((s) => !s.warmup && !s.kg && s.reps)
          .sort((a, b) => b.reps! - a.reps!)[0];
        if (bw) bwReps = bw.reps;
        else continue;
      }
      seen.add(ex.name);
      hits.push({ name: ex.name, date: w.date, ts, bwReps });
    }
  }

  if (hits.length === 0) return "";

  const lines = hits.map((h) => {
    const rel = relativeDateLabel(h.date, asOf);
    let body: string;
    if (h.ts && h.ts.kg !== null && h.ts.reps !== null) {
      body = `${h.ts.kg}×${h.ts.reps}${h.ts.e1RM !== null ? ` (e1RM ${h.ts.e1RM})` : ""}`;
    } else if (h.ts && h.ts.duration_seconds !== null) {
      body = `${h.ts.duration_seconds}s hold`;
    } else if (h.bwReps !== null) {
      body = `BW×${h.bwReps}`;
    } else {
      return null;
    }
    return `  ${h.name} — ${h.date} (${rel}): ${body}`;
  }).filter((l): l is string => l !== null);

  if (lines.length === 0) return "";

  return [
    `CURRENT TOP SET per lift (most recent session within ${CURRENT_LIFT_WINDOW_DAYS}d; sourced live from workouts; SUPERSEDES any "Intake-time e1RMs" baseline values below):`,
    ...lines,
  ].join("\n");
}

export async function buildSnapshot(inputs: SnapshotInputs): Promise<SnapshotResult> {
  const { supabase, userId, since, until, workoutLimit = 5 } = inputs;
  const today = todayInUserTz();

  let logsQ = supabase
    .from("daily_logs")
    .select(
      "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories_eaten, weight_kg, protein_g, carbs_g, fat_g",
    )
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: true });
  if (until) logsQ = logsQ.lte("date", until);

  const [{ data: profile }, { data: logs }, allWorkouts, { data: athleteProfileRow }] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, goal, whoop_baselines, training_plan")
      .eq("user_id", userId)
      .maybeSingle(),
    logsQ,
    loadWorkouts(userId),
    supabase
      .from("athlete_profile_documents")
      .select("version, intake_payload, plan_payload")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
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
      // Use the canonical topSet picker (sorts by e1RM, tie-breaks on kg) so
      // a 90×7 rep PR doesn't get hidden behind an earlier 90×6 at the same
      // weight. Also surfaces e1RM inline so the model doesn't have to derive
      // it from kg×reps (which was the original failure mode behind cited
      // stale e1RMs). topSet covers weighted + duration paths; pure
      // bodyweight sets (kg=null, no duration) still fall through to the
      // BW-reps fallback below.
      const ts = topSet(e.sets);
      if (ts) {
        if (ts.kg !== null && ts.reps !== null) {
          const e1rmSuffix = ts.e1RM !== null ? ` (e1RM ${ts.e1RM})` : "";
          return `${e.name} ${ts.kg}×${ts.reps}${e1rmSuffix}`;
        }
        if (ts.duration_seconds !== null) {
          return `${e.name} ${ts.duration_seconds}s`;
        }
      }
      const bw = e.sets
        .filter((s) => !s.warmup && !s.kg && s.reps)
        .sort((a, b) => b.reps! - a.reps!)[0];
      if (bw) return `${e.name} BW×${bw.reps}`;
      return e.name;
    }),
  }));

  // Live "current top set per lift" — anchors against the frozen intake-time
  // e1RMs in the profile summary below. Computed off ALL workouts (not just
  // the 5-slice `workouts`) so a lift performed >5 sessions ago still
  // surfaces. Bounded by `until ?? today` so historical snapshots
  // (insights/weekly) reflect what was current at that point in time.
  const currentTopSetsBlock = buildCurrentTopSetsBlock(allWorkouts, until ?? today);

  const fmt = (v: number | null | undefined, unit = "") =>
    v === null || v === undefined ? "—" : `${v}${unit}`;

  const logLines = ((logs ?? []) as DailyLogRow[])
    .map((l) => {
      const rel = relativeDateLabel(l.date, today);
      return `  ${l.date} (${rel}) | hrv ${fmt(l.hrv)} | rhr ${fmt(l.resting_hr)} | recov ${fmt(l.recovery)} | sleep ${fmt(l.sleep_hours, "h")} (deep ${fmt(l.deep_sleep_hours)}) | strain ${fmt(l.strain)} | steps ${fmt(l.steps)} | kcal ${fmt(l.calories_eaten)} | prot ${fmt(l.protein_g, "g")} | weight ${fmt(l.weight_kg, "kg")}`;
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
    // Live current top set per lift FIRST, so the model anchors on live data
    // before reading the intake-time baselines in the profile body.
    ...(currentTopSetsBlock ? [``, currentTopSetsBlock] : []),
    ...(athleteProfileRow
      ? [``, renderProfileSummary(
          athleteProfileRow.intake_payload as IntakePayload,
          athleteProfileRow.version as number,
          (athleteProfileRow.plan_payload as PlanPayload | null) ?? null,
          null, // currentBlockWeek — snapshot has no block-week context yet; future PR can thread it
        )]
      : []),
    ``,
    `DAILY LOGS (${since} → ${until ?? today}):`,
    logLines || `  (no logs in window)`,
    ``,
    `RECENT WORKOUTS (most recent first):`,
    workoutLines || `  (no workouts)`,
  ].join("\n");

  const n = nowInUserTz();
  const nowLine = composeNowLine(n);

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

// ── Ephemeral header (per-turn, NOT cached) ──────────────────────────────────
//
// Built fresh at request time. Carries today's row + yesterday's row (re-
// queried so freshly-arrived sync data isn't lied about) and a DATA FRESHNESS
// block giving hours-ago precision per source. Sits as a separate text block
// AFTER the cached snapshot prefix; never use cache_control on it.

export type SyncFreshnessRow = {
  source: "WHOOP" | "Withings" | "Apple Health" | "Yazio";
  /** ISO timestamp of the most recent daily_logs.updated_at where the
   *  source-signature column is non-null. Null if no rows ever. */
  last_write_at: string | null;
};

const FRESHNESS_SOURCES: { source: SyncFreshnessRow["source"]; signatureCol: string }[] = [
  { source: "WHOOP", signatureCol: "hrv" },
  { source: "Withings", signatureCol: "weight_kg" },
  { source: "Apple Health", signatureCol: "steps" },
  { source: "Yazio", signatureCol: "protein_g" },
];

export async function getSyncFreshness(
  supabase: SupabaseClient,
  userId: string,
): Promise<SyncFreshnessRow[]> {
  return Promise.all(
    FRESHNESS_SOURCES.map(async ({ source, signatureCol }) => {
      const { data } = await supabase
        .from("daily_logs")
        .select("updated_at")
        .eq("user_id", userId)
        .not(signatureCol, "is", null)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();
      return {
        source,
        last_write_at: (data?.updated_at as string | undefined) ?? null,
      };
    }),
  );
}

/** Render hours-ago in `Nh Mm ago (today|yesterday|N days ago)` form. */
export function formatFreshness(now: Date, last: string | null): string {
  if (!last) return "no data";
  const lastDate = new Date(last);
  const ms = now.getTime() - lastDate.getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  // Day bucket: compare calendar dates in user's tz proxy (UTC here is fine
  // for the bucket label since the precision is ±1 day; the hours-ago value
  // is the load-bearing number).
  const today = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const lastDay = new Date(last.slice(0, 10) + "T00:00:00Z");
  const dayDelta = Math.round((today.getTime() - lastDay.getTime()) / 86_400_000);
  let dayLabel: string;
  if (dayDelta <= 0) dayLabel = "today";
  else if (dayDelta === 1) dayLabel = "yesterday";
  else dayLabel = `${dayDelta} days ago`;
  return `${hours}h ${mins.toString().padStart(2, "0")}m ago (${dayLabel})`;
}

/** Build the per-turn ephemeral header. Re-queries today + yesterday rows
 *  fresh so post-cache data lands. Returned as a single string; the caller
 *  places it as the LAST text block of the user message right before the new
 *  user content, AFTER the cached snapshot prefix. NOT cacheable. */
export async function buildEphemeralHeader(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string> {
  const { supabase, userId } = opts;
  const today = todayInUserTz();
  const yesterdayDate = new Date(`${today}T00:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  // Pull both rows + freshness in parallel.
  const [{ data: rows }, freshness, n] = await Promise.all([
    supabase
      .from("daily_logs")
      .select(
        "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories_eaten, weight_kg, protein_g, carbs_g, fat_g",
      )
      .eq("user_id", userId)
      .in("date", [today, yesterday]),
    getSyncFreshness(supabase, userId),
    Promise.resolve(nowInUserTz()),
  ]);

  const byDate = new Map<string, DailyLogRow>();
  for (const r of (rows ?? []) as DailyLogRow[]) byDate.set(r.date, r);

  const renderRow = (label: string, date: string) => {
    const r = byDate.get(date);
    const fmt = (v: number | null | undefined, unit = "") =>
      v === null || v === undefined ? "null" : `${v}${unit}`;
    return [
      `${label} (${date}):`,
      `  recovery=${fmt(r?.recovery)}  hrv=${fmt(r?.hrv)}  resting_hr=${fmt(r?.resting_hr)}  sleep_hours=${fmt(r?.sleep_hours)}  sleep_score=${fmt(r?.sleep_score)}`,
      `  strain=${fmt(r?.strain)}  steps=${fmt(r?.steps)}  weight_kg=${fmt(r?.weight_kg)}`,
      `  protein_g=${fmt(r?.protein_g)}  carbs_g=${fmt(r?.carbs_g)}  fat_g=${fmt(r?.fat_g)}`,
    ].join("\n");
  };

  const nowJsDate = new Date();
  const freshnessLines = freshness.map(
    (f) => `  ${f.source} last write: ${formatFreshness(nowJsDate, f.last_write_at)}`,
  );

  return [
    composeNowLine(n),
    ``,
    renderRow("TODAY", today),
    ``,
    renderRow("YESTERDAY", yesterday),
    ``,
    `DATA FRESHNESS:`,
    ...freshnessLines,
  ].join("\n");
}
