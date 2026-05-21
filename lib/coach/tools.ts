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
import type { IntakePayload, PlanPayload, Speaker, TrainingBlock, TrainingWeek } from "@/lib/data/types";
import {
  type MealSlot,
  type FoodItem,
  type FoodMacros,
  macrosForQty,
  sumMacros,
} from "@/lib/food/types";
import { reaggregateDay, sumFoodEntriesForDate } from "@/lib/food/aggregate";
import { utcDate } from "@/lib/food/date";
import { foodLogOwnsDailyLogs } from "@/lib/food/ownership";
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
import {
  EXERCISE_LIBRARY,
  findSubstitutes,
  resolveExercise,
  type LibraryExercise,
  type Equipment,
  type JointStress,
  type StabilityTier,
  type ROMBias,
} from "@/lib/coach/exercise-library";

// ── Allowlist (cross-checked against lib/data/types.ts:DailyLog + schema.sql) ─
export const ALLOWED_COLUMNS = [
  "hrv", "resting_hr", "recovery",
  "sleep_hours", "sleep_score", "deep_sleep_hours", "rem_sleep_hours",
  "spo2", "skin_temp_c", "respiratory_rate", "strain",
  "steps", "calories", "active_calories", "distance_km", "exercise_min",
  "weight_kg", "body_fat_pct",
  "fat_mass_kg", "fat_free_mass_kg", "muscle_mass_kg", "bone_mass_kg", "hydration_kg",
  "protein_g", "carbs_g", "fat_g", "fiber_g", "calories_eaten",
  "notes",
] as const;
export type AllowedColumn = (typeof ALLOWED_COLUMNS)[number];

// ── Per-specialist column clusters for query_daily_logs ──────────────────
// Each specialist sees only the columns relevant to their domain. Peter sees
// all columns (the full ALLOWED_COLUMNS). The orchestrator passes the right
// cluster to executeQueryDailyLogs based on the active speaker.

export const PETER_COLS = ALLOWED_COLUMNS;

export const CARTER_COLS = [
  "recovery", "strain",
  "sleep_hours", "sleep_score",
] as const satisfies readonly AllowedColumn[];

export const NORA_COLS = [
  "calories_eaten", "protein_g", "carbs_g", "fat_g", "fiber_g",
  "weight_kg", "body_fat_pct", "fat_free_mass_kg",
] as const satisfies readonly AllowedColumn[];

export const REMI_COLS = [
  "hrv", "resting_hr", "recovery",
  "sleep_hours", "sleep_score", "deep_sleep_hours", "rem_sleep_hours",
  "spo2", "skin_temp_c", "respiratory_rate",
  "strain",
] as const satisfies readonly AllowedColumn[];

export function colsForSpeaker(speaker: Speaker): readonly AllowedColumn[] {
  switch (speaker) {
    case "peter":  return PETER_COLS;
    case "carter": return CARTER_COLS;
    case "nora":   return NORA_COLS;
    case "remi":   return REMI_COLS;
  }
}

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

export const FOOD_LOG_TOOL = {
  name: "query_food_log",
  description:
    "Query the in-app food log for a date range. Returns committed entries with per-item macros (name, qty_g, kcal, protein/carbs/fat/fiber, source) and meal_slot. Use for food-choice and meal-composition questions — distinct from query_daily_logs which returns day-level macro totals only. Range capped at 90 days. Optional item_filter is a case-insensitive substring match on item name. Optional meal_slot filter narrows results to a single slot — useful for questions like 'how much protein at breakfast last week?'.",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date: { type: "string", format: "date" },
      item_filter: { type: "string", description: "Case-insensitive substring match on item name." },
      meal_slot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
    },
  },
};

/** Read-only browse of the strength exercise library. Used by Carter (and
 *  Peter for cross-domain framing) to answer "what alternatives exist for X?"
 *  or "show me low-stress chest exercises". Does not modify the plan; swap
 *  proposals still go through propose_week_plan / commit_week_plan. */
export const QUERY_EXERCISE_LIBRARY_TOOL = {
  name: "query_exercise_library",
  description:
    "Browse the strength exercise library. Returns up to 20 exercises matching the filters. Use when the athlete asks about alternatives, equipment substitutions, or wants to know what fits a pattern. All filters optional — calling with no filters returns the first 20 library entries. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        enum: ["push", "pull", "squat", "hinge", "single-leg", "core", "accessory"],
      },
      primary_muscle: {
        type: "string",
        enum: ["Chest", "Lats", "Traps", "RearDelts", "Quads", "Hams", "Glutes", "Biceps", "Triceps", "Calves"],
      },
      equipment: {
        type: "array",
        items: {
          type: "string",
          enum: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "smith"],
        },
        description: "Match exercises that use ANY of the listed equipment.",
      },
      role: { type: "string", enum: ["main", "accessory"] },
      exclude_joint: {
        type: "string",
        enum: ["shoulder", "lumbar", "knee", "elbow", "wrist", "hip"],
        description: "Exclude exercises that load this joint.",
      },
    },
  },
};

/** Read-only ranked-substitutes lookup. Carter uses this when the athlete
 *  needs a swap candidate — for pain, equipment unavailability, or planned
 *  rotation. Hard filters: same pattern + same primary muscle as target.
 *  Soft score: role match, stability/ROM preference, equipment overlap. */
