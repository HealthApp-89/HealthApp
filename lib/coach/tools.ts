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
import { signApprovalToken, verifyApprovalToken } from "@/lib/coach/approval-token";
import type { TrainingBlock, TrainingWeek } from "@/lib/data/types";
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
import type { PrimaryLift } from "@/lib/data/types";
import { todayInUserTz } from "@/lib/time";
import { computeAdherence } from "@/lib/coach/adherence";
import { getAutoregulationSignals } from "@/lib/coach/autoregulation";

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

export const TRAINING_BLOCKS_TOOL = {
  name: "query_training_blocks",
  description:
    "Fetch the athlete's training blocks. Default returns the active block (or 0 rows if none). status='all' returns full history. Use when planning a week or recapping block-level progress.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string", enum: ["active", "completed", "abandoned", "all"], default: "active" },
    },
  },
};

export const TRAINING_WEEKS_TOOL = {
  name: "query_training_weeks",
  description:
    "Fetch committed weekly plans (training_weeks rows) in a date range. Range cap: 90 days. Use when recapping a recent week or referencing what was committed.",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date: { type: "string", format: "date" },
    },
  },
};

export const AUTOREGULATION_TOOL = {
  name: "get_autoregulation_signals",
  description:
    "Compute the 4 fatigue signals (HRV vs SWC band, e1RM drop on primary lift, RPE drift, sleep<6h nights) for an as-of date. Returns count of signals fired and should_deload boolean (count>=2). Call before proposing a week plan to surface deload alerts.",
  input_schema: {
    type: "object" as const,
    properties: {
      as_of: { type: "string", format: "date", description: "Defaults to today (user TZ)." },
    },
  },
};

