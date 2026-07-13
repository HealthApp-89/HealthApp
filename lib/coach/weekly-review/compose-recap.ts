// lib/coach/weekly-review/compose-recap.ts
//
// §2 of the weekly review. Pure-ish: takes a supabase client for fetching
// the Mon-Sun recap window plus a 14-day prior window for the e1RM history
// series, returns the recap shape from WeeklyReviewPayload.recap.
//
// Schema note (diverges from plan code block): workouts are normalized as
// `workouts → exercises → exercise_sets`, not a single jsonb `sets` column.
// We fetch via the embedded-select pattern that lib/query/fetchers/muscleVolume.ts
// already established.
//
// Inputs include 3 weeks of e1rm history (for plateau rules in
// compose-prescription), per-set rep counts (for rep-completion rule),
// and the prior weekly_reviews row (for rir_miss_consecutive streak).

import type { SupabaseClient } from "@supabase/supabase-js";
import { epley } from "@/lib/coach/derived";
import { SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import { BIG_FOUR } from "@/lib/coach/big-four";
import { addDays, mondayOf } from "./date-utils";
import type {
  Injury,
  WeeklyReviewPayload,
  WeeklyReviewRow,
  Weekday,
} from "@/lib/data/types";
import { injuryActiveOn } from "@/lib/coach/injuries";

type RecapOutput = WeeklyReviewPayload["recap"];
type PerLiftEntry = RecapOutput["per_lift"][number];

/** Flattened workout view: one row per workout with all sets and the exercise
 *  name attached. We pivot the embedded-select response into this shape so
 *  per-lift filtering can be done with a single flatMap. */
type FlatWorkout = {
  date: string;
  notes: string | null;
  sets: Array<{
    exercise: string;
    kg: number | null;
    reps: number | null;
    warmup: boolean;
  }>;
};

const SELECT_RECAP =
  "date, notes, exercises (name, sets:exercise_sets (kg, reps, warmup))";
const SELECT_HIST = "date, exercises (name, sets:exercise_sets (kg, reps, warmup))";

export async function composeRecap(args: {
  supabase: SupabaseClient;
  userId: string;
  /** Monday YYYY-MM-DD that opens the recap week. */
  weekStart: string;
  /** training_weeks.session_plan, keyed by full weekday name or 3-letter
   *  abbreviation. Read defensively via readSessionForDay. */
  plannedSessions: Record<string, string>;
  /** Prior committed weekly_reviews row (or null if none) — used to carry the
   *  per-lift `rir_miss_consecutive` streak forward without storing it on the
   *  recap rows themselves. */
  priorReview: WeeklyReviewRow | null;
}): Promise<RecapOutput> {
  const { supabase, userId, weekStart, plannedSessions, priorReview } = args;

  // Window: weekStart (Mon) → +6 days (Sun)
  const weekEnd = addDays(weekStart, 6);

  // Fetch workouts in window (embedded selects through exercises → exercise_sets),
  // and injuries (onset_date ≤ weekEnd, including resolved — resolved injuries
  // still excuse the days they covered).
  const [
    { data: rawRecap, error: wErr },
    { data: injuryRows, error: injErr },
  ] = await Promise.all([
    supabase
      .from("workouts")
      .select(SELECT_RECAP)
      .eq("user_id", userId)
      .gte("date", weekStart)
      .lte("date", weekEnd)
      .order("date", { ascending: true }),
    supabase
      .from("injuries")
      .select("*")
      .eq("user_id", userId)
      .lte("onset_date", weekEnd),
  ]);
  if (wErr) throw wErr;
  if (injErr) throw injErr;
  const injuries = (injuryRows ?? []) as Injury[];
  const weekWorkouts = flattenWorkouts(rawRecap ?? []);

  // Sleep + nutrition + weight from daily_logs (column is `date`, not `day`).
  const { data: logs, error: lErr } = await supabase
    .from("daily_logs")
    .select("date, sleep_hours, sleep_score, calories_eaten, protein_g, weight_kg")
    .eq("user_id", userId)
    .gte("date", weekStart)
    .lte("date", weekEnd)
    .order("date", { ascending: true });
  if (lErr) throw lErr;

  // 3-week e1rm history per big-four lift — go back 14 days before weekStart
  const histStart = addDays(weekStart, -14);
  const { data: rawHist, error: hErr } = await supabase
    .from("workouts")
    .select(SELECT_HIST)
    .eq("user_id", userId)
    .gte("date", histStart)
    .lt("date", weekStart);
  if (hErr) throw hErr;
  const histWorkouts = flattenWorkouts(rawHist ?? []);

  // Sessions
  const sessionsDone = weekWorkouts.length;
  const plannedEntries = normalizePlannedSessions(plannedSessions);
  // Raw planned count (all non-REST days) — will be adjusted below.
  let sessionsPlanned = plannedEntries.filter(
    (e) => e.type && e.type.toUpperCase() !== "REST",
  ).length;

  const doneDays = new Set(weekWorkouts.map((w) => w.date));
  const sessionsSkipped: RecapOutput["sessions_skipped"] = [];
  const sessionsInjuryExcused: NonNullable<RecapOutput["sessions_injury_excused"]> = [];
  for (const { fullDay, type } of plannedEntries) {
    if (!type || type.toUpperCase() === "REST") continue;
    const date = dayNameToDate(fullDay, weekStart);
    if (doneDays.has(date)) continue; // completed — not skipped

    // Check whether an active injury excuses this skip.
    const matchingInjury = injuries.find(
      (inj) =>
        injuryActiveOn(inj, date) &&
        inj.affected_session_types.includes(type),
    );
    if (matchingInjury) {
      sessionsInjuryExcused.push({ day: fullDay, type, area: matchingInjury.area });
    } else {
      sessionsSkipped.push({ day: fullDay, type });
    }
  }

  // Adjust denominator: injury-excused days are not counted against the athlete.
  // This keeps sessions_planned consistent with computeAdherence's denominator,
  // which excludes injury days from sessions_planned before computing adherence_pct.
  sessionsPlanned -= sessionsInjuryExcused.length;

  // Swapped: requires training_weeks.original_session_plan (migration 0012).
  // Pulled by caller if applicable; the orchestrator merges. Composer
  // returns empty.
  const sessionsSwapped: RecapOutput["sessions_swapped"] = [];

  // Per-lift performance (big four only) — filter out lifts with no data
  const perLift: PerLiftEntry[] = BIG_FOUR.map((lift) =>
    buildPerLift(lift, weekWorkouts, histWorkouts, priorReview),
  ).filter((row) => row.top_set.weight_kg > 0 || row.top_set.reps > 0);

  // Aggregates
  type LogRow = {
    sleep_hours: number | null;
    sleep_score: number | null;
    calories_eaten: number | null;
    protein_g: number | null;
    weight_kg: number | null;
  };
  const safeLogs: LogRow[] = (logs ?? []) as LogRow[];

  const sleep = {
    avg_h: avg(safeLogs.map((l) => l.sleep_hours).filter(isNum)),
    // `daily_logs` has no `sleep_efficiency` column; sleep_score (0-100 from
    // WHOOP) is the closest analog and shares the same percent scale the
    // recap UI expects. Surface it as `avg_efficiency_pct` so the payload
    // shape stays stable; downstream renderers don't care about the source.
    avg_efficiency_pct: avg(safeLogs.map((l) => l.sleep_score).filter(isNum)),
  };

  const nutrition = {
    kcal_avg: avg(safeLogs.map((l) => l.calories_eaten).filter(isNum)),
    kcal_target: null, // orchestrator fills from targets composer
    protein_avg_g: avg(safeLogs.map((l) => l.protein_g).filter(isNum)),
    protein_target_g: null, // orchestrator fills
  };

  const weights = safeLogs
    .map((l) => l.weight_kg)
    .filter(isNum);
  const weight: RecapOutput["weight"] = {
    start_kg: weights[0] ?? null,
    end_kg: weights[weights.length - 1] ?? null,
    delta_kg:
      weights.length >= 2
        ? weights[weights.length - 1] - weights[0]
        : null,
  };

  return {
    sessions_planned: sessionsPlanned,
    sessions_done: sessionsDone,
    sessions_skipped: sessionsSkipped,
    sessions_swapped: sessionsSwapped,
    ...(sessionsInjuryExcused.length > 0
      ? { sessions_injury_excused: sessionsInjuryExcused }
      : {}),
    per_lift: perLift,
    sleep,
    nutrition,
    weight,
  };
}

// ── flattening + helpers (private) ──────────────────────────────────────────

type RawWorkout = {
  date: string;
  notes?: string | null;
  exercises: unknown;
};

function flattenWorkouts(rows: RawWorkout[]): FlatWorkout[] {
  return rows.map((w) => {
    const exercises =
      (w.exercises as Array<{
        name: string;
        sets: Array<{
          kg: number | null;
          reps: number | null;
          warmup: boolean;
        }>;
      }> | null) ?? [];
    const sets: FlatWorkout["sets"] = exercises.flatMap((ex) =>
      (ex.sets ?? []).map((s) => ({
        exercise: ex.name,
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
      })),
    );
    return { date: w.date, notes: w.notes ?? null, sets };
  });
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const WEEKDAY_OFFSET: Record<string, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
};

function dayNameToDate(fullDay: string, weekStart: string): string {
  const offset = WEEKDAY_OFFSET[fullDay] ?? 0;
  return addDays(weekStart, offset);
}

/** Normalize `session_plan` entries to full weekday names regardless of
 *  whether the row was committed with 3-letter abbreviations or full names.
 *  (See session-plan-reader.ts for the historical context.) */
function normalizePlannedSessions(
  plan: Record<string, string>,
): Array<{ fullDay: string; type: string }> {
  const out: Array<{ fullDay: string; type: string }> = [];
  for (const [key, type] of Object.entries(plan)) {
    if (key in WEEKDAY_OFFSET) {
      out.push({ fullDay: key, type });
      continue;
    }
    // Try 3-letter form
    const full = SHORT_TO_FULL[key as Weekday];
    if (full) out.push({ fullDay: full, type });
  }
  // Stable ordering Mon-Sun
  out.sort(
    (a, b) => (WEEKDAY_OFFSET[a.fullDay] ?? 0) - (WEEKDAY_OFFSET[b.fullDay] ?? 0),
  );
  return out;
}

function buildPerLift(
  lift: string,
  weekWorkouts: FlatWorkout[],
  histWorkouts: FlatWorkout[],
  priorReview: WeeklyReviewRow | null,
): PerLiftEntry {
  const liftSets = weekWorkouts.flatMap((w) =>
    w.sets.filter(
      (s) =>
        s.exercise === lift &&
        !s.warmup &&
        typeof s.kg === "number" &&
        typeof s.reps === "number",
    ),
  );

  let topWeight = 0;
  let topReps = 0;
  for (const s of liftSets) {
    const kg = s.kg ?? 0;
    if (kg > topWeight) {
      topWeight = kg;
      topReps = s.reps ?? 0;
    }
  }
  const setsCount = liftSets.length;
  // Use max reps across working sets (not topReps, which is the rep count of
  // the heaviest set). In pyramid/backoff programming the heaviest set has the
  // lowest reps; taking the max better reflects the prescribed rep target.
  const maxReps = Math.max(0, ...liftSets.map((s) => s.reps ?? 0));
  const repsPrescribed = setsCount * (maxReps || 1);
  const repsDone = liftSets.reduce((a, s) => a + (s.reps ?? 0), 0);
  const repsCompletedPct = repsPrescribed > 0 ? repsDone / repsPrescribed : null;

  const thisE1rm = epley(topWeight || null, topReps || null);

  // Form notes: only workouts whose notes mention the lift name's first token
  const liftFirstToken = lift.split(" ")[0]?.toLowerCase() ?? "";
  const formNotes: string[] = [];
  for (const w of weekWorkouts) {
    if (!w.notes) continue;
    if (liftFirstToken && w.notes.toLowerCase().includes(liftFirstToken)) {
      formNotes.push(w.notes);
    }
  }

  // 3-week e1rm history: this week's peak + 2 prior weekly peaks
  const history3wk = computeE1rmHistory(lift, weekWorkouts, histWorkouts);

  // rir_miss_consecutive: carry forward from prior review payload if present.
  // The composer cannot decide `rir_target_met` (the orchestrator computes
  // that against training_weeks.rir_target), so for now we surface the prior
  // streak and let the orchestrator finalize. We leave `thisWeekMissed=false`
  // as a placeholder — the orchestrator can re-increment by examining
  // rir_target_met after we return.
  const priorPerLift = priorReview?.payload?.recap?.per_lift?.find(
    (p) => p.lift === lift,
  );
  const priorStreak = priorPerLift?.rir_miss_consecutive ?? 0;

  const e1rmDeltaKg =
    thisE1rm != null && priorPerLift?.e1rm_kg != null
      ? thisE1rm - priorPerLift.e1rm_kg
      : null;
  const e1rmDeltaPct =
    e1rmDeltaKg != null && priorPerLift?.e1rm_kg
      ? e1rmDeltaKg / priorPerLift.e1rm_kg
      : null;

  return {
    lift,
    top_set: { weight_kg: topWeight, reps: topReps, sets: setsCount },
    reps_completed_pct: repsCompletedPct,
    e1rm_kg: thisE1rm,
    e1rm_delta_kg: e1rmDeltaKg,
    e1rm_delta_pct: e1rmDeltaPct,
    e1rm_history_3wk: history3wk,
    rir_target_met: null, // orchestrator computes from training_weeks.rir_target
    rir_miss_consecutive: priorStreak, // orchestrator may increment on commit
    form_notes: formNotes,
  };
}

function computeE1rmHistory(
  lift: string,
  weekWorkouts: FlatWorkout[],
  histWorkouts: FlatWorkout[],
): number[] {
  const all = [...histWorkouts, ...weekWorkouts];
  const byWeek = new Map<string, number>();
  for (const w of all) {
    const wkKey = mondayOf(w.date);
    const liftSets = w.sets.filter(
      (s) =>
        s.exercise === lift &&
        !s.warmup &&
        typeof s.kg === "number" &&
        typeof s.reps === "number",
    );
    let bestE: number | null = null;
    for (const s of liftSets) {
      const e = epley(s.kg, s.reps);
      if (e != null && (bestE == null || e > bestE)) bestE = e;
    }
    if (bestE != null) {
      const prev = byWeek.get(wkKey);
      if (prev == null || bestE > prev) byWeek.set(wkKey, bestE);
    }
  }
  const sorted = [...byWeek.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  return sorted.slice(-3).map(([, e]) => e);
}