export const GET_SUBSTITUTES_TOOL = {
  name: "get_substitutes",
  description:
    "Get ranked substitute exercises for a target. Substitutes share the target's movement pattern and primary muscle. Use when the athlete needs a swap for pain (set exclude_joint), equipment (set prefer_stability), or rotation. Returns 1-8 substitutes (default 3). Read-only — does not commit a swap; actual plan changes still go through propose_week_plan / commit_week_plan.",
  input_schema: {
    type: "object" as const,
    required: ["exercise_id_or_name"],
    properties: {
      exercise_id_or_name: {
        type: "string",
        description: "Library id (e.g., 'decline_bench') or display name (e.g., 'Decline Bench Press (Barbell)'). Case-insensitive.",
      },
      count: { type: "integer", default: 3, minimum: 1, maximum: 8 },
      exclude_joint: {
        type: "string",
        enum: ["shoulder", "lumbar", "knee", "elbow", "wrist", "hip"],
      },
      prefer_stability: { type: "string", enum: ["high", "medium", "low"] },
      prefer_rom_bias: {
        type: "string",
        enum: ["lengthened", "midrange", "shortened", "neutral"],
      },
    },
  },
};

/** Unified tool for reading the athlete's training plan structure — both
 *  block-level mesocycles and the committed weekly plans within them. Picks
 *  one of two scopes:
 *    - "blocks": Returns training_blocks rows. status?: 'active'|'completed'|
 *      'abandoned'|'all' (default 'active').
 *    - "weeks": Returns committed training_weeks rows for a date range
 *      (start_date + end_date required, 90-day cap).
 *  Consolidates what used to be two separate tools (query_training_blocks,
 *  query_training_weeks) — fewer surface tools = better model dispatch. */