export const ADHERENCE_TOOL = {
  name: "compute_adherence",
  description:
    "Compute planned-vs-actual session adherence and per-muscle volume deltas vs prior-4w-avg for a Mon-Sun window. Use during the RECAP beat of plan_week mode to ground the recap in concrete numbers.",
  input_schema: {
    type: "object" as const,
    required: ["week_start"],
    properties: {
      week_start: { type: "string", format: "date", description: "Monday (UTC) of the week to recap." },
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

// ── query_training_blocks executor ───────────────────────────────────────────

const ALLOWED_BLOCK_STATUSES = ["active", "completed", "abandoned", "all"] as const;
type BlockStatusFilter = (typeof ALLOWED_BLOCK_STATUSES)[number];

export async function executeQueryTrainingBlocks(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<Record<string, unknown>[]>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  const statusRaw = i.status ?? "active";
  if (typeof statusRaw !== "string" || !ALLOWED_BLOCK_STATUSES.includes(statusRaw as BlockStatusFilter)) {
    return {
      ok: false,
      error: { error: `status must be one of: ${ALLOWED_BLOCK_STATUSES.join(", ")}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const status = statusRaw as BlockStatusFilter;

  let query = opts.supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", opts.userId);
  if (status !== "all") {
    query = query.eq("status", status);
  }
  query = query.order("start_date", { ascending: false });

  const { data: rows, error } = await query;
  if (error) {
    return {
      ok: false,
      error: { error: `db_error: ${error.message}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const today = todayInUserTz();

  // Lazy auto-flip: active blocks whose end_date is in the past → completed
  const flipped: Record<string, unknown>[] = [];
  for (const row of rows ?? []) {
    const r = row as Record<string, unknown>;
    if (r.status === "active" && typeof r.end_date === "string" && r.end_date < today) {
      const { data: updated, error: updateErr } = await opts.supabase
        .from("training_blocks")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("user_id", opts.userId)
        .eq("id", r.id)
        .select("*")
        .maybeSingle();
      if (!updateErr && updated) {
        flipped.push(updated as Record<string, unknown>);
      } else {
        flipped.push(r);
      }
    } else {
      flipped.push(r);
    }
  }

  return {
    ok: true,
    data: flipped,
    meta: { ms: Date.now() - t0, result_rows: flipped.length, range_days: 0, truncated: false },
  };
}

// ── query_training_weeks executor ────────────────────────────────────────────

export async function executeQueryTrainingWeeks(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<Record<string, unknown>[]>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

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
  if (range_days > 90) {
    return {
      ok: false,
      error: { error: "range > 90 days; narrow your query" },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  const { data: rows, error } = await opts.supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", opts.userId)
    .gte("week_start", start)
    .lte("week_start", end)
    .order("week_start", { ascending: true });
  if (error) {
    return {
      ok: false,
      error: { error: `db_error: ${error.message}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  const data = (rows ?? []) as unknown as Record<string, unknown>[];
  return {
    ok: true,
    data,
    meta: { ms: Date.now() - t0, result_rows: data.length, range_days, truncated: false },
  };
}

// ── get_autoregulation_signals executor ──────────────────────────────────────

export async function executeGetAutoregulationSignals(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<ReturnType<typeof getAutoregulationSignals> extends Promise<infer R> ? R : never>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  let asOf: string;
  if (i.as_of !== undefined) {
    if (!isYmd(i.as_of)) {
      return {
        ok: false,
        error: { error: "as_of must be YYYY-MM-DD or omitted" },
        meta: { ms: Date.now() - t0, range_days: 7 },
      };
    }
    try {
      asOf = reformatYmd(i.as_of);
    } catch {
      return {
        ok: false,
        error: { error: "invalid calendar date for as_of" },
        meta: { ms: Date.now() - t0, range_days: 7 },
      };
    }
  } else {
    asOf = todayInUserTz();
  }

  // Look up active block's primary_lift (security invariant 2: .eq("user_id"))
  const { data: activeBlock } = await opts.supabase
    .from("training_blocks")
    .select("primary_lift")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();
  const primaryLift = (activeBlock?.primary_lift as PrimaryLift | null) ?? null;

  try {
    const result = await getAutoregulationSignals(opts.supabase, opts.userId, asOf, primaryLift);
    return {
      ok: true,
      data: result,
      meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false },
    };
  } catch (e) {
    return {
      ok: false,
      error: { error: `autoregulation_error: ${(e as Error).message}` },
      meta: { ms: Date.now() - t0, range_days: 7 },
    };
  }
}

// ── compute_adherence executor ───────────────────────────────────────────────

export async function executeComputeAdherence(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<ReturnType<typeof computeAdherence> extends Promise<infer R> ? R : never>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (!isYmd(i.week_start)) {
    return {
      ok: false,
      error: { error: "week_start must be YYYY-MM-DD" },
      meta: { ms: Date.now() - t0, range_days: 7 },
    };
  }
  let weekStart: string;
  try {
    weekStart = reformatYmd(i.week_start);
  } catch {
    return {
      ok: false,
      error: { error: "invalid calendar date for week_start" },
      meta: { ms: Date.now() - t0, range_days: 7 },
    };
  }

  try {
    const result = await computeAdherence(opts.supabase, opts.userId, weekStart);
    return {
      ok: true,
      data: result,
      meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false },
    };
  } catch (e) {
    return {
      ok: false,
      error: { error: `adherence_error: ${(e as Error).message}` },
      meta: { ms: Date.now() - t0, range_days: 7 },
    };
  }
}

// ── Write tool schemas ────────────────────────────────────────────────────────

export const PROPOSE_BLOCK_TOOL = {
  name: "propose_block",
  description:
    "Generate a preview of a new 5-week training block. Does NOT write to the database. Returns a preview object plus an approval_token that the matching commit_block call must include after the user explicitly approves the proposal.",
  input_schema: {
    type: "object" as const,
    required: ["goal_text", "start_date", "end_date"],
    properties: {
      goal_text:     { type: "string", minLength: 4, maxLength: 200 },
      primary_lift:  { type: "string", enum: ["squat","bench","deadlift","ohp"] },
      target_metric: { type: "string", enum: ["e1rm","working_weight"] },
      target_value:  { type: "number", minimum: 0 },
      target_unit:   { type: "string", default: "kg" },
      start_date:    { type: "string", format: "date", description: "Must be a Monday." },
      end_date:      { type: "string", format: "date", description: "Must be exactly start_date + 34 days." },
    },
  },
};

export const COMMIT_BLOCK_TOOL = {
  name: "commit_block",
  description:
    "Commit a previously proposed block. Requires the approval_token returned by propose_block. Idempotent on the user's active-block partial unique index — fails if the user already has an active block.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export const PROPOSE_WEEK_PLAN_TOOL = {
  name: "propose_week_plan",
  description:
    "Generate a preview of a weekly training plan. Does NOT write. Returns preview + approval_token. Call after deriving RIR target from week-of-block (1-4 = accumulate, 5 = deload) and consulting get_autoregulation_signals.",
  input_schema: {
    type: "object" as const,
    required: ["week_start", "session_plan"],
    properties: {
      week_start:         { type: "string", format: "date", description: "Must be a Monday." },
      session_plan:       {
        type: "object",
        description: "Mon-Sun map of session-type strings (or 'REST').",
        additionalProperties: { type: "string" },
      },
      weekly_focus:       { type: "string", maxLength: 200 },
      intensity_modifier: {
        type: "object",
        description: "Per-primary-lift multipliers, e.g. {squat: 0.95}.",
        additionalProperties: { type: "number" },
      },
      rir_target:         { type: "integer", minimum: 1, maximum: 4 },
      research_phase:     { type: "string", enum: ["accumulate","deload"] },
      rationale:          { type: "string", maxLength: 500, description: "Surfaced to the user in the proposal preview card." },
    },
  },
};

export const COMMIT_WEEK_PLAN_TOOL = {
  name: "commit_week_plan",
  description:
    "Commit a previously proposed week plan. Requires the approval_token from propose_week_plan. Idempotent on (user_id, week_start) — re-committing UPDATEs the existing row.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

// ── Write tool executor types ─────────────────────────────────────────────────

type ProposeBlockInput = {
  goal_text: string;
  primary_lift?: PrimaryLift;
  target_metric?: "e1rm" | "working_weight";
  target_value?: number;
  target_unit?: string;
  start_date: string;
  end_date: string;
};

type ProposeWeekPlanInput = {
  week_start: string;
  session_plan: Record<string, string>;
  weekly_focus?: string;
  intensity_modifier?: Record<string, number>;
  rir_target?: number;
  research_phase?: "accumulate" | "deload";
  rationale?: string;
};

// ── In-memory proposal cache (process-global) ─────────────────────────────────
// Next.js routes share the same Node process for sequential requests within a
// short window, so the propose_* result can be retrieved by the matching commit_*
// call in the next assistant turn without a DB round-trip.
const _proposalCache = new Map<string, { kind: "block" | "week"; payload: unknown }>();

// ── propose_block executor ────────────────────────────────────────────────────

export async function executeProposeBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: ProposeBlockInput; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.goal_text !== "string" || i.goal_text.length < 4 || i.goal_text.length > 200) {
    return { ok: false, error: { error: "goal_text required (4-200 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!isYmd(i.start_date) || !isYmd(i.end_date)) {
    return { ok: false, error: { error: "start_date/end_date must be YYYY-MM-DD" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const start = new Date((i.start_date as string) + "T00:00:00Z");
  const end = new Date((i.end_date as string) + "T00:00:00Z");
  if (start.getUTCDay() !== 1) {
    return { ok: false, error: { error: "start_date must be a Monday" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const expectedEnd = new Date(start);
  expectedEnd.setUTCDate(start.getUTCDate() + 34);
  if (end.toISOString().slice(0, 10) !== expectedEnd.toISOString().slice(0, 10)) {
    return { ok: false, error: { error: "end_date must be exactly start_date + 34 days (5 weeks)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  // target_metric and target_value must come together
  const hasMetric = i.target_metric != null;
  const hasValue = i.target_value != null;
  if (hasMetric !== hasValue) {
    return { ok: false, error: { error: "target_metric and target_value must both be set or both null" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const payload = i as unknown as ProposeBlockInput;
  const token = signApprovalToken({ userId: opts.userId, action: "block", payload });
  _proposalCache.set(token, { kind: "block", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}

// ── commit_block executor ─────────────────────────────────────────────────────

export async function executeCommitBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<TrainingBlock>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;

  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const cached = _proposalCache.get(token);
  if (!cached || cached.kind !== "block") {
    return { ok: false, error: { error: "no matching block proposal in cache; re-propose" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  try {
    verifyApprovalToken({ token, userId: opts.userId, action: "block", payload: cached.payload });
  } catch (e) {
    return { ok: false, error: { error: `token verification failed: ${(e as Error).message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const p = cached.payload as ProposeBlockInput;
  const { data, error } = await opts.supabase
    .from("training_blocks")
    .insert({
      user_id: opts.userId,
      status: "active",
      start_date: p.start_date,
      end_date: p.end_date,
      goal_text: p.goal_text,
      primary_lift: p.primary_lift ?? null,
      target_metric: p.target_metric ?? null,
      target_value: p.target_value ?? null,
      target_unit: p.target_unit ?? "kg",
    })
    .select()
    .single();
  if (error) {
    return { ok: false, error: { error: `insert failed: ${error.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  _proposalCache.delete(token);
  return {
    ok: true,
    data: data as TrainingBlock,
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}

// ── propose_week_plan executor ────────────────────────────────────────────────

export async function executeProposeWeekPlan(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: ProposeWeekPlanInput; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (!isYmd(i.week_start)) {
    return { ok: false, error: { error: "week_start must be YYYY-MM-DD" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const ws = new Date((i.week_start as string) + "T00:00:00Z");
  if (ws.getUTCDay() !== 1) {
    return { ok: false, error: { error: "week_start must be a Monday" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.session_plan !== "object" || i.session_plan === null) {
    return { ok: false, error: { error: "session_plan must be an object" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const payload = i as unknown as ProposeWeekPlanInput;
  const token = signApprovalToken({ userId: opts.userId, action: "week", payload });
  _proposalCache.set(token, { kind: "week", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false },
  };
}

// ── commit_week_plan executor ─────────────────────────────────────────────────

export async function executeCommitWeekPlan(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
  chatMessageId?: string | null;
}): Promise<ToolResult<TrainingWeek>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;

  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const cached = _proposalCache.get(token);
  if (!cached || cached.kind !== "week") {
    return { ok: false, error: { error: "no matching week proposal in cache; re-propose" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  try {
    verifyApprovalToken({ token, userId: opts.userId, action: "week", payload: cached.payload });
  } catch (e) {
    return { ok: false, error: { error: `token verification failed: ${(e as Error).message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const p = cached.payload as ProposeWeekPlanInput;

  // Find active block for block_id (nullable) — security invariant 2: .eq("user_id")
  const { data: active } = await opts.supabase
    .from("training_blocks")
    .select("id")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();

  const { data, error } = await opts.supabase
    .from("training_weeks")
    .upsert(
      {
        user_id: opts.userId,
        block_id: active?.id ?? null,
        week_start: p.week_start,
        session_plan: p.session_plan,
        weekly_focus: p.weekly_focus ?? null,
        intensity_modifier: p.intensity_modifier ?? {},
        rir_target: p.rir_target ?? null,
        research_phase: p.research_phase ?? null,
        proposed_by: "coach",
        chat_message_id: opts.chatMessageId ?? null,
        committed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,week_start" },
    )
    .select()
    .single();
  if (error) {
    return { ok: false, error: { error: `upsert failed: ${error.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  _proposalCache.delete(token);
  return {
    ok: true,
    data: data as TrainingWeek,
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false },
  };
}
