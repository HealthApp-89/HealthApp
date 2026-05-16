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
import { signApprovalToken, verifyApprovalToken, payloadHash, ApprovalTokenError, approvalTokenUserMessage } from "@/lib/coach/approval-token";
import type { IntakePayload, PlanPayload, TrainingBlock, TrainingWeek } from "@/lib/data/types";
import { buildPlanPayload } from "@/lib/coach/plan-builder";
import { renderProfileMarkdown } from "@/lib/coach/profile-renderer";
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

export type ToolError = { error: string; hint?: string; code?: string };
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

// Approval tokens are stateless: the proposal payload is HMAC-signed and
// embedded in the token itself (lib/coach/approval-token.ts). commit_* tools
// decode it via verifyApprovalToken — no shared cache needed, so the flow
// survives multi-process Vercel deployments where propose and commit can
// land on different lambdas.

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
  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "block" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the block details. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as ProposeBlockInput;
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
    const msg = error.code === "23505"
      ? "You already have an active block. Finish or abandon it before starting another."
      : "Couldn't save the block. Please try again in a moment.";
    return { ok: false, error: { error: msg, code: error.code ?? "insert_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
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
  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "week" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the week plan. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as ProposeWeekPlanInput;

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
    return { ok: false, error: { error: "Couldn't save this week's plan. Please try again.", code: error.code ?? "upsert_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return {
    ok: true,
    data: data as TrainingWeek,
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2 — coaching plan intake tools
// ────────────────────────────────────────────────────────────────────────────
//
// All Phase 2 tools write to the user's draft athlete_profile_documents row.
// The route handler resolves draftDocId from the chat session and injects it
// alongside userId. Security invariants (mirror the file-header rules):
//   - Tool input schemas NEVER include user_id or draft_doc_id; both are
//     route-injected. The model cannot supply them.
//   - Every query is triple-scoped: .eq("id", draftDocId), .eq("user_id",
//     userId), .eq("status", "draft"). This blocks cross-user / wrong-doc /
//     already-acknowledged writes even if the doc id somehow leaked.
//   - Input enum/type validation runs BEFORE any query.

// ── Beat 1: Sanity correction tools (no HMAC — single-field writes) ─────────

export const APPLY_GOAL_TARGET_TOOL = {
  name: "apply_goal_target",
  description:
    "Beat 1 sanity-correction tool. Apply a corrected goal target (from the goal_contradiction finding's proposed_target) to intake_payload.goals. Use when user taps 'Use proposed target' chip.",
  input_schema: {
    type: "object" as const,
    required: ["target_value", "target_unit", "rationale"],
    properties: {
      target_value: { type: "number", minimum: 0 },
      target_unit: { type: "string", minLength: 1, maxLength: 16 },
      rationale: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Brief rationale (1 sentence) appended to goals.why_narrative as audit trail.",
      },
    },
  },
};

export const APPLY_BEDTIME_CORRECTION_TOOL = {
  name: "apply_bedtime_correction",
  description:
    "Beat 1 sanity-correction tool. Apply a corrected typical_bedtime (from the sleep_efficiency finding's proposed_bedtime) to intake_payload.sleep_recovery.",
  input_schema: {
    type: "object" as const,
    required: ["typical_bedtime"],
    properties: {
      typical_bedtime: {
        type: "string",
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        description: "HH:MM in 24-hour format.",
      },
    },
  },
};

export const APPLY_MACROS_CORRECTION_TOOL = {
  name: "apply_macros_correction",
  description:
    "Beat 1 sanity-correction tool. Apply corrected macros (from the macros_gap finding) to intake_payload.nutrition. Either 'match actual' (uses rolling 7d kcal) or 'hit target' (keeps stated values).",
  input_schema: {
    type: "object" as const,
    required: ["kcal", "protein_g", "carb_g", "fat_g"],
    properties: {
      kcal: { type: "number", minimum: 0 },
      protein_g: { type: "number", minimum: 0 },
      carb_g: { type: "number", minimum: 0 },
      fat_g: { type: "number", minimum: 0 },
    },
  },
};

export const APPLY_PROTEIN_CORRECTION_TOOL = {
  name: "apply_protein_correction",
  description:
    "Beat 1 sanity-correction tool. Apply corrected protein + fat (from protein_floor finding) to intake_payload.nutrition.current_macros. Keeps kcal stable.",
  input_schema: {
    type: "object" as const,
    required: ["protein_g", "fat_g"],
    properties: {
      protein_g: { type: "number", minimum: 0 },
      fat_g: { type: "number", minimum: 0 },
    },
  },
};

const SANITY_OVERRIDE_KEYS = [
  "goal_kept_despite_low_target",
  "sleep_efficiency_acknowledged",
  "macros_gap_acknowledged",
  "protein_floor_acknowledged",
] as const;
type SanityOverrideKey = (typeof SANITY_OVERRIDE_KEYS)[number];

export const SET_SANITY_OVERRIDE_TOOL = {
  name: "set_sanity_override",
  description:
    "Beat 1 sanity-correction tool. User chose to override (not apply) a finding. Writes the matching flag to intake_payload.sanity_overrides.",
  input_schema: {
    type: "object" as const,
    required: ["key"],
    properties: {
      key: { type: "string", enum: SANITY_OVERRIDE_KEYS },
    },
  },
};

// ── Beats 2-5: Slot setters (no HMAC — single-field writes) ─────────────────

export const SET_GOAL_NARRATIVE_CHAT_TOOL = {
  name: "set_goal_narrative_chat",
  description:
    "Beat 2 slot setter. Write the chat-deepened goal narrative (3-5 sentences synthesizing form why_narrative + chat answers) to intake_payload.goal_narrative_chat.",
  input_schema: {
    type: "object" as const,
    required: ["text"],
    properties: { text: { type: "string", minLength: 20, maxLength: 4000 } },
  },
};

const DIRECTNESS_VALUES = ["blunt", "balanced", "softer"] as const;
type DirectnessValue = (typeof DIRECTNESS_VALUES)[number];

export const SET_DIRECTNESS_TOOL = {
  name: "set_directness",
  description:
    "Beat 4 slot setter. Write coach directness preference to intake_payload.coaching_preferences.directness.",
  input_schema: {
    type: "object" as const,
    required: ["value"],
    properties: { value: { type: "string", enum: DIRECTNESS_VALUES } },
  },
};

const CADENCE_VALUES = ["daily", "weekly", "on_demand"] as const;
type CadenceValue = (typeof CADENCE_VALUES)[number];

export const SET_CADENCE_TOOL = {
  name: "set_cadence",
  description:
    "Beat 4 slot setter. Write check-in cadence preference to intake_payload.coaching_preferences.cadence.",
  input_schema: {
    type: "object" as const,
    required: ["value"],
    properties: { value: { type: "string", enum: CADENCE_VALUES } },
  },
};

const CHRONOTYPE_VALUES = ["lark", "neutral", "owl"] as const;
type ChronotypeValue = (typeof CHRONOTYPE_VALUES)[number];

export const SET_CHRONOTYPE_TOOL = {
  name: "set_chronotype",
  description:
    "Beat 4 slot setter. Write chronotype (lark/neutral/owl) to intake_payload.sleep_recovery.chronotype.",
  input_schema: {
    type: "object" as const,
    required: ["value"],
    properties: { value: { type: "string", enum: CHRONOTYPE_VALUES } },
  },
};

const UNPROMPTED_ACTION_VALUES = [
  "suggest_revisions",
  "nudge_on_drift",
  "flag_macros",
  "flag_sleep",
] as const;
type UnpromptedActionValue = (typeof UNPROMPTED_ACTION_VALUES)[number];

export const SET_UNPROMPTED_ACTIONS_TOOL = {
  name: "set_unprompted_actions",
  description:
    "Beat 4 slot setter. Write allowed unprompted coach actions to intake_payload.coaching_preferences.unprompted_actions.",
  input_schema: {
    type: "object" as const,
    required: ["actions"],
    properties: {
      actions: {
        type: "array",
        items: { type: "string", enum: UNPROMPTED_ACTION_VALUES },
        maxItems: UNPROMPTED_ACTION_VALUES.length,
      },
    },
  },
};

const FREE_FORM_MODES = ["append", "replace"] as const;
type FreeFormMode = (typeof FREE_FORM_MODES)[number];

export const SET_FREE_FORM_CONSTRAINTS_TOOL = {
  name: "set_free_form_constraints",
  description:
    "Beat 3 or Beat 5 slot setter. Write or append to intake_payload.free_form_constraints. Use mode='append' to add after existing text; 'replace' to overwrite.",
  input_schema: {
    type: "object" as const,
    required: ["text", "mode"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 4000 },
      mode: { type: "string", enum: FREE_FORM_MODES },
    },
  },
};

// ── End-of-intake — HMAC-gated ──────────────────────────────────────────────

export const PROPOSE_PLAN_TOOL = {
  name: "propose_plan",
  description:
    "Terminal-of-intake tool. Server runs plan-builder from current intake_payload state. Validates all sanity findings have been addressed (each has apply_* OR sanity_override). On success: writes plan_payload + rendered_md to the draft athlete_profile_documents row and returns an HMAC approval_token. On unresolved sanity findings: returns error listing the unaddressed findings.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export const COMMIT_PLAN_TOOL = {
  name: "commit_plan",
  description:
    "Atomic acknowledge tool. Verifies HMAC token from propose_plan. Flips draft athlete_profile_documents row to active; supersedes any prior active row. revalidatePath /profile, /coach, /onboarding.",
  input_schema: {
    type: "object" as const,
    required: ["token"],
    properties: { token: { type: "string", minLength: 32 } },
  },
};

// ── patchIntake helper (load-modify-write a single field on the draft) ─────

/** Load the user's draft athlete_profile_documents row, apply `patcher` to
 *  the intake_payload, write it back. Triple-scoped on (id, user_id,
 *  status='draft') so the executor cannot accidentally mutate an acknowledged
 *  doc or another user's row. Returns a ToolResult shape consistent with the
 *  rest of the file. */
async function patchIntake(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  patcher: (intake: IntakePayload) => IntakePayload;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const { data, error } = await opts.supabase
    .from("athlete_profile_documents")
    .select("intake_payload")
    .eq("id", opts.draftDocId)
    .eq("user_id", opts.userId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) {
    return { ok: false, error: { error: `load_failed: ${error.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!data) {
    return { ok: false, error: { error: "draft_not_found" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const current = data.intake_payload as IntakePayload;
  const next = opts.patcher(current);
  const { error: updErr } = await opts.supabase
    .from("athlete_profile_documents")
    .update({ intake_payload: next, updated_at: new Date().toISOString() })
    .eq("id", opts.draftDocId)
    .eq("user_id", opts.userId)
    .eq("status", "draft");
  if (updErr) {
    return { ok: false, error: { error: `update_failed: ${updErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return {
    ok: true,
    data: { ok: true },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

// ── Executors: Beat 1 sanity-correction tools ───────────────────────────────

export async function executeApplyGoalTarget(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.target_value !== "number" || !Number.isFinite(i.target_value) || i.target_value < 0) {
    return { ok: false, error: { error: "target_value must be a non-negative number" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.target_unit !== "string" || i.target_unit.length < 1 || i.target_unit.length > 16) {
    return { ok: false, error: { error: "target_unit required (1-16 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.rationale !== "string" || i.rationale.length < 1 || i.rationale.length > 500) {
    return { ok: false, error: { error: "rationale required (1-500 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const target_value = i.target_value;
  const target_unit = i.target_unit;
  const rationale = i.rationale;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      goals: {
        ...intake.goals,
        target_value,
        target_unit,
        why_narrative: `${intake.goals.why_narrative ?? ""}${intake.goals.why_narrative ? "\n\n" : ""}[Updated target during intake: ${rationale}]`,
      },
    }),
  });
}

export async function executeApplyBedtimeCorrection(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.typical_bedtime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(i.typical_bedtime)) {
    return { ok: false, error: { error: "typical_bedtime must match HH:MM 24-hour" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const typical_bedtime = i.typical_bedtime;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      sleep_recovery: { ...intake.sleep_recovery, typical_bedtime },
    }),
  });
}

export async function executeApplyMacrosCorrection(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  for (const k of ["kcal", "protein_g", "carb_g", "fat_g"] as const) {
    const v = i[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { ok: false, error: { error: `${k} must be a non-negative number` }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }
  const kcal = i.kcal as number;
  const protein_g = i.protein_g as number;
  const carb_g = i.carb_g as number;
  const fat_g = i.fat_g as number;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      nutrition: {
        ...intake.nutrition,
        current_kcal: kcal,
        current_macros: { protein_g, carb_g, fat_g },
      },
    }),
  });
}

export async function executeApplyProteinCorrection(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  for (const k of ["protein_g", "fat_g"] as const) {
    const v = i[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { ok: false, error: { error: `${k} must be a non-negative number` }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }
  const protein_g = i.protein_g as number;
  const fat_g = i.fat_g as number;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      nutrition: {
        ...intake.nutrition,
        current_macros: {
          ...intake.nutrition.current_macros,
          protein_g,
          fat_g,
        },
      },
    }),
  });
}

export async function executeSetSanityOverride(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.key !== "string" || !(SANITY_OVERRIDE_KEYS as readonly string[]).includes(i.key)) {
    return { ok: false, error: { error: `key must be one of: ${SANITY_OVERRIDE_KEYS.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const key = i.key as SanityOverrideKey;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      sanity_overrides: { ...(intake.sanity_overrides ?? {}), [key]: true },
    }),
  });
}

// ── Executors: Beats 2-5 slot setters ───────────────────────────────────────

export async function executeSetGoalNarrativeChat(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.text !== "string" || i.text.length < 20 || i.text.length > 4000) {
    return { ok: false, error: { error: "text required (20-4000 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const text = i.text;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({ ...intake, goal_narrative_chat: text }),
  });
}

export async function executeSetDirectness(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.value !== "string" || !(DIRECTNESS_VALUES as readonly string[]).includes(i.value)) {
    return { ok: false, error: { error: `value must be one of: ${DIRECTNESS_VALUES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const value = i.value as DirectnessValue;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      coaching_preferences: {
        directness: value,
        cadence: intake.coaching_preferences?.cadence ?? "weekly",
        unprompted_actions: intake.coaching_preferences?.unprompted_actions ?? [],
      },
    }),
  });
}

export async function executeSetCadence(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.value !== "string" || !(CADENCE_VALUES as readonly string[]).includes(i.value)) {
    return { ok: false, error: { error: `value must be one of: ${CADENCE_VALUES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const value = i.value as CadenceValue;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      coaching_preferences: {
        directness: intake.coaching_preferences?.directness ?? "balanced",
        cadence: value,
        unprompted_actions: intake.coaching_preferences?.unprompted_actions ?? [],
      },
    }),
  });
}

export async function executeSetChronotype(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.value !== "string" || !(CHRONOTYPE_VALUES as readonly string[]).includes(i.value)) {
    return { ok: false, error: { error: `value must be one of: ${CHRONOTYPE_VALUES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const value = i.value as ChronotypeValue;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      sleep_recovery: { ...intake.sleep_recovery, chronotype: value },
    }),
  });
}

export async function executeSetUnpromptedActions(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(i.actions)) {
    return { ok: false, error: { error: "actions must be an array" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const allowed = UNPROMPTED_ACTION_VALUES as readonly string[];
  for (const a of i.actions) {
    if (typeof a !== "string" || !allowed.includes(a)) {
      return { ok: false, error: { error: `each action must be one of: ${UNPROMPTED_ACTION_VALUES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }
  // De-dupe while preserving order
  const seen = new Set<string>();
  const actions: UnpromptedActionValue[] = [];
  for (const a of i.actions as string[]) {
    if (!seen.has(a)) {
      seen.add(a);
      actions.push(a as UnpromptedActionValue);
    }
  }
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      coaching_preferences: {
        directness: intake.coaching_preferences?.directness ?? "balanced",
        cadence: intake.coaching_preferences?.cadence ?? "weekly",
        unprompted_actions: actions,
      },
    }),
  });
}

export async function executeSetFreeFormConstraints(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (typeof i.text !== "string" || i.text.length < 1 || i.text.length > 4000) {
    return { ok: false, error: { error: "text required (1-4000 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.mode !== "string" || !(FREE_FORM_MODES as readonly string[]).includes(i.mode)) {
    return { ok: false, error: { error: `mode must be one of: ${FREE_FORM_MODES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const text = i.text;
  const mode = i.mode as FreeFormMode;
  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => {
      if (mode === "replace") {
        return { ...intake, free_form_constraints: text };
      }
      // append: separator only when prior text is non-empty
      const prior = intake.free_form_constraints ?? "";
      const sep = prior.length > 0 ? "\n\n" : "";
      return { ...intake, free_form_constraints: `${prior}${sep}${text}` };
    },
  });
}

// ── Executors: end-of-intake — HMAC-gated ───────────────────────────────────

export async function executeProposePlan(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<
  ToolResult<{ approval_token: string; plan_payload: PlanPayload }>
> {
  const t0 = Date.now();

  // Load draft (id + user_id + status='draft' triple-scoped)
  const { data: draft, error: loadErr } = await opts.supabase
    .from("athlete_profile_documents")
    .select("intake_payload, version")
    .eq("id", opts.draftDocId)
    .eq("user_id", opts.userId)
    .eq("status", "draft")
    .maybeSingle();
  if (loadErr) {
    return { ok: false, error: { error: `load_failed: ${loadErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!draft) {
    return { ok: false, error: { error: "draft_not_found" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const intake = draft.intake_payload as IntakePayload;

  // Build plan + check sanity status. runSanityChecks already skips findings
  // whose override flag is true, so any remaining findings are unaddressed.
  let buildResult;
  try {
    buildResult = await buildPlanPayload(opts.supabase, opts.userId, intake);
  } catch (e) {
    return { ok: false, error: { error: `plan_build_failed: ${(e as Error).message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const { plan_payload, sanity_findings } = buildResult;

  if (sanity_findings.length > 0) {
    return {
      ok: false,
      error: {
        error: "sanity_findings_unaddressed",
        hint: `unaddressed: ${sanity_findings.map((f) => f.type).join(", ")}`,
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Render markdown with the generated plan payload.
  const renderedMd = renderProfileMarkdown({ intake, plan: plan_payload, version: draft.version as number, acknowledgedAt: null, supersedesVersion: null });

  const { error: updErr } = await opts.supabase
    .from("athlete_profile_documents")
    .update({
      plan_payload,
      rendered_md: renderedMd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opts.draftDocId)
    .eq("user_id", opts.userId)
    .eq("status", "draft");
  if (updErr) {
    return { ok: false, error: { error: `update_failed: ${updErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Plan tokens carry a ref (doc_id + payload_hash) rather than the full
  // plan_payload — plan_payload is large and already persisted on the draft
  // row. Commit time re-reads the draft, recomputes the hash, and rejects if
  // it drifted (e.g. the model called apply_* between propose and commit).
  const token = signApprovalToken({
    userId: opts.userId,
    action: "plan",
    ref: { doc_id: opts.draftDocId, payload_hash: payloadHash(plan_payload) },
  });

  return {
    ok: true,
    data: { approval_token: token, plan_payload },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeCommitPlan(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ doc_id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.token;

  if (typeof token !== "string" || token.length < 32) {
    return { ok: false, error: { error: "token required (min 32 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Load draft to recompute payload hash (cache may have evicted in cold-start)
  const { data: draft, error: loadErr } = await opts.supabase
    .from("athlete_profile_documents")
    .select("plan_payload")
    .eq("id", opts.draftDocId)
    .eq("user_id", opts.userId)
    .eq("status", "draft")
    .maybeSingle();
  if (loadErr) {
    return { ok: false, error: { error: `load_failed: ${loadErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!draft) {
    return { ok: false, error: { error: "No draft plan found. Start the intake again from your profile.", code: "draft_not_found" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (draft.plan_payload === null) {
    return { ok: false, error: { error: "This draft has no plan yet. Run propose_plan first.", code: "no_plan_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "plan" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.ref || envelope.ref.doc_id !== opts.draftDocId) {
    return { ok: false, error: { error: "That approval belongs to a different draft plan. Please re-propose.", code: "doc_mismatch" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const currentHash = payloadHash(draft.plan_payload);
  if (currentHash !== envelope.ref.payload_hash) {
    return { ok: false, error: { error: "The plan changed after you approved it. Re-propose so I can sign the updated version.", code: "payload_drift" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // App-level supersede (mirrors Phase 1's non-transactional flow): find prior
  // active row, mark superseded, then flip draft → active.
  const { data: priorActive, error: priorErr } = await opts.supabase
    .from("athlete_profile_documents")
    .select("id")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();
  if (priorErr) {
    return { ok: false, error: { error: `prior_active_lookup_failed: ${priorErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const now = new Date().toISOString();
  if (priorActive) {
    const { error: supErr } = await opts.supabase
      .from("athlete_profile_documents")
      .update({
        status: "superseded",
        superseded_at: now,
        superseded_by: opts.draftDocId,
      })
      .eq("id", priorActive.id)
      .eq("user_id", opts.userId)
      .eq("status", "active");
    if (supErr) {
      return { ok: false, error: { error: `supersede_failed: ${supErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }

  const { error: ackErr } = await opts.supabase
    .from("athlete_profile_documents")
    .update({ status: "active", acknowledged_at: now, updated_at: now })
    .eq("id", opts.draftDocId)
    .eq("user_id", opts.userId)
    .eq("status", "draft");
  if (ackErr) {
    return { ok: false, error: { error: `acknowledge_failed: ${ackErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Invalidate ISR caches that read athlete_profile_documents. Dynamic import
  // so this module stays usable from non-route contexts (scripts, tests, etc.)
  // that don't have next/cache available.
  try {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/profile");
    revalidatePath("/coach");
    revalidatePath("/onboarding");
  } catch {
    // Non-fatal: in non-Next contexts (or if import resolves but the call
    // fails outside a request) the caller will just see slightly stale ISR
    // until the next natural revalidate.
  }

  return {
    ok: true,
    data: { doc_id: opts.draftDocId },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

// ── GLP-1 chat tools: schemas ────────────────────────────────────────────────

const GLP1_MEDICATION_VALUES = ["semaglutide", "tirzepatide", "compounded"] as const;
type Glp1Medication = (typeof GLP1_MEDICATION_VALUES)[number];

const GLP1_INJECTION_DAY_VALUES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Glp1InjectionDay = (typeof GLP1_INJECTION_DAY_VALUES)[number];

const GLP1_INJECTION_TIME_VALUES = ["morning", "evening", "night"] as const;
type Glp1InjectionTime = (typeof GLP1_INJECTION_TIME_VALUES)[number];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const SET_GLP1_STATUS_TOOL = {
  name: "set_glp1_status",
  description:
    "Beat 3 GLP-1 follow-up tool. Captures medication, dose, schedule, and taper milestones from the user and writes them to intake_payload.health.glp1_status on the draft doc.",
  input_schema: {
    type: "object" as const,
    required: ["medication", "dose_mg", "injection_day", "injection_time", "started_on"],
    properties: {
      medication: { type: "string", enum: GLP1_MEDICATION_VALUES },
      dose_mg: { type: "number", minimum: 0.1, maximum: 20 },
      injection_day: { type: "string", enum: GLP1_INJECTION_DAY_VALUES },
      injection_time: { type: "string", enum: GLP1_INJECTION_TIME_VALUES },
      started_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      expected_taper_start: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      expected_end: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      doctor_protocol_notes: { type: ["string", "null"] },
    },
  },
};

export const SET_GLP1_TAPER_STARTED_TOOL = {
  name: "set_glp1_taper_started",
  description:
    "Milestone tool. Mutates the active athlete_profile_documents row in-place to record that the GLP-1 taper has begun (nutrition.glp1.taper_started_on). Only valid when the active plan is in GLP-1 mode.",
  input_schema: {
    type: "object" as const,
    required: ["taper_started_on"],
    properties: {
      taper_started_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
  },
};

export const MARK_GLP1_DISCONTINUED_TOOL = {
  name: "mark_glp1_discontinued",
  description:
    "Milestone tool. Mutates the active athlete_profile_documents row in-place to set the GLP-1 end date (nutrition.glp1.expected_end) and surfaces a CTA string for the AI to relay verbatim in chat.",
  input_schema: {
    type: "object" as const,
    required: ["end_date"],
    properties: {
      end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
  },
};

// ── GLP-1 chat tools: executors ──────────────────────────────────────────────

export async function executeSetGlp1Status(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.medication !== "string" || !(GLP1_MEDICATION_VALUES as readonly string[]).includes(i.medication)) {
    return { ok: false, error: { error: `medication must be one of: ${GLP1_MEDICATION_VALUES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.dose_mg !== "number" || !Number.isFinite(i.dose_mg) || i.dose_mg < 0.1 || i.dose_mg > 20) {
    return { ok: false, error: { error: "dose_mg must be a number between 0.1 and 20" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.injection_day !== "string" || !(GLP1_INJECTION_DAY_VALUES as readonly string[]).includes(i.injection_day)) {
    return { ok: false, error: { error: `injection_day must be one of: ${GLP1_INJECTION_DAY_VALUES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.injection_time !== "string" || !(GLP1_INJECTION_TIME_VALUES as readonly string[]).includes(i.injection_time)) {
    return { ok: false, error: { error: `injection_time must be one of: ${GLP1_INJECTION_TIME_VALUES.join(", ")}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.started_on !== "string" || !ISO_DATE_PATTERN.test(i.started_on)) {
    return { ok: false, error: { error: "started_on must be a YYYY-MM-DD date string" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (i.expected_taper_start !== undefined && i.expected_taper_start !== null) {
    if (typeof i.expected_taper_start !== "string" || !ISO_DATE_PATTERN.test(i.expected_taper_start)) {
      return { ok: false, error: { error: "expected_taper_start must be a YYYY-MM-DD date string or null" }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }
  if (i.expected_end !== undefined && i.expected_end !== null) {
    if (typeof i.expected_end !== "string" || !ISO_DATE_PATTERN.test(i.expected_end)) {
      return { ok: false, error: { error: "expected_end must be a YYYY-MM-DD date string or null" }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }

  const medication = i.medication as Glp1Medication;
  const dose_mg = i.dose_mg;
  const injection_day = i.injection_day as Glp1InjectionDay;
  const injection_time = i.injection_time as Glp1InjectionTime;
  const started_on = i.started_on;
  const expected_taper_start = (i.expected_taper_start ?? null) as string | null;
  const expected_end = (i.expected_end ?? null) as string | null;
  const doctor_protocol_notes = (i.doctor_protocol_notes ?? null) as string | null;

  return patchIntake({
    supabase: opts.supabase,
    userId: opts.userId,
    draftDocId: opts.draftDocId,
    patcher: (intake) => ({
      ...intake,
      health: {
        ...intake.health,
        glp1_status: {
          medication,
          dose_mg,
          injection_day,
          injection_time,
          started_on,
          expected_taper_start,
          expected_end,
          doctor_protocol_notes,
        },
      },
    }),
  });
}

export async function executeSetGlp1TaperStarted(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; doc_id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.taper_started_on !== "string" || !ISO_DATE_PATTERN.test(i.taper_started_on)) {
    return { ok: false, error: { error: "taper_started_on must be a YYYY-MM-DD date string" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const taper_started_on = i.taper_started_on;
  // Plausibility: reject dates more than 7 days in the future (model hallucination guard).
  if (Date.parse(taper_started_on) > Date.now() + 7 * 86_400_000) {
    return { ok: false, error: { error: "taper_started_on must be today or within 7 days" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { data: active, error: loadErr } = await opts.supabase
    .from("athlete_profile_documents")
    .select("id, plan_payload")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (loadErr) {
    return { ok: false, error: { error: `load_failed: ${loadErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!active) {
    return { ok: false, error: { error: "no_active_doc: no acknowledged plan found" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const plan = active.plan_payload as PlanPayload;
  if (!plan || plan.nutrition.glp1 === null) {
    return { ok: false, error: { error: "active plan is not GLP-1 mode" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const nextPlan: PlanPayload = {
    ...plan,
    nutrition: {
      ...plan.nutrition,
      glp1: {
        ...plan.nutrition.glp1,
        taper_started_on,
      },
    },
  };

  const { error: updErr } = await opts.supabase
    .from("athlete_profile_documents")
    .update({ plan_payload: nextPlan, updated_at: new Date().toISOString() })
    .eq("id", active.id)
    .eq("user_id", opts.userId)
    .eq("status", "active");
  if (updErr) {
    return { ok: false, error: { error: `update_failed: ${updErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { ok: true, doc_id: active.id as string },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeMarkGlp1Discontinued(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; doc_id: string; cta: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.end_date !== "string" || !ISO_DATE_PATTERN.test(i.end_date)) {
    return { ok: false, error: { error: "end_date must be a YYYY-MM-DD date string" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const end_date = i.end_date;
  // Plausibility: reject dates more than 7 days in the future (model hallucination guard).
  if (Date.parse(end_date) > Date.now() + 7 * 86_400_000) {
    return { ok: false, error: { error: "end_date must be today or within 7 days" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { data: active, error: loadErr } = await opts.supabase
    .from("athlete_profile_documents")
    .select("id, plan_payload")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (loadErr) {
    return { ok: false, error: { error: `load_failed: ${loadErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!active) {
    return { ok: false, error: { error: "no_active_doc: no acknowledged plan found" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const plan = active.plan_payload as PlanPayload;
  if (!plan || plan.nutrition.glp1 === null) {
    return { ok: false, error: { error: "active plan is not GLP-1 mode" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  // Idempotency: don't overwrite a previously-recorded discontinuation date.
  // Historical record stays preserved; user must explicitly revise via re-plan.
  if (plan.nutrition.glp1.expected_end !== null) {
    return {
      ok: false,
      error: { error: "GLP-1 already marked discontinued; end_date is locked to preserve history" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const nextPlan: PlanPayload = {
    ...plan,
    nutrition: {
      ...plan.nutrition,
      glp1: {
        ...plan.nutrition.glp1,
        expected_end: end_date,
      },
    },
  };

  const { error: updErr } = await opts.supabase
    .from("athlete_profile_documents")
    .update({ plan_payload: nextPlan, updated_at: new Date().toISOString() })
    .eq("id", active.id)
    .eq("user_id", opts.userId)
    .eq("status", "active");
  if (updErr) {
    return { ok: false, error: { error: `update_failed: ${updErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: {
      ok: true,
      doc_id: active.id as string,
      cta: "GLP-1 era done. Want to plan your next phase? Start a fresh intake for maintenance, reverse diet, or a classical cut.",
    },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// regenerate_morning_brief — fresh structured brief card when user challenges
// data in normal coach chat ("the brief used wrong WHOOP sleep", etc.).
// Inserts a NEW chat_messages row with kind='morning_brief' so the structured
// card re-renders inline. Does not touch the checkin state machine — original
// brief stays in history; this is a refresh, not a re-issue.
// ────────────────────────────────────────────────────────────────────────────

export const REGENERATE_MORNING_BRIEF_TOOL = {
  name: "regenerate_morning_brief",
  description:
    "Regenerate today's morning brief with the latest data and insert a fresh card in the chat. Call when the user challenges the brief's data (e.g. wrong WHOOP sleep, stale macros) or explicitly asks to refresh it. Returns the new chat_message id; surface the cta string verbatim in your reply so the user knows the card was refreshed below.",
  input_schema: {
    type: "object" as const,
    properties: {
      reason: {
        type: "string",
        description: "Brief (one sentence) reason for the refresh — surfaced in observability logs only.",
      },
    },
    required: [],
  },
};

export async function executeRegenerateMorningBrief(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; message_id: string; cta: string }>> {
  const t0 = Date.now();
  // input.reason is informational only; not validated beyond shape
  const i = (opts.input ?? {}) as Record<string, unknown>;
  void i; // intentionally unused

  // Dynamic imports to avoid pulling the brief pipeline into modules that
  // import tools.ts without needing it (matches the next/cache pattern used
  // by executeCommitPlan).
  const { buildMorningBrief, composeBriefContentFallback } = await import(
    "@/lib/morning/brief"
  );

  let card;
  try {
    card = await buildMorningBrief(opts.supabase, opts.userId);
  } catch (e) {
    return {
      ok: false,
      error: { error: `brief_generation_failed: ${(e as Error).message}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const contentSummary = composeBriefContentFallback(card);
  const { data: inserted, error: insertErr } = await opts.supabase
    .from("chat_messages")
    .insert({
      user_id: opts.userId,
      role: "assistant",
      kind: "morning_brief",
      content: contentSummary,
      ui: card,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return {
      ok: false,
      error: { error: `insert_failed: ${insertErr?.message ?? "no row"}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  return {
    ok: true,
    data: {
      ok: true,
      message_id: inserted.id as string,
      cta: "Refreshed today's brief with the latest data — see the updated card below.",
    },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

// ── Mobility chat tools: schemas ─────────────────────────────────────────────

export const MARK_MOBILITY_DONE_TOOL = {
  name: "mark_mobility_done",
  description:
    "User confirmation that a mobility session is complete (today by default; pass `date` for explicit backdates the user mentions). Inserts a workouts row with type='Mobility' and source='chat' so adherence sees the session. Idempotent on (user_id, external_id) where external_id = `chat-mobility-${date}`. Call when the user signals completion (e.g., 'done', 'finished mobility', 'did my session'). Do NOT call without an explicit completion signal.",
  input_schema: {
    type: "object" as const,
    required: [],
    properties: {
      date:  { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD in user's local TZ. Defaults to today." },
      notes: { type: ["string", "null"], maxLength: 280 },
    },
  },
};

export const UNMARK_MOBILITY_DONE_TOOL = {
  name: "unmark_mobility_done",
  description:
    "User retracts a previous mobility confirmation ('actually didn't do it', 'scratch that'). Deletes the chat-inserted workouts row for the given date. NEVER deletes Strong CSV imports — guarded by source='chat' filter. Returns removed=false if nothing was deleted.",
  input_schema: {
    type: "object" as const,
    required: [],
    properties: {
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD in user's local TZ. Defaults to today." },
    },
  },
};

// ── Mobility chat tools: executors ───────────────────────────────────────────

export async function executeMarkMobilityDone(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; date: string; was_already_done: boolean }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Resolve date: default to today in user TZ; validate shape if provided.
  const today = todayInUserTz();
  let date: string;
  if (i.date === undefined || i.date === null) {
    date = today;
  } else if (typeof i.date === "string" && ISO_DATE_PATTERN.test(i.date)) {
    date = i.date;
  } else {
    return { ok: false, error: { error: "date must be a YYYY-MM-DD string or omitted" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // No future-dating.
  if (date > today) {
    return { ok: false, error: { error: `date ${date} is in the future (today is ${today})` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Optional notes — accept string or null/undefined.
  let notes: string | null = null;
  if (typeof i.notes === "string") {
    notes = i.notes.slice(0, 280);
  } else if (i.notes !== undefined && i.notes !== null) {
    return { ok: false, error: { error: "notes must be a string or null" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const external_id = `chat-mobility-${date}`;

  // Look up first so we can report was_already_done accurately.
  const { data: existing, error: selErr } = await opts.supabase
    .from("workouts")
    .select("id")
    .eq("user_id", opts.userId)
    .eq("external_id", external_id)
    .maybeSingle();
  if (selErr) {
    return { ok: false, error: { error: `select_failed: ${selErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const was_already_done = existing !== null;

  // Insert only when the row doesn't already exist. We deliberately avoid
  // .upsert({ onConflict: "user_id,external_id" }) here: the matching index
  // workouts_user_external_id_idx is *partial* (WHERE external_id IS NOT NULL),
  // and supabase-js cannot emit the required WHERE predicate on the ON
  // CONFLICT target, so Postgres rejects it with "no unique or exclusion
  // constraint matching the ON CONFLICT specification". Re-marking the same
  // day is a true no-op (none of the row's fields are user-editable through
  // this tool), so a conditional insert correctly expresses the semantics
  // and mirrors the delete-then-insert pattern used by the Strong ingest
  // route for this same table.
  if (!was_already_done) {
    const { error: insErr } = await opts.supabase
      .from("workouts")
      .insert({
        user_id: opts.userId,
        date,
        type: "Mobility",
        notes,
        source: "chat",
        external_id,
      });
    if (insErr) {
      return { ok: false, error: { error: `insert_failed: ${insErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }

  return {
    ok: true,
    data: { ok: true, date, was_already_done },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeUnmarkMobilityDone(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; removed: boolean }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  const today = todayInUserTz();
  let date: string;
  if (i.date === undefined || i.date === null) {
    date = today;
  } else if (typeof i.date === "string" && ISO_DATE_PATTERN.test(i.date)) {
    date = i.date;
  } else {
    return { ok: false, error: { error: "date must be a YYYY-MM-DD string or omitted" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const external_id = `chat-mobility-${date}`;

  // Delete ONLY when source='chat'. Strong CSV imports are never touched.
  const { data: deleted, error: delErr } = await opts.supabase
    .from("workouts")
    .delete()
    .eq("user_id", opts.userId)
    .eq("external_id", external_id)
    .eq("source", "chat")
    .select("id");
  if (delErr) {
    return { ok: false, error: { error: `delete_failed: ${delErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { ok: true, removed: (deleted?.length ?? 0) > 0 },
    meta: { ms: Date.now() - t0, result_rows: deleted?.length ?? 0, range_days: 0, truncated: false },
  };
}

// ── Weekly review action tools (schemas only) ────────────────────────────────
//
// These tools describe actions the user can take on a weekly_reviews row.
// Execution happens via dedicated HTTP routes under
// /api/coach/weekly-review/[id]/* — these schemas exist so the chat coach can
// reference the actions when discussing a review (e.g. "tap Commit ✓ to lock
// in next week's plan") without invoking the action itself. No executors are
// wired in chat-stream.ts; the chips on /coach/weeks/<weekStart> hit the
// routes directly.

export const COMMIT_WEEKLY_PLAN_TOOL = {
  name: "commit_weekly_plan",
  description:
    "Commit the weekly review's prescription into training_weeks for next Monday. Requires an HMAC approval token from /api/coach/approval-token. UI-driven: the Commit ✓ chip on /coach/weeks/<weekStart> handles the issuer + commit handshake.",
  input_schema: {
    type: "object" as const,
    required: ["review_id", "approval_token"],
    properties: {
      review_id:      { type: "string" },
      approval_token: { type: "string" },
    },
  },
};

export const REGENERATE_WEEKLY_REVIEW_TOOL = {
  name: "regenerate_weekly_review",
  description:
    "Regenerate a weekly review (creates version N+1; supersedes the prior draft). No approval needed because nothing escapes the weekly_reviews table.",
  input_schema: {
    type: "object" as const,
    required: ["review_id"],
    properties: {
      review_id: { type: "string" },
    },
  },
};

export const PROPOSE_NUTRITION_ADJUSTMENT_TOOL = {
  name: "propose_nutrition_adjustment",
  description:
    "Apply a ±kcal delta to a draft weekly review's nutrition target. Protein floor and fat target are preserved; carbs absorb the delta. Triggers a §6 narrative re-render.",
  input_schema: {
    type: "object" as const,
    required: ["review_id", "kcal_delta"],
    properties: {
      review_id:  { type: "string" },
      kcal_delta: { type: "number", minimum: -500, maximum: 500 },
    },
  },
};