export const TRAINING_PLAN_TOOL = {
  name: "query_training_plan",
  description:
    "Fetch training plan structure. scope='blocks' returns training_blocks (status defaults to 'active'). scope='weeks' returns committed training_weeks rows in a date range (start_date + end_date required, 90-day cap). Use 'blocks' when planning a new block or recapping at mesocycle level; use 'weeks' when comparing recent committed plans.",
  input_schema: {
    type: "object" as const,
    required: ["scope"],
    properties: {
      scope: { type: "string", enum: ["blocks", "weeks"] },
      status: {
        type: "string",
        enum: ["active", "completed", "abandoned", "all"],
        description: "Only used when scope='blocks'. Defaults to 'active'.",
      },
      start_date: {
        type: "string",
        format: "date",
        description: "Required when scope='weeks'.",
      },
      end_date: {
        type: "string",
        format: "date",
        description: "Required when scope='weeks'.",
      },
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
  allowedColumns?: readonly AllowedColumn[];
}): Promise<ToolResult<DailyLogsRawData | DailyLogsAggData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // When allowedColumns is provided, intersect requested columns with the
  // specialist's cluster. Any requested column outside the cluster becomes
  // a structured error the model can read. If no columns were requested,
  // default to the specialist's full cluster (not the full ALLOWED_COLUMNS).
  if (opts.allowedColumns) {
    const allowed = new Set<string>(opts.allowedColumns);
    if (Array.isArray(i.columns) && i.columns.every((c) => typeof c === "string")) {
      const denied = (i.columns as string[]).filter((c) => !allowed.has(c));
      if (denied.length > 0) {
        return {
          ok: false,
          error: {
            error: "columns_not_in_specialty",
            hint: `These columns are outside this specialist's lane: ${denied.join(", ")}. Defer to Peter for cross-domain context.`,
          },
          meta: { ms: Date.now() - t0, range_days: 0 },
        };
      }
    } else if (i.columns === undefined) {
      // No columns specified → default to the specialist's full cluster.
      i.columns = [...opts.allowedColumns];
    }
  }

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

// ── query_food_log executor ──────────────────────────────────────────────────

type FoodLogItem = {
  name: string;
  qty_g: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  source?: string;
};
type FoodLogEntryRow = {
  eaten_at: string;
  meal_slot: MealSlot;
  kind: string;
  items: FoodLogItem[];
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
};
type FoodLogToolData = { rows: FoodLogEntryRow[] };

export async function executeQueryFoodLog(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<FoodLogToolData>> {
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

  // --- Range cap (security invariant 5) ---
  if (range_days > 90) {
    return {
      ok: false,
      error: {
        error: `query_food_log max 90 days; got ${range_days}`,
        hint: "narrow start_date",
      },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  // item_filter is free-form (no enum), but must be a string when present.
  const filterRaw = i.item_filter;
  if (filterRaw !== undefined && typeof filterRaw !== "string") {
    return {
      ok: false,
      error: { error: "item_filter must be a string or omitted" },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const itemFilter = (filterRaw as string | undefined)?.toLowerCase() ?? null;

  // Validate meal_slot if present (before issuing the query).
  const mealSlot = i.meal_slot as string | undefined;
  if (mealSlot !== undefined && !["breakfast", "lunch", "dinner", "snack"].includes(mealSlot)) {
    return {
      ok: false,
      error: { error: `invalid meal_slot: ${mealSlot}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  // --- Query (security invariant 2: .eq("user_id", userId)) ---
  let queryBuilder = opts.supabase
    .from("food_log_entries")
    .select("eaten_at, meal_slot, kind, items, totals")
    .eq("user_id", opts.userId)
    .eq("status", "committed")
    .gte("eaten_at", `${start}T00:00:00Z`)
    .lte("eaten_at", `${end}T23:59:59Z`)
    .order("eaten_at", { ascending: false });

  if (mealSlot) {
    queryBuilder = queryBuilder.eq("meal_slot", mealSlot);
  }

  const { data, error } = await queryBuilder;
  if (error) {
    return {
      ok: false,
      error: { error: `db_error: ${error.message}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  let rows = (data ?? []) as FoodLogEntryRow[];
  if (itemFilter) {
    rows = rows
      .map((r) => ({ ...r, items: r.items.filter((it) => it.name.toLowerCase().includes(itemFilter)) }))
      .filter((r) => r.items.length > 0);
  }

  return {
    ok: true,
    data: { rows },
    meta: { ms: Date.now() - t0, result_rows: rows.length, range_days, truncated: false },
  };
}

// ── query_exercise_library executor ──────────────────────────────────────────

type ExerciseLibraryToolData = { exercises: LibraryExercise[] };

const VALID_PATTERNS = new Set(["push", "pull", "squat", "hinge", "single-leg", "core", "accessory"]);
const VALID_MUSCLES = new Set(["Chest", "Lats", "Traps", "RearDelts", "Quads", "Hams", "Glutes", "Biceps", "Triceps", "Calves"]);
const VALID_EQUIPMENT = new Set(["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "smith"]);
const VALID_JOINTS = new Set(["shoulder", "lumbar", "knee", "elbow", "wrist", "hip"]);
const VALID_ROLES = new Set(["main", "accessory"]);

const LIBRARY_RESULT_CAP = 20;

export async function executeQueryExerciseLibrary(opts: {
  supabase: SupabaseClient;  // unused; kept for dispatcher uniformity
  userId: string;            // unused; library is global
  input: unknown;
}): Promise<ToolResult<ExerciseLibraryToolData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Validate optional filters.
  const pattern = i.pattern;
  if (pattern !== undefined && (typeof pattern !== "string" || !VALID_PATTERNS.has(pattern))) {
    return {
      ok: false,
      error: { error: `invalid pattern: ${String(pattern)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const primaryMuscle = i.primary_muscle;
  if (primaryMuscle !== undefined && (typeof primaryMuscle !== "string" || !VALID_MUSCLES.has(primaryMuscle))) {
    return {
      ok: false,
      error: { error: `invalid primary_muscle: ${String(primaryMuscle)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const equipmentRaw = i.equipment;
  let equipmentFilter: Equipment[] | null = null;
  if (equipmentRaw !== undefined) {
    if (!Array.isArray(equipmentRaw) || equipmentRaw.some((e) => typeof e !== "string" || !VALID_EQUIPMENT.has(e))) {
      return {
        ok: false,
        error: { error: "equipment must be an array of valid equipment strings" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    equipmentFilter = equipmentRaw as Equipment[];
  }
  const role = i.role;
  if (role !== undefined && (typeof role !== "string" || !VALID_ROLES.has(role))) {
    return {
      ok: false,
      error: { error: `invalid role: ${String(role)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const excludeJoint = i.exclude_joint;
  if (excludeJoint !== undefined && (typeof excludeJoint !== "string" || !VALID_JOINTS.has(excludeJoint))) {
    return {
      ok: false,
      error: { error: `invalid exclude_joint: ${String(excludeJoint)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Filter in memory.
  let results: LibraryExercise[] = EXERCISE_LIBRARY.slice();
  if (pattern) results = results.filter((ex) => ex.pattern === pattern);
  if (primaryMuscle) results = results.filter((ex) => ex.primaryMuscle === primaryMuscle);
  if (equipmentFilter) {
    results = results.filter((ex) => ex.equipment.some((e) => equipmentFilter!.includes(e)));
  }
  if (role) results = results.filter((ex) => ex.role === role);
  if (excludeJoint) {
    results = results.filter((ex) => !ex.jointStress.includes(excludeJoint as JointStress));
  }

  const truncated = results.length > LIBRARY_RESULT_CAP;
  const capped = results.slice(0, LIBRARY_RESULT_CAP);

  return {
    ok: true,
    data: { exercises: capped },
    meta: {
      ms: Date.now() - t0,
      result_rows: capped.length,
      range_days: 0,
      truncated,
    },
  };
}

// ── get_substitutes executor ─────────────────────────────────────────────────

type SubstitutesToolData = {
  target: LibraryExercise;
  substitutes: LibraryExercise[];
};

const VALID_STABILITY = new Set(["high", "medium", "low"]);
const VALID_ROM_BIAS = new Set(["lengthened", "midrange", "shortened", "neutral"]);

export async function executeGetSubstitutes(opts: {
  supabase: SupabaseClient;  // unused
  userId: string;            // unused
  input: unknown;
}): Promise<ToolResult<SubstitutesToolData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Required: exercise_id_or_name.
  const idOrName = i.exercise_id_or_name;
  if (typeof idOrName !== "string" || idOrName.trim() === "") {
    return {
      ok: false,
      error: { error: "exercise_id_or_name is required (library id or display name)" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const target = resolveExercise(idOrName);
  if (!target) {
    return {
      ok: false,
      error: {
        error: `Exercise not found: ${idOrName}. Try query_exercise_library to browse.`,
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Optional: count.
  let count = 3;
  if (i.count !== undefined) {
    if (typeof i.count !== "number" || !Number.isInteger(i.count) || i.count < 1 || i.count > 8) {
      return {
        ok: false,
        error: { error: "count must be an integer between 1 and 8" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    count = i.count;
  }

  // Optional: exclude_joint.
  let excludeJoint: JointStress | undefined;
  if (i.exclude_joint !== undefined) {
    if (typeof i.exclude_joint !== "string" || !VALID_JOINTS.has(i.exclude_joint)) {
      return {
        ok: false,
        error: { error: `invalid exclude_joint: ${String(i.exclude_joint)}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    excludeJoint = i.exclude_joint as JointStress;
  }

  // Optional: prefer_stability.
  let preferStability: StabilityTier | undefined;
  if (i.prefer_stability !== undefined) {
    if (typeof i.prefer_stability !== "string" || !VALID_STABILITY.has(i.prefer_stability)) {
      return {
        ok: false,
        error: { error: `invalid prefer_stability: ${String(i.prefer_stability)}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    preferStability = i.prefer_stability as StabilityTier;
  }

  // Optional: prefer_rom_bias.
  let preferRomBias: ROMBias | undefined;
  if (i.prefer_rom_bias !== undefined) {
    if (typeof i.prefer_rom_bias !== "string" || !VALID_ROM_BIAS.has(i.prefer_rom_bias)) {
      return {
        ok: false,
        error: { error: `invalid prefer_rom_bias: ${String(i.prefer_rom_bias)}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    preferRomBias = i.prefer_rom_bias as ROMBias;
  }

  const substitutes = findSubstitutes(target, EXERCISE_LIBRARY, {
    count,
    excludeJoint,
    preferStability,
    preferRomBias,
  });

  return {
    ok: true,
    data: { target, substitutes },
    meta: {
      ms: Date.now() - t0,
      result_rows: substitutes.length,
      range_days: 0,
      truncated: false,
    },
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

// ── query_training_plan executor (scope dispatcher) ──────────────────────────

export async function executeQueryTrainingPlan(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<Record<string, unknown>[]>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const scope = i.scope;
  if (scope === "blocks") {
    return executeQueryTrainingBlocks({
      supabase: opts.supabase,
      userId: opts.userId,
      input: { status: i.status },
    });
  }
  if (scope === "weeks") {
    return executeQueryTrainingWeeks({
      supabase: opts.supabase,
      userId: opts.userId,
      input: { start_date: i.start_date, end_date: i.end_date },
    });
  }
  return {
    ok: false,
    error: { error: "scope must be 'blocks' or 'weeks'", code: "bad_scope" },
    meta: { ms: Date.now() - t0, range_days: 0 },
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

export const PROPOSE_NUTRITION_TARGETS_TOOL = {
  name: "propose_nutrition_targets",
  description:
    "Propose daily nutrition targets (kcal + macro split + meal split) for the user. Compute kcal from BMR (Mifflin-St Jeor) × activity multiplier × goal-phase adjustment using the athlete profile's age/sex/weight/height/training_days_per_week/goal_phase. Macro split typically 30–35% protein, 30–45% carbs, 25–35% fat depending on goal. Meal split defaults to 30/35/30/5 (B/L/D/S). Returns a structured proposal + HMAC token; the user must approve via commit_nutrition_targets to apply.",
  input_schema: {
    type: "object" as const,
    required: ["kcal", "protein_pct", "carbs_pct", "fat_pct", "rationale"],
    properties: {
      kcal:          { type: "number", minimum: 800, maximum: 6000 },
      protein_pct:   { type: "number", minimum: 0, maximum: 1 },
      carbs_pct:     { type: "number", minimum: 0, maximum: 1 },
      fat_pct:       { type: "number", minimum: 0, maximum: 1 },
      breakfast_pct: { type: "number", minimum: 0, maximum: 1 },
      lunch_pct:     { type: "number", minimum: 0, maximum: 1 },
      dinner_pct:    { type: "number", minimum: 0, maximum: 1 },
      snacks_pct:    { type: "number", minimum: 0, maximum: 1 },
      rationale:     { type: "string", description: "Plain-language reasoning shown to user on the approval chip." },
    },
  },
};

export const COMMIT_NUTRITION_TARGETS_TOOL = {
  name: "commit_nutrition_targets",
  description:
    "Commit a previously proposed set of nutrition targets to the user's profile.nutrition_overrides. Requires the approval_token from propose_nutrition_targets.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string" },
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

// ── propose_nutrition_targets executor ────────────────────────────────────────

type NutritionTargetsPayload = {
  kcal: number;
  macro_ratios: { protein_pct: number; carbs_pct: number; fat_pct: number };
  meal_ratios:  { breakfast: number; lunch: number; dinner: number; snacks: number };
  rationale: string;
};

export async function executeProposeNutritionTargets(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: NutritionTargetsPayload; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  const kcal = i.kcal as number;
  const protein_pct = i.protein_pct as number;
  const carbs_pct   = i.carbs_pct   as number;
  const fat_pct     = i.fat_pct     as number;
  const breakfast = (i.breakfast_pct as number | undefined) ?? 0.30;
  const lunch     = (i.lunch_pct     as number | undefined) ?? 0.35;
  const dinner    = (i.dinner_pct    as number | undefined) ?? 0.30;
  const snacks    = (i.snacks_pct    as number | undefined) ?? 0.05;
  const rationale = typeof i.rationale === "string" ? i.rationale : "";

  if (!Number.isFinite(kcal) || kcal < 800 || kcal > 6000) {
    return { ok: false, error: { error: `kcal must be 800–6000, got ${kcal}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const macroSum = protein_pct + carbs_pct + fat_pct;
  if (!Number.isFinite(macroSum) || Math.abs(macroSum - 1) >= 0.01) {
    return { ok: false, error: { error: `macro ratios must sum to 1.0, got ${macroSum}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const mealSum = breakfast + lunch + dinner + snacks;
  if (!Number.isFinite(mealSum) || Math.abs(mealSum - 1) >= 0.01) {
    return { ok: false, error: { error: `meal ratios must sum to 1.0, got ${mealSum}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (rationale.length === 0) {
    return { ok: false, error: { error: "rationale required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const payload: NutritionTargetsPayload = {
    kcal,
    macro_ratios: { protein_pct, carbs_pct, fat_pct },
    meal_ratios:  { breakfast, lunch, dinner, snacks },
    rationale,
  };

  const token = signApprovalToken({ userId: opts.userId, action: "nutrition_targets", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

// ── commit_nutrition_targets executor ────────────────────────────────────────

export async function executeCommitNutritionTargets(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ applied: Omit<NutritionTargetsPayload, "rationale"> }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;
  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "nutrition_targets" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the nutrition targets. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as NutritionTargetsPayload;

  // Merge into existing overrides — preserves any field the user/coach set
  // through a different path.
  const { data: existing } = await opts.supabase
    .from("profiles")
    .select("nutrition_overrides")
    .eq("user_id", opts.userId)
    .maybeSingle();
  const current = (existing?.nutrition_overrides ?? {}) as Record<string, unknown>;
  const next = {
    ...current,
    kcal: p.kcal,
    macro_ratios: p.macro_ratios,
    meal_ratios: p.meal_ratios,
  };

  const { error } = await opts.supabase
    .from("profiles")
    .update({ nutrition_overrides: next })
    .eq("user_id", opts.userId);
  if (error) {
    return { ok: false, error: { error: "Couldn't save nutrition targets. Please try again.", code: error.code ?? "update_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return {
    ok: true,
    data: { applied: { kcal: p.kcal, macro_ratios: p.macro_ratios, meal_ratios: p.meal_ratios } },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
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
// meal-log mode tools — search_library, pick_library_item, save_to_library.
// Nora-only, exercised when mode='meal_log' inside MealLoggerSheet's CHAT tab.
// All three operate on the user_food_items table and (for pick_library_item)
// patch a draft food_log_entries row in place.
// ────────────────────────────────────────────────────────────────────────────

export const SEARCH_LIBRARY_TOOL: ToolSchema = {
  name: "search_library",
  description:
    "Fuzzy-search the user's personal food library (user_food_items). Returns up to 5 names + ids. Use to find candidates before calling pick_library_item.",
  input_schema: {
    type: "object" as const,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Food name to look up." },
      limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
    },
  },
};

export const PICK_LIBRARY_ITEM_TOOL: ToolSchema = {
  name: "pick_library_item",
  description:
    "Replace one resolved item in a draft food_log_entries row with a specific user_food_items entry. Server scales macros to the existing qty_g.",
  input_schema: {
    type: "object" as const,
    required: ["entry_id", "item_index", "library_item_id"],
    properties: {
      entry_id: { type: "string", description: "food_log_entries.id (must be status='draft')." },
      item_index: { type: "integer", minimum: 0, description: "Index into entry.items[] to replace." },
      library_item_id: { type: "string", description: "user_food_items.id to use." },
    },
  },
};

export const SAVE_TO_LIBRARY_TOOL: ToolSchema = {
  name: "save_to_library",
  description:
    "Persist a food into the user's personal library. Two kinds: 'item' (single food, per_100g macros) or 'recipe' (composite of items + default serving). Item source is 'user_label' when macros come from a product label, 'user_manual' otherwise.",
  input_schema: {
    type: "object" as const,
    required: ["kind", "name", "source"],
    properties: {
      kind: { type: "string", enum: ["item", "recipe"] },
      name: { type: "string" },
      source: { type: "string", enum: ["user_manual", "user_label", "user_recipe"] },
      per_100g: {
        type: "object",
        properties: {
          kcal: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
        },
      },
      composite_of: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "qty_g"],
          properties: {
            name: { type: "string" },
            qty_g: { type: "number" },
          },
        },
      },
      default_serving_g: { type: "number" },
      notes: { type: "string" },
    },
  },
};

export async function executeSearchLibrary(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ items: Array<{ id: string; name: string }> }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const query = typeof i.query === "string" ? i.query.trim() : "";
  const limit = typeof i.limit === "number" ? Math.min(10, Math.max(1, i.limit)) : 5;
  if (query.length < 2) {
    return {
      ok: false,
      error: { error: "query must be at least 2 chars" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const { data, error } = await opts.supabase
    .from("user_food_items")
    .select("id, name")
    .eq("user_id", opts.userId)
    .ilike("name", `%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    return {
      ok: false,
      error: { error: error.message },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const items = (data ?? []) as Array<{ id: string; name: string }>;
  return {
    ok: true,
    data: { items },
    meta: { ms: Date.now() - t0, result_rows: items.length, range_days: 0, truncated: false },
  };
}

export async function executePickLibraryItem(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ entry_id: string; updated_items_count: number }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const entry_id = typeof i.entry_id === "string" ? i.entry_id : "";
  const item_index = typeof i.item_index === "number" ? i.item_index : -1;
  const library_item_id = typeof i.library_item_id === "string" ? i.library_item_id : "";

  if (!entry_id || item_index < 0 || !library_item_id) {
    return {
      ok: false,
      error: { error: "entry_id, item_index, library_item_id all required" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const { data: lib, error: libErr } = await opts.supabase
    .from("user_food_items")
    .select("id, name, per_100g")
    .eq("id", library_item_id)
    .eq("user_id", opts.userId)
    .single();
  if (libErr || !lib) {
    return {
      ok: false,
      error: { error: "library_item_not_found" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const libRow = lib as { id: string; name: string; per_100g: Record<string, number> | null };
  if (!libRow.per_100g) {
    return {
      ok: false,
      error: { error: "library_item_is_recipe_not_item" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const { data: entry, error: entryErr } = await opts.supabase
    .from("food_log_entries")
    .select("id, status, items")
    .eq("id", entry_id)
    .eq("user_id", opts.userId)
    .single();
  if (entryErr || !entry) {
    return {
      ok: false,
      error: { error: "entry_not_found" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const entryRow = entry as { id: string; status: string; items: Array<Record<string, unknown>> };
  if (entryRow.status !== "draft") {
    return {
      ok: false,
      error: { error: "entry_not_draft" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (item_index >= entryRow.items.length) {
    return {
      ok: false,
      error: { error: "item_index_out_of_range" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const oldItem = entryRow.items[item_index] as { qty_g: number };
  const qty_g = oldItem.qty_g;
  const k = qty_g / 100;
  const scaled = {
    kcal: libRow.per_100g.kcal * k,
    protein_g: libRow.per_100g.protein_g * k,
    carbs_g: libRow.per_100g.carbs_g * k,
    fat_g: libRow.per_100g.fat_g * k,
    fiber_g: libRow.per_100g.fiber_g * k,
  };
  const newItem = {
    name: libRow.name,
    qty_g,
    ...scaled,
    per_100g: libRow.per_100g,
    source: "db" as const,
    db_ref: { source: "user_library" as const, canonical_id: libRow.id },
    confidence: "high" as const,
    match_score: 1.0,
  };
  const newItems = [...entryRow.items];
  newItems[item_index] = newItem;

  type Totals = { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  const totals = newItems.reduce<Totals>(
    (acc, it) => {
      const x = it as Record<string, number>;
      acc.kcal      += x.kcal      ?? 0;
      acc.protein_g += x.protein_g ?? 0;
      acc.carbs_g   += x.carbs_g   ?? 0;
      acc.fat_g     += x.fat_g     ?? 0;
      acc.fiber_g   += x.fiber_g   ?? 0;
      return acc;
    },
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  );
  const is_estimated = newItems.some((it) => (it as { source?: string }).source === "llm");

  const { error: updErr } = await opts.supabase
    .from("food_log_entries")
    .update({ items: newItems, totals, is_estimated })
    .eq("id", entry_id)
    .eq("user_id", opts.userId);
  if (updErr) {
    return {
      ok: false,
      error: { error: updErr.message },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  return {
    ok: true,
    data: { entry_id, updated_items_count: 1 },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeSaveToLibrary(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ id: string; name: string; kind: "item" | "recipe"; was_duplicate: boolean }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const kind = i.kind === "item" || i.kind === "recipe" ? i.kind : null;
  const name = typeof i.name === "string" ? i.name.trim() : "";
  const source = typeof i.source === "string" ? i.source : "";
  if (!kind || !name || !source) {
    return {
      ok: false,
      error: { error: "kind, name, source required" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Build the insert row based on shape.
  let row: Record<string, unknown>;
  if (kind === "item") {
    const per_100g = i.per_100g as Record<string, unknown> | undefined;
    if (!per_100g) {
      return {
        ok: false,
        error: { error: "per_100g required for kind=item" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    row = {
      user_id: opts.userId,
      name,
      per_100g,
      composite_of: null,
      default_serving_g: null,
      source,
      notes: typeof i.notes === "string" ? i.notes : null,
    };
  } else {
    const composite_of = i.composite_of as unknown[] | undefined;
    const default_serving_g = i.default_serving_g as number | undefined;
    if (!Array.isArray(composite_of) || composite_of.length === 0) {
      return {
        ok: false,
        error: { error: "composite_of array required for kind=recipe" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    if (!default_serving_g || default_serving_g <= 0) {
      return {
        ok: false,
        error: { error: "default_serving_g > 0 required for kind=recipe" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    row = {
      user_id: opts.userId,
      name,
      per_100g: null,
      composite_of,
      default_serving_g,
      source,
      notes: typeof i.notes === "string" ? i.notes : null,
    };
  }

  const { data, error } = await opts.supabase
    .from("user_food_items")
    .insert(row)
    .select("id")
    .single();
  // 23505 = unique_violation against user_food_items_user_name_unique
  // (migration 0030). Treat as a successful no-op and return the existing
  // row's id, so the model sees "already in library" rather than thinking
  // the save failed and retrying. This is the database-side floor for the
  // re-save loop diagnosed in the 2026-05-21 Nora session.
  if (error?.code === "23505") {
    const { data: existing, error: lookupErr } = await opts.supabase
      .from("user_food_items")
      .select("id")
      .eq("user_id", opts.userId)
      .ilike("name", name)
      .limit(1)
      .maybeSingle();
    if (lookupErr || !existing) {
      return {
        ok: false,
        error: { error: lookupErr?.message ?? "duplicate name but row not found" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    return {
      ok: true,
      data: { id: (existing as { id: string }).id, name, kind, was_duplicate: true },
      meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
    };
  }
  if (error || !data) {
    return {
      ok: false,
      error: { error: error?.message ?? "insert returned no row" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  return {
    ok: true,
    data: { id: (data as { id: string }).id, name, kind, was_duplicate: false },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// log_meal_entry — Nora-only chat write-path for food_log_entries.
//
// Lets Nora finish the full "save items → log to slot" workflow from /coach
// without bouncing the user into MealLoggerSheet. Writes a committed
// food_log_entries row (status='committed' on insert) for the given meal
// slot, then calls reaggregateDay so daily_logs.{calories_eaten, protein_g,
// carbs_g, fat_g, fiber_g} reflect the new total.
//
// Item shape: name + qty_g + per_100g (the macros Nora already has from
// resolving the item via search_library / save_to_library / her own
// estimate). Macros at the logged qty are computed server-side via
// macrosForQty so the totals stay consistent with the rest of the food
// pipeline (single source of truth = macrosForQty + sumMacros).
//
// kind='text' on the row: the input modality WAS text (Nora interpreted a
// user message). raw_input.text carries the original message for trace.
// Source field on each FoodItem: 'llm' when the item didn't carry a
// library_item_id (Nora estimated/recalled the macros) or 'db' with
// db_ref.source='user_library' when a library row was the source — matches
// the convention from migration 0028's resolver chain.
// ────────────────────────────────────────────────────────────────────────────

export const LOG_MEAL_ENTRY_TOOL: ToolSchema = {
  name: "log_meal_entry",
  description:
    "Write a committed food_log_entries row for the given meal slot, then re-aggregate the day's daily_logs nutrition columns. Use AFTER you've resolved each item (via search_library, save_to_library, or you have explicit macros from the user). Don't call this if the user only asked you to save items to the library — saving and logging are separate actions.",
  input_schema: {
    type: "object" as const,
    required: ["items", "meal_slot"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 15,
        items: {
          type: "object",
          required: ["name", "qty_g", "per_100g"],
          properties: {
            name: { type: "string", description: "Display name of the food." },
            qty_g: { type: "number", description: "Quantity in grams." },
            per_100g: {
              type: "object",
              required: ["kcal", "protein_g", "carbs_g", "fat_g"],
              properties: {
                kcal: { type: "number" },
                protein_g: { type: "number" },
                carbs_g: { type: "number" },
                fat_g: { type: "number" },
                fiber_g: { type: "number" },
              },
            },
            library_item_id: {
              type: "string",
              description:
                "Optional user_food_items.id when this item came from the personal library.",
            },
          },
        },
      },
      meal_slot: {
        type: "string",
        enum: ["breakfast", "lunch", "dinner", "snack"],
      },
      eaten_at: {
        type: "string",
        description:
          "Optional ISO-8601 timestamp the meal was eaten at. Defaults to now.",
      },
      raw_text: {
        type: "string",
        description:
          "The original user message that prompted this log, for traceability.",
      },
    },
  },
};

export async function executeLogMealEntry(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<
  ToolResult<{
    entry_id: string;
    meal_slot: MealSlot;
    eaten_at: string;
    item_count: number;
    totals: FoodMacros;
    day_totals: FoodMacros;
    date: string;
  }>
> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const meal_slot = i.meal_slot as MealSlot | undefined;
  if (!meal_slot || !["breakfast", "lunch", "dinner", "snack"].includes(meal_slot)) {
    return {
      ok: false,
      error: { error: "meal_slot must be one of breakfast|lunch|dinner|snack" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const itemsInput = Array.isArray(i.items) ? (i.items as Array<Record<string, unknown>>) : [];
  if (itemsInput.length === 0 || itemsInput.length > 15) {
    return {
      ok: false,
      error: { error: "items must contain 1..15 entries" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const eaten_at_raw = typeof i.eaten_at === "string" ? i.eaten_at : null;
  const eaten_at =
    eaten_at_raw && !Number.isNaN(Date.parse(eaten_at_raw))
      ? new Date(eaten_at_raw).toISOString()
      : new Date().toISOString();
  const raw_text = typeof i.raw_text === "string" ? i.raw_text : "Logged via chat";

  // Build FoodItem rows, validating each input.
  const items: FoodItem[] = [];
  for (const it of itemsInput) {
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const qty_g = typeof it.qty_g === "number" && it.qty_g > 0 ? it.qty_g : NaN;
    const p100 = it.per_100g as Record<string, unknown> | undefined;
    const library_item_id = typeof it.library_item_id === "string" ? it.library_item_id : null;
    if (!name || !Number.isFinite(qty_g) || !p100) {
      return {
        ok: false,
        error: { error: `item missing name/qty_g/per_100g: ${JSON.stringify(it).slice(0, 120)}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    const per_100g: FoodMacros = {
      kcal: Number(p100.kcal) || 0,
      protein_g: Number(p100.protein_g) || 0,
      carbs_g: Number(p100.carbs_g) || 0,
      fat_g: Number(p100.fat_g) || 0,
      fiber_g: Number(p100.fiber_g) || 0,
    };
    const m = macrosForQty(per_100g, qty_g);
    items.push({
      name,
      qty_g,
      kcal: m.kcal,
      protein_g: m.protein_g,
      carbs_g: m.carbs_g,
      fat_g: m.fat_g,
      fiber_g: m.fiber_g,
      per_100g,
      source: library_item_id ? "db" : "llm",
      db_ref: library_item_id
        ? { source: "user_library", canonical_id: library_item_id }
        : null,
      confidence: "high",
      match_score: library_item_id ? 1.0 : null,
    });
  }
  const totals = sumMacros(items);

  const { data: inserted, error } = await opts.supabase
    .from("food_log_entries")
    .insert({
      user_id: opts.userId,
      eaten_at,
      kind: "text",
      meal_slot,
      raw_input: { kind: "text", text: raw_text },
      items,
      totals,
      is_estimated: items.some((it) => it.source === "llm"),
      status: "committed",
    })
    .select("id, eaten_at")
    .single();
  if (error || !inserted) {
    return {
      ok: false,
      error: { error: error?.message ?? "insert returned no row" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const date = utcDate((inserted as { eaten_at: string }).eaten_at);
  const day_totals = foodLogOwnsDailyLogs()
    ? await reaggregateDay(opts.supabase, opts.userId, date)
    : await sumFoodEntriesForDate(opts.supabase, opts.userId, date);

  return {
    ok: true,
    data: {
      entry_id: (inserted as { id: string }).id,
      meal_slot,
      eaten_at,
      item_count: items.length,
      totals,
      day_totals,
      date,
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

// ── Per-speaker tool partitions ──────────────────────────────────────────
// Peter has every tool. Carter/Nora/Remi each get a narrower lane-specific
// subset (column-restricted at execute time via colsForSpeaker(speaker)).
// The legacy handoff_to tool (sub-project #2 "multi-coach team") was removed
// when the coach mini-apps restructure (sub-project #3) moved each specialist
// onto its own page — users now pick a coach by tab, so mid-stream handoff is
// dead UX. See docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md.

// Structural type wide enough to accept every tool literal in this file
// without forcing each tool's input_schema to share the same property set.
// Anthropic's tool schema is `{ name; description; input_schema }` where
// input_schema is an arbitrary JSON Schema object.
export type ToolSchema = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: { readonly type: "object" } & Record<string, unknown>;
};

export const PETER_TOOLS: readonly ToolSchema[] = [
  DAILY_LOGS_TOOL,
  WORKOUTS_TOOL,
  FOOD_LOG_TOOL,
  QUERY_EXERCISE_LIBRARY_TOOL,
  GET_SUBSTITUTES_TOOL,
  TRAINING_PLAN_TOOL,
  AUTOREGULATION_TOOL,
  ADHERENCE_TOOL,
  PROPOSE_BLOCK_TOOL,
  COMMIT_BLOCK_TOOL,
  PROPOSE_WEEK_PLAN_TOOL,
  COMMIT_WEEK_PLAN_TOOL,
  PROPOSE_NUTRITION_TARGETS_TOOL,
  COMMIT_NUTRITION_TARGETS_TOOL,
  APPLY_GOAL_TARGET_TOOL,
  APPLY_BEDTIME_CORRECTION_TOOL,
  APPLY_MACROS_CORRECTION_TOOL,
  APPLY_PROTEIN_CORRECTION_TOOL,
  SET_SANITY_OVERRIDE_TOOL,
  SET_GOAL_NARRATIVE_CHAT_TOOL,
  SET_DIRECTNESS_TOOL,
  SET_CADENCE_TOOL,
  SET_CHRONOTYPE_TOOL,
  SET_UNPROMPTED_ACTIONS_TOOL,
  SET_FREE_FORM_CONSTRAINTS_TOOL,
  PROPOSE_PLAN_TOOL,
  COMMIT_PLAN_TOOL,
  SET_GLP1_STATUS_TOOL,
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
  REGENERATE_MORNING_BRIEF_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
  COMMIT_WEEKLY_PLAN_TOOL,
  REGENERATE_WEEKLY_REVIEW_TOOL,
  PROPOSE_NUTRITION_ADJUSTMENT_TOOL,
];

// Carter: strength/training. Reads workouts + recovery-relevant daily_logs
// columns + training plan; commits within-week plans and marks mobility.
// No food log, no GLP-1, no block-planning (that's Peter's strategic lane).
export const CARTER_TOOLS: readonly ToolSchema[] = [
  WORKOUTS_TOOL,
  QUERY_EXERCISE_LIBRARY_TOOL,
  GET_SUBSTITUTES_TOOL,
  DAILY_LOGS_TOOL,
  TRAINING_PLAN_TOOL,
  AUTOREGULATION_TOOL,
  ADHERENCE_TOOL,
  PROPOSE_WEEK_PLAN_TOOL,
  COMMIT_WEEK_PLAN_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
];

// Nora: nutrition. Reads food log + nutrition/body-comp daily_logs columns;
// manages GLP-1 milestones and nutrition target proposals. No workouts, no
// week-planning.
export const NORA_TOOLS: readonly ToolSchema[] = [
  FOOD_LOG_TOOL,
  DAILY_LOGS_TOOL,
  PROPOSE_NUTRITION_TARGETS_TOOL,
  COMMIT_NUTRITION_TARGETS_TOOL,
  APPLY_MACROS_CORRECTION_TOOL,
  APPLY_PROTEIN_CORRECTION_TOOL,
  SET_GLP1_STATUS_TOOL,
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
  SEARCH_LIBRARY_TOOL,
  PICK_LIBRARY_ITEM_TOOL,
  SAVE_TO_LIBRARY_TOOL,
  LOG_MEAL_ENTRY_TOOL,
];

// Remi: recovery/sleep/illness. Reads recovery-relevant daily_logs columns;
// marks mobility (recovery prescription). No food log, no workouts, no
// planning.
export const REMI_TOOLS: readonly ToolSchema[] = [
  DAILY_LOGS_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
];

export function toolsForSpeaker(speaker: Speaker): readonly ToolSchema[] {
  switch (speaker) {
    case "peter":  return PETER_TOOLS;
    case "carter": return CARTER_TOOLS;
    case "nora":   return NORA_TOOLS;
    case "remi":   return REMI_TOOLS;
  }
}
