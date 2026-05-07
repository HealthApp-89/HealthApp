// lib/coach/tools.ts
//
// Anthropic tool schemas + server-side executors for the chat coach.
//
// Security invariants (load-bearing — must hold for every executor):
//   1. Tool input schemas NEVER include user_id. The model cannot pass it;
//      the route injects it from supabase.auth.getUser().
//   2. Every executor's underlying query MUST .eq("user_id", userId), even
//      though service_role bypasses RLS. This .eq is the actual scoping.
//   3. Inputs are validated against closed enums (ALLOWED_COLUMNS, granularity,
//      aggregate) BEFORE any query is constructed.
//   4. Date strings are parsed and re-formatted to YYYY-MM-DD before going
//      into a query. Never interpolated raw.
//   5. Range caps are enforced before the query runs.
//
// Tool errors are returned as `tool_result` content with is_error: true.
// They are part of the conversation; only Anthropic-level failures escalate
// to a top-level SSE error.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  epley,
  hardSetCount,
  monthStart,
  topSet,
  weekStart,
  workingSetCount,
  workingVolume,
  type SetRow,
} from "@/lib/coach/derived";
import { categorize, type ExerciseCategory } from "@/lib/coach/exercise-categories";

// ── Allowlist (cross-checked against lib/data/types.ts:DailyLog + schema.sql) ─
export const ALLOWED_COLUMNS = [
  "hrv", "resting_hr", "recovery",
  "sleep_hours", "sleep_score", "deep_sleep_hours", "rem_sleep_hours",
  "spo2", "skin_temp_c", "respiratory_rate", "strain",
  "steps", "calories", "active_calories", "distance_km", "exercise_min",
  "weight_kg", "body_fat_pct",
  "fat_mass_kg", "fat_free_mass_kg", "muscle_mass_kg", "bone_mass_kg", "hydration_kg",
  "protein_g", "carbs_g", "fat_g", "calories_eaten",
  "notes",
] as const;
export type AllowedColumn = (typeof ALLOWED_COLUMNS)[number];

const ALLOWED_AGGREGATES = ["raw", "avg", "sum", "min", "max"] as const;
type AggregateMode = (typeof ALLOWED_AGGREGATES)[number];

const ALLOWED_GRANULARITIES = ["summary", "sets", "by_week", "by_month"] as const;
type WorkoutGranularity = (typeof ALLOWED_GRANULARITIES)[number];

// ── Tool schemas exposed to Anthropic ────────────────────────────────────────
export const DAILY_LOGS_TOOL = {
  name: "query_daily_logs",
  description:
    "Fetch the athlete's daily_logs for a date range. Returns one row per day in `raw` mode, or one aggregated row in `avg`/`sum`/`min`/`max` mode. Use this whenever you need numbers older than today/yesterday or outside the orientation snapshot. Respect the 90-day cap in raw mode; aggregate mode is uncapped (one row regardless of range).",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date", description: "YYYY-MM-DD inclusive lower bound." },
      end_date: { type: "string", format: "date", description: "YYYY-MM-DD inclusive upper bound." },
      columns: {
        type: "array",
        items: { type: "string", enum: ALLOWED_COLUMNS },
        description: "Subset of columns to return. Omit for the full default set.",
      },
      aggregate: {
        type: "string",
        enum: ALLOWED_AGGREGATES,
        default: "raw",
        description:
          "raw → one row per day; avg/sum/min/max → one row over the whole range, with non_null_count + null_count per column.",
      },
    },
  },
};

export const WORKOUTS_TOOL = {
  name: "query_workouts",
  description:
    "Fetch the athlete's strength training history. granularity: 'summary' (default, one row per workout with derived volume/top-set/e1RM), 'sets' (one row per set), 'by_week'/'by_month' (per-period rollups with set counts by 7-bucket category). exercise_name filters to one exercise. Warmups are always excluded from volume / e1RM / counts.",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date: { type: "string", format: "date" },
      exercise_name: { type: "string" },
      granularity: {
        type: "string",
        enum: ALLOWED_GRANULARITIES,
        default: "summary",
      },
    },
  },
};

// ── Validation helpers ───────────────────────────────────────────────────────
function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function reformatYmd(s: string): string {
  // Already validated to YYYY-MM-DD by isYmd(); re-stringify via Date to catch
  // invalid calendar dates like 2026-02-30. JavaScript's Date silently rolls
  // over impossible day/month values (Feb 30 → Mar 2), so we round-trip
  // through ISO and require the result equals the input.
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error("invalid_date");
  const out = d.toISOString().slice(0, 10);
  if (out !== s) throw new Error("invalid_date");
  return out;
}
function diffDays(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1; // inclusive
}

