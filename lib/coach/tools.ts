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