export type ToolError = { error: string; hint?: string };
export type ToolResult<T> =
  | { ok: true; data: T; meta: { ms: number; result_rows: number; range_days: number; truncated: boolean } }
  | { ok: false; error: ToolError; meta: { ms: number; range_days: number } };

// ── query_daily_logs executor ────────────────────────────────────────────────
type DailyLogsRawData = Record<string, unknown>[];
type DailyLogsAggData = {
  range: { start_date: string; end_date: string; days: number };
  values: Record<string, number | string | null>;
  non_null_count: Record<string, number>;
  null_count: Record<string, number>;
};

export async function executeQueryDailyLogs(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<DailyLogsRawData | DailyLogsAggData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // --- Validation (security invariants 3, 4) ---
  if (!isYmd(i.start_date) || !isYmd(i.end_date)) {
    return {
      ok: false,
      error: { error: "start_date and end_date must be YYYY-MM-DD" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  let start: string, end: string;
  try {
    start = reformatYmd(i.start_date);
    end = reformatYmd(i.end_date);
  } catch {
    return {
      ok: false,
      error: { error: "invalid calendar date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (start > end) {
    return {
      ok: false,
      error: { error: "start_date must be <= end_date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const range_days = diffDays(start, end);

  const aggregateRaw = i.aggregate ?? "raw";
  if (typeof aggregateRaw !== "string" || !ALLOWED_AGGREGATES.includes(aggregateRaw as AggregateMode)) {
    return {
      ok: false,
      error: { error: `aggregate must be one of: ${ALLOWED_AGGREGATES.join(", ")}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const aggregate = aggregateRaw as AggregateMode;

  let columns: AllowedColumn[];
  if (i.columns === undefined) {
    columns = [...ALLOWED_COLUMNS];
  } else if (Array.isArray(i.columns) && i.columns.every((c) => typeof c === "string")) {
    const unknownCol = (i.columns as string[]).find((c) => !ALLOWED_COLUMNS.includes(c as AllowedColumn));
    if (unknownCol !== undefined) {
      return {
        ok: false,
        error: { error: `unknown column: ${unknownCol}`, hint: `allowed: ${ALLOWED_COLUMNS.join(", ")}` },
        meta: { ms: Date.now() - t0, range_days },
      };
    }
    columns = i.columns as AllowedColumn[];
  } else {
    return {
      ok: false,
      error: { error: "columns must be an array of strings or omitted" },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  // --- Range cap (security invariant 5) ---
  if (aggregate === "raw" && range_days > 90) {
    return {
      ok: false,
      error: {
        error: `raw mode max 90 days; got ${range_days}`,
        hint: "switch to aggregate or narrow start_date",
      },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  // --- Query (security invariant 2: .eq("user_id", userId)) ---
  const selectCols = ["date", ...columns].join(", ");
  const { data: rows, error } = await opts.supabase
    .from("daily_logs")
    .select(selectCols)
    .eq("user_id", opts.userId)
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: true });
  if (error) {
    return {
      ok: false,
      error: { error: `db_error: ${error.message}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  if (aggregate === "raw") {
    const data = (rows ?? []) as unknown as DailyLogsRawData;
    return {
      ok: true,
      data,
      meta: { ms: Date.now() - t0, result_rows: data.length, range_days, truncated: false },
    };
  }

  // --- Aggregate path ---
  const values: Record<string, number | string | null> = {};
  const nonNull: Record<string, number> = {};
  const nulls: Record<string, number> = {};
  for (const c of columns) {
    nonNull[c] = 0;
    nulls[c] = 0;
  }
  // For string columns (notes), aggregate is meaningless — emit null.
  const numericCols: AllowedColumn[] = columns.filter((c) => c !== "notes") as AllowedColumn[];
  const stringCols: AllowedColumn[] = columns.filter((c) => c === "notes") as AllowedColumn[];

  for (const r of rows ?? []) {
    const row = r as unknown as Record<string, unknown>;
    for (const c of columns) {
      const v = row[c];
      if (v === null || v === undefined) nulls[c]++;
      else nonNull[c]++;
    }
  }

  for (const c of numericCols) {
    const nums: number[] = [];
    for (const r of rows ?? []) {
      const v = (r as unknown as Record<string, unknown>)[c];
      if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    }
    if (nums.length === 0) {
      values[c] = null;
      continue;
    }
    let agg: number;
    switch (aggregate) {
      case "avg":
        agg = nums.reduce((a, b) => a + b, 0) / nums.length;
        agg = Math.round(agg * 100) / 100;
        break;
      case "sum":
        agg = nums.reduce((a, b) => a + b, 0);
        agg = Math.round(agg * 100) / 100;
        break;
      case "min":
        agg = Math.min(...nums);
        break;
      case "max":
        agg = Math.max(...nums);
        break;
      default:
        agg = NaN;
    }
    values[c] = Number.isFinite(agg) ? agg : null;
  }
  for (const c of stringCols) {
    values[c] = null; // aggregate over text is meaningless
  }

  const data: DailyLogsAggData = {
    range: { start_date: start, end_date: end, days: range_days },
    values,
    non_null_count: nonNull,
    null_count: nulls,
  };
  return {
    ok: true,
    data,
    meta: { ms: Date.now() - t0, result_rows: 1, range_days, truncated: false },
  };
}

// ── query_workouts executor ──────────────────────────────────────────────────

type WorkoutSummaryRow = {
  date: string;
  type: string | null;
  duration_min: number | null;
  total_volume_kg: number;
  working_set_count: number;
  hard_set_count: number;
  top_sets_per_exercise: {
    exercise_name: string;
    category: ExerciseCategory;
    kg: number | null;
    reps: number | null;
    duration_seconds: number | null;
    e1RM: number | null;
  }[];
};

type WorkoutSetRow = {
  date: string;
  exercise_name: string;
  category: ExerciseCategory;
  set_index: number;
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  e1RM: number | null;
  failure: boolean;
};

type WorkoutPeriodRow = {
  period_start: string;
  period_end: string;
  workout_count: number;
  total_volume_kg: number;
  set_counts_by_category: Record<ExerciseCategory, number>;
  top_set_per_exercise: {
    exercise_name: string;
    category: ExerciseCategory;
    kg: number | null;
    reps: number | null;
    duration_seconds: number | null;
    e1RM: number | null;
    date: string;
  }[];
};

const SETS_PER_EXERCISE_CAP = 60;
const SETS_TOTAL_CAP = 400;
const SUMMARY_CAP = 90;

type RawWorkout = {
  id: string;
  date: string;
  type: string | null;
  duration_min: number | null;
  exercises: {
    name: string;
    position: number | null;
    exercise_sets: {
      kg: number | null;
      reps: number | null;
      duration_seconds: number | null;
      warmup: boolean;
      failure: boolean;
      set_index: number;
    }[];
  }[] | null;
};

type WorkoutsToolData =
  | WorkoutSummaryRow[]
  | WorkoutSetRow[]
  | WorkoutPeriodRow[]
  | { rows: WorkoutSummaryRow[] | WorkoutSetRow[]; truncated: true; matched_total: number; returned: number; hint: string };

export async function executeQueryWorkouts(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<WorkoutsToolData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // --- Validation ---
  if (!isYmd(i.start_date) || !isYmd(i.end_date)) {
    return {
      ok: false,
      error: { error: "start_date and end_date must be YYYY-MM-DD" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  let start: string, end: string;
  try {
    start = reformatYmd(i.start_date);
    end = reformatYmd(i.end_date);
  } catch {
    return {
      ok: false,
      error: { error: "invalid calendar date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (start > end) {
    return {
      ok: false,
      error: { error: "start_date must be <= end_date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const range_days = diffDays(start, end);

  const granRaw = i.granularity ?? "summary";
  if (typeof granRaw !== "string" || !ALLOWED_GRANULARITIES.includes(granRaw as WorkoutGranularity)) {
    return {
      ok: false,
      error: { error: `granularity must be one of: ${ALLOWED_GRANULARITIES.join(", ")}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const granularity = granRaw as WorkoutGranularity;

  const exerciseFilterRaw = i.exercise_name;
  if (exerciseFilterRaw !== undefined && typeof exerciseFilterRaw !== "string") {
    return {
      ok: false,
      error: { error: "exercise_name must be a string or omitted" },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const exerciseFilter = (exerciseFilterRaw as string | undefined)?.toLowerCase() ?? null;

  // --- Query (security invariant 2: .eq) ---
  const { data: workouts, error } = await opts.supabase
    .from("workouts")
    .select(
      `id, date, type, duration_min,
       exercises(name, position,
         exercise_sets(kg, reps, duration_seconds, warmup, failure, set_index))`,
    )
    .eq("user_id", opts.userId)
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: true });
  if (error) {
    return {
      ok: false,
      error: { error: `db_error: ${error.message}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const raws = (workouts ?? []) as unknown as RawWorkout[];

  // --- Branch by granularity ---
  if (granularity === "summary") {
    const all = raws.map((w) => buildSummary(w, exerciseFilter));
    const truncated = all.length > SUMMARY_CAP;
    const slice = truncated ? all.slice(-SUMMARY_CAP) : all;
    const data = truncated
      ? { rows: slice, truncated: true as const, matched_total: all.length, returned: slice.length, hint: "exceeds 90-workout cap; slice is most recent. Switch to granularity: 'by_week' or 'by_month' for a complete view." }
      : slice;
    return {
      ok: true,
      data,
      meta: { ms: Date.now() - t0, result_rows: slice.length, range_days, truncated },
    };
  }

  if (granularity === "sets") {
    const all = flattenSets(raws, exerciseFilter);
    // Per-exercise cap, then total cap. Both apply; per-exercise first so a
    // dominant lift can't starve everything else.
    const byExercise = new Map<string, WorkoutSetRow[]>();
    for (const r of all) {
      const arr = byExercise.get(r.exercise_name) ?? [];
      arr.push(r);
      byExercise.set(r.exercise_name, arr);
    }
    let perExerciseTrimmed = 0;
    for (const [k, arr] of byExercise) {
      if (arr.length > SETS_PER_EXERCISE_CAP) {
        perExerciseTrimmed += arr.length - SETS_PER_EXERCISE_CAP;
        byExercise.set(k, arr.slice(-SETS_PER_EXERCISE_CAP));
      }
    }
    const merged: WorkoutSetRow[] = [];
    for (const arr of byExercise.values()) merged.push(...arr);
    merged.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.exercise_name.localeCompare(b.exercise_name) ||
        a.set_index - b.set_index,
    );
    const totalTrimmed = merged.length > SETS_TOTAL_CAP;
    const slice = totalTrimmed ? merged.slice(-SETS_TOTAL_CAP) : merged;
    const truncated = totalTrimmed || perExerciseTrimmed > 0;
    const matchedTotal = merged.length + perExerciseTrimmed;
    const data = truncated
      ? { rows: slice, truncated: true as const, matched_total: matchedTotal, returned: slice.length, hint: "exceeds set caps (60/exercise, 400 total). Slice is most recent. Narrow start_date or filter exercise_name." }
      : slice;
    return {
      ok: true,
      data,
      meta: {
        ms: Date.now() - t0,
        result_rows: slice.length,
        range_days,
        truncated,
      },
    };
  }

  // by_week / by_month
  const bucketFn = granularity === "by_week" ? weekStart : monthStart;
  const buckets = new Map<string, RawWorkout[]>();
  for (const w of raws) {
    const k = bucketFn(w.date);
    const arr = buckets.get(k) ?? [];
    arr.push(w);
    buckets.set(k, arr);
  }
  const periodRows: WorkoutPeriodRow[] = [];
  for (const [k, ws] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    periodRows.push(buildPeriodRow(k, ws, exerciseFilter));
  }
  return {
    ok: true,
    data: periodRows,
    meta: { ms: Date.now() - t0, result_rows: periodRows.length, range_days, truncated: false },
  };
}

// ── Internal builders ────────────────────────────────────────────────────────

function flattenSets(workouts: RawWorkout[], exerciseFilter: string | null): WorkoutSetRow[] {
  const out: WorkoutSetRow[] = [];
  for (const w of workouts) {
    for (const e of w.exercises ?? []) {
      if (exerciseFilter && !e.name.toLowerCase().includes(exerciseFilter)) continue;
      const cat = categorize(e.name);
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue; // warmups always excluded
        out.push({
          date: w.date,
          exercise_name: e.name,
          category: cat,
          set_index: s.set_index,
          kg: s.kg,
          reps: s.reps,
          duration_seconds: s.duration_seconds,
          e1RM: epley(s.kg, s.reps),
          failure: s.failure,
        });
      }
    }
  }
  return out;
}

function buildSummary(w: RawWorkout, exerciseFilter: string | null): WorkoutSummaryRow {
  // Accumulate volume / set counts across the WHOLE session even when the
  // user filtered to one exercise (filter applies to top_sets_per_exercise
  // listing only — the volume/counts answer "how was this session" honestly).
  const allWorkingSets: SetRow[] = [];
  for (const e of w.exercises ?? []) {
    for (const s of e.exercise_sets ?? []) {
      allWorkingSets.push({
        kg: s.kg,
        reps: s.reps,
        duration_seconds: s.duration_seconds,
        warmup: s.warmup,
        failure: s.failure,
      });
    }
  }
  const topPerExercise: WorkoutSummaryRow["top_sets_per_exercise"] = [];
  for (const e of w.exercises ?? []) {
    if (exerciseFilter && !e.name.toLowerCase().includes(exerciseFilter)) continue;
    const sets: SetRow[] = (e.exercise_sets ?? []).map((s) => ({
      kg: s.kg,
      reps: s.reps,
      duration_seconds: s.duration_seconds,
      warmup: s.warmup,
      failure: s.failure,
    }));
    const top = topSet(sets);
    if (top) {
      topPerExercise.push({
        exercise_name: e.name,
        category: categorize(e.name),
        kg: top.kg,
        reps: top.reps,
        duration_seconds: top.duration_seconds,
        e1RM: top.e1RM,
      });
    }
  }
  return {
    date: w.date,
    type: w.type,
    duration_min: w.duration_min,
    total_volume_kg: workingVolume(allWorkingSets),
    working_set_count: workingSetCount(allWorkingSets),
    hard_set_count: hardSetCount(allWorkingSets),
    top_sets_per_exercise: topPerExercise,
  };
}

function buildPeriodRow(
  bucketStart: string,
  workouts: RawWorkout[],
  exerciseFilter: string | null,
): WorkoutPeriodRow {
  // Period end is the last workout in the bucket — caller doesn't need
  // exact week-end / month-end since the bucket is computed by start key.
  const lastDate = workouts[workouts.length - 1].date;
  // Aggregate volume + per-category set counts across the bucket.
  let total = 0;
  const setCounts: Record<ExerciseCategory, number> = {
    push: 0, pull: 0, squat: 0, hinge: 0,
    "single-leg": 0, core: 0, accessory: 0, uncategorized: 0,
  };
  // Track top set per exercise across the period.
  const bestByExercise = new Map<
    string,
    { kg: number | null; reps: number | null; duration_seconds: number | null; e1RM: number | null; date: string; category: ExerciseCategory }
  >();
  for (const w of workouts) {
    for (const e of w.exercises ?? []) {
      const cat = categorize(e.name);
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue;
        if (s.kg !== null && s.reps !== null) {
          total += s.kg * s.reps;
        }
        setCounts[cat]++;
      }
      // Top set across this period for this exercise:
      if (exerciseFilter && !e.name.toLowerCase().includes(exerciseFilter)) continue;
      const sets: SetRow[] = (e.exercise_sets ?? []).map((s) => ({
        kg: s.kg, reps: s.reps, duration_seconds: s.duration_seconds,
        warmup: s.warmup, failure: s.failure,
      }));
      const top = topSet(sets);
      if (top) {
        const prev = bestByExercise.get(e.name);
        const beats =
          !prev ||
          (top.e1RM !== null && (prev.e1RM === null || top.e1RM > prev.e1RM)) ||
          (top.e1RM === null &&
            prev.e1RM === null &&
            ((top.kg ?? 0) > (prev.kg ?? 0) ||
              ((top.kg ?? 0) === (prev.kg ?? 0) && (top.reps ?? 0) > (prev.reps ?? 0))));
        if (beats) {
          bestByExercise.set(e.name, {
            kg: top.kg,
            reps: top.reps,
            duration_seconds: top.duration_seconds,
            e1RM: top.e1RM,
            date: w.date,
            category: cat,
          });
        }
      }
    }
  }
  const topList: WorkoutPeriodRow["top_set_per_exercise"] = [];
  for (const [name, b] of bestByExercise) {
    topList.push({
      exercise_name: name,
      category: b.category,
      kg: b.kg,
      reps: b.reps,
      duration_seconds: b.duration_seconds,
      e1RM: b.e1RM,
      date: b.date,
    });
  }
  return {
    period_start: bucketStart,
    period_end: lastDate,
    workout_count: workouts.length,
    total_volume_kg: Math.round(total),
    set_counts_by_category: setCounts,
    top_set_per_exercise: topList,
  };
}
