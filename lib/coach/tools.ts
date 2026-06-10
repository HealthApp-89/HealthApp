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
import type {
  DietaryExclusions,
  EatingIdentity,
  IntakePayload,
  MealSuggestion,
  PlanPayload,
  SessionPrescriptions,
  Speaker,
  SuggestEngineOutput,
  TrainingBlock,
  TrainingWeek,
} from "@/lib/data/types";
import { composeEatingIdentity } from "@/lib/coach/nora-suggestions/compose-eating-identity";
import { suggestMeal } from "@/lib/coach/nora-suggestions/suggest-meal";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";
import { typedTargetsForAllSlots, DEFAULT_MEAL_RATIOS } from "@/lib/food/meal-targets";
import { validateWeekPrescription } from "@/lib/coach/prescription/validate-week";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { upsertWeekPrescription } from "@/lib/coach/prescription/upsert-week-prescription";
import { computeTargetRecommendation, type TargetRecommendation } from "@/lib/coach/prescription/calibrate-target";
import { generateBlockOutcome, type GenerateBlockOutcomeResult } from "@/lib/coach/block-outcomes";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import {
  type MealSlot,
  type FoodItem,
  type FoodMacros,
  sumMacros,
  macrosForQty,
} from "@/lib/food/types";
import { reaggregateDay, sumFoodEntriesForDate } from "@/lib/food/aggregate";
import { utcDate } from "@/lib/food/date";
import { foodLogOwnsDailyLogs } from "@/lib/food/ownership";
import { resolveItemMacros } from "@/lib/food/lookup";
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
import { todayInUserTz, weekdayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
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
    "Compute planned-vs-actual session adherence and per-muscle volume deltas vs prior-4w-avg for a Mon-Sun window. Use during the RECAP beat of plan_week mode to ground the recap in concrete numbers. Note: muscle_volume_vs_4w_avg OMITS muscle categories with thin baselines (<6 sets or <2 distinct weeks of prior data). If a category is absent from the response, you DO NOT have enough history to claim drift — say so, do not invent a percentage.",
  input_schema: {
    type: "object" as const,
    required: ["week_start"],
    properties: {
      week_start: { type: "string", format: "date", description: "Monday (UTC) of the week to recap." },
    },
  },
};

export const GET_WEEK_PRESCRIPTION_TOOL = {
  name: "get_week_prescription",
  description:
    "Return the deterministic per-exercise prescription (load × reps × sets per weekday) for a training week. Honors the consolidation lock, the focus-block clamp, and the equipment grid — the engine never proposes a load you should override in prose. ALWAYS call this before answering 'what should I lift?' or before proposing a week plan. Quote the result verbatim; do not transform or 'improve' the numbers.",
  input_schema: {
    type: "object" as const,
    properties: {
      week: {
        type: "string",
        enum: ["current", "next"],
        description: "'current' = the in-progress week (Monday on or before today). 'next' = the upcoming Monday. Defaults to 'current'.",
      },
      week_start: {
        type: "string",
        format: "date",
        description: "Explicit Monday (YYYY-MM-DD). When provided, overrides `week`.",
      },
      persist: {
        type: "boolean",
        description: "If true, upsert the computed prescription into training_weeks.session_prescriptions. Defaults to false (read-only). Use when committing a proposed plan; otherwise leave false.",
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
  recipe_id: string | null;     // back-reference to user_food_items (migration 0028)
  recipe_name: string | null;   // flattened from PostgREST join
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
    .select("eaten_at, meal_slot, kind, items, totals, recipe_id, recipe:recipe_id(name)")
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

  type FoodLogEntryRowRaw = Omit<FoodLogEntryRow, "recipe_name"> & {
    // PostgREST many-to-one FK embed returns a single object (or null when the FK is null)
    recipe: { name: string } | null;
  };
  let rows: FoodLogEntryRow[] = ((data ?? []) as unknown as FoodLogEntryRowRaw[]).map((r) => ({
    eaten_at: r.eaten_at,
    meal_slot: r.meal_slot,
    kind: r.kind,
    items: r.items,
    totals: r.totals,
    recipe_id: r.recipe_id,
    recipe_name: r.recipe?.name ?? null,
  }));
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

  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));

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
    asOf = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
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
    "Propose a new 5-week training block. Does NOT write. Returns preview + approval_token. The server validates the target_value against trend-derived sanity bounds (computed from the athlete's last 90d of realized working sets for the primary lift). If the proposed target is outside [current+1, current+coefficient×4×1.5], the call fails with target_out_of_bounds — retry with an explicit override_reason if the athlete consciously wants to go outside that window.",
  input_schema: {
    type: "object" as const,
    required: ["goal_text", "start_date", "end_date"],
    properties: {
      goal_text:    { type: "string", minLength: 4, maxLength: 200 },
      primary_lift: { type: "string", enum: ["squat", "bench", "deadlift", "ohp"] },
      target_metric:{ type: "string", enum: ["e1rm", "working_weight"] },
      target_value: { type: "number", minimum: 1, maximum: 500 },
      target_unit:  { type: "string", maxLength: 16 },
      start_date:   { type: "string", format: "date", description: "Must be a Monday." },
      end_date:     { type: "string", format: "date", description: "Must equal start_date + 34 days." },
      override_reason: {
        type: "string",
        minLength: 4,
        maxLength: 200,
        description: "Required ONLY when target_value falls outside the trend-derived sanity bounds. Explain why you want to go above/below the realistic 4-week range — e.g. 'returning from injury, conservative target' or 'priming meet attempt, intentionally aggressive'.",
      },
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

export const PROPOSE_CLOSE_BLOCK_TOOL = {
  name: "propose_close_block",
  description:
    "Preview closing the athlete's active block before its end_date. Returns the would-be block_outcomes payload + approval_token. Use ONLY when the athlete asks to close early (target hit early, target unreachable, schedule change, injury). The standard end-of-block flow runs via block-outcomes/sweep at end_date automatically and does NOT need this tool.",
  input_schema: {
    type: "object" as const,
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        minLength: 4,
        maxLength: 200,
        description: "Why are we closing early? Athlete-quoted preferred — e.g. 'target hit week 3, recalibrating', 'shoulder pain forcing rotation', 'travel disrupting schedule'.",
      },
    },
  },
};

export const COMMIT_CLOSE_BLOCK_TOOL = {
  name: "commit_close_block",
  description:
    "Commit a previously proposed early block close. Requires approval_token from propose_close_block. Updates training_blocks.status='completed' and writes the block_outcomes row.",
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
    "Generate a preview of next week's training plan. Does NOT write. Returns preview (including server-computed session_prescriptions) + approval_token. You provide the session-type LABELS (Mon=Legs etc.), the RIR target, and the research phase; the server computes per-exercise loads/reps/sets from the deterministic prescription engine. Do NOT pass session_prescriptions yourself — any value you supply is ignored and replaced with the engine output. Quote the preview verbatim in your reply.",
  input_schema: {
    type: "object" as const,
    required: ["week_start", "session_plan"],
    properties: {
      week_start:         { type: "string", format: "date", description: "Must be a Monday." },
      session_plan:       {
        type: "object",
        description: "Mon-Sun map of session-type strings (or 'REST'). Carter's decision: which sessions go on which weekdays.",
        additionalProperties: { type: "string" },
      },
      weekly_focus:       { type: "string", maxLength: 200 },
      intensity_modifier: {
        type: "object",
        description: "Per-primary-lift multipliers, e.g. {squat: 0.95}. Informational only — does not drive per-exercise loads; the prescription engine owns those.",
        additionalProperties: { type: "number" },
      },
      rir_target:         { type: "integer", minimum: 1, maximum: 4 },
      research_phase:     { type: "string", enum: ["accumulate","deload"] },
      rationale:          { type: "string", maxLength: 500, description: "Plain-language reasoning shown to athlete on the approval chip. Should narrate the engine's output, not contain a custom load table." },
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
  override_reason?: string;
};

type ProposeWeekPlanInput = {
  week_start: string;
  session_plan: Record<string, string>;
  session_prescriptions: SessionPrescriptions;
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
}): Promise<ToolResult<{ preview: ProposeBlockInput; approval_token: string; recommendation: TargetRecommendation | null }>> {
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
  // primary_lift enum guard — schema-level enforcement only runs in the
  // Anthropic API; server must re-validate so an unexpected string can't
  // slip through and silently bypass the sanity-bounds check below
  // (PRIMARY_LIFT_NAME_PATTERNS[unknown] = undefined → empty recommendation
  // → zero enforcement).
  if (i.primary_lift != null && !["squat", "bench", "deadlift", "ohp"].includes(i.primary_lift as string)) {
    return { ok: false, error: { error: "primary_lift must be one of: squat, bench, deadlift, ohp" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // ── Target calibration: trend-derived sanity check ──────────────────────
  // Compute the trend-derived recommendation (helper returns all-nulls when
  // the lift has no logged history — bootstrap path for first-ever block).
  // Only enforces bounds when (a) target_value is set AND (b) recommendation
  // returned non-null sanity_bounds (i.e., there's enough data to anchor).
  let recommendation: TargetRecommendation | null = null;
  if (i.primary_lift != null && i.target_value != null) {
    try {
      recommendation = await computeTargetRecommendation({
        supabase: opts.supabase,
        userId: opts.userId,
        lift: i.primary_lift as PrimaryLift,
        todayIso: todayInUserTz(new Date(), await getUserTimezone(opts.userId)),
      });
    } catch (e) {
      // Don't block block creation on a transient data-fetch failure.
      console.warn("[propose_block] computeTargetRecommendation failed", e);
      recommendation = null;
    }
  }

  if (recommendation?.sanity_bounds != null && i.target_value != null) {
    const [lo, hi] = recommendation.sanity_bounds;
    const tv = i.target_value as number;
    const outOfBounds = tv < lo || tv > hi;
    const overrideReason = typeof i.override_reason === "string" && i.override_reason.trim().length >= 4 ? i.override_reason : null;
    if (outOfBounds && overrideReason == null) {
      const direction = tv < lo ? "too low" : "too high";
      const hint = tv < lo
        ? `Target ${tv} kg would be hit too quickly given current ${recommendation.current_e1rm} e1RM. Sanity floor for this lift is ${lo} kg.`
        : `Target ${tv} kg exceeds realistic 4-week progression. Sanity ceiling for this lift is ${hi} kg (current ${recommendation.current_e1rm} e1RM + 1.5× the trend-realistic 4-week gain).`;
      return {
        ok: false,
        error: {
          error: `Proposed target ${tv} kg is ${direction} for a 5-week ${i.primary_lift} block. ${hint} Recommended target: ${recommendation.recommended_target} kg (${recommendation.used}-based). To proceed with ${tv} kg anyway, retry propose_block with an explicit override_reason explaining why.`,
          code: "target_out_of_bounds",
          hint,
        },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    if (outOfBounds && overrideReason != null) {
      console.info("[propose_block] target_out_of_bounds_override", {
        userId: opts.userId,
        lift: i.primary_lift,
        proposed: tv,
        bounds: [lo, hi],
        reason: overrideReason,
      });
    }
  }

  const payload = i as unknown as ProposeBlockInput;
  const token = signApprovalToken({ userId: opts.userId, action: "block", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token, recommendation },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}

type ProposeCloseBlockInput = {
  blockId: string;
  reason: string;
};

// ── propose_close_block executor ──────────────────────────────────────────

export async function executeProposeCloseBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: { blockId: string; primary_lift: PrimaryLift | null; target_value: number | null; reason: string; would_be_outcome: GenerateBlockOutcomeResult["payload"] }; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.reason !== "string" || i.reason.length < 4 || i.reason.length > 200) {
    return { ok: false, error: { error: "reason required (4-200 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Find active block. maybeSingle() so two active blocks (a data-integrity
  // bug) surface as an error rather than silently picking the first; error
  // destructured so a transient Supabase fetch failure doesn't masquerade as
  // "no active block" and mislead Peter's prompt downstream.
  const { data: block, error: blockErr } = await opts.supabase
    .from("training_blocks")
    .select("id, primary_lift, target_value, target_metric, target_unit, start_date, end_date, target_hit_at_week, status")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();
  if (blockErr) {
    return {
      ok: false,
      error: { error: `active_block_fetch_failed: ${blockErr.message}`, code: "fetch_failed" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (!block) {
    return {
      ok: false,
      error: {
        error: "You're not in an active block; nothing to close. Use propose_block / commit_block to start a new one.",
        code: "no_active_block",
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Generate the prospective outcome (preview only — no write).
  let prospectiveOutcome: GenerateBlockOutcomeResult["payload"] | undefined;
  try {
    const { payload } = await generateBlockOutcome({
      supabase: opts.supabase,
      userId: opts.userId,
      blockId: block.id as string,
    });
    prospectiveOutcome = payload;
  } catch (e) {
    return {
      ok: false,
      error: {
        error: `Couldn't compute the block outcome (no qualifying workouts in the block window?). ${String(e)}`,
        code: "outcome_generate_failed",
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const closePayload: ProposeCloseBlockInput = {
    blockId: block.id as string,
    reason: i.reason as string,
  };
  const token = signApprovalToken({
    userId: opts.userId,
    action: "close_block",
    payload: closePayload,
  });

  return {
    ok: true,
    data: {
      preview: {
        blockId: block.id as string,
        primary_lift: (block.primary_lift as PrimaryLift | null) ?? null,
        target_value: (block.target_value as number | null) ?? null,
        reason: i.reason as string,
        would_be_outcome: prospectiveOutcome,
      },
      approval_token: token,
    },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}

// ── commit_close_block executor ───────────────────────────────────────────

export async function executeCommitCloseBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ block_id: string; status: "completed"; outcome_id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;
  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "close_block" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the close-block details. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as ProposeCloseBlockInput;

  // Re-verify the block is still active + owned by this user.
  const { data: blockRow, error: blockErr } = await opts.supabase
    .from("training_blocks")
    .select("id, status")
    .eq("id", p.blockId)
    .eq("user_id", opts.userId)
    .maybeSingle();
  if (blockErr) {
    return { ok: false, error: { error: `active_block_fetch_failed: ${blockErr.message}`, code: "fetch_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!blockRow) {
    // Distinct from propose-side "no_active_block": at commit time the token
    // names a specific block_id; if it isn't there, the block was deleted (or
    // the id was tampered with), not "no active block". UI/audit needs the
    // distinction.
    return { ok: false, error: { error: "Block not found.", code: "block_not_found" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (blockRow.status !== "active") {
    return {
      ok: false,
      error: { error: `Block is already ${blockRow.status}. Nothing to close.`, code: "already_closed" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Re-run outcome generation against fresh data (athlete may have logged a
  // workout between propose and commit; we write what's current, not what's
  // in the token).
  let outcomePayload: GenerateBlockOutcomeResult["payload"];
  try {
    const result = await generateBlockOutcome({
      supabase: opts.supabase,
      userId: opts.userId,
      blockId: p.blockId,
    });
    outcomePayload = result.payload;
  } catch (e) {
    return {
      ok: false,
      error: {
        error: `Couldn't compute the block outcome at commit time. ${String(e)}`,
        code: "outcome_generate_failed",
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Upsert the block_outcomes row. UNIQUE constraint is on (block_id);
  // ON CONFLICT updates the payload but preserves athlete_acknowledged_at
  // (which the next commit_block will stamp when the next block starts).
  const { data: outcomeRow, error: outcomeErr } = await opts.supabase
    .from("block_outcomes")
    .upsert(
      {
        ...outcomePayload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "block_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (outcomeErr || !outcomeRow) {
    return {
      ok: false,
      error: { error: `block_outcomes upsert failed: ${outcomeErr?.message ?? "unknown"}`, code: "outcome_upsert_failed" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Flip the block to completed. Idempotent — the WHERE status='active' guard
  // makes re-runs no-op even if a concurrent close just landed.
  //
  // NOTE: deliberately does NOT write a `chat_messages` row with kind=
  // 'block_outcome' (which the cron at app/api/coach/block-outcomes/sweep
  // does). The chat-initiated close-block flow surfaces the outcome via the
  // commit_close_block confirmation chip (PERSIST_RESULT_TOOLS) and via
  // BLOCK_OUTCOME_CONTEXT in setup_block mode — the durable card is
  // unnecessary on the in-chat path and would duplicate the chip.
  const { error: updateErr } = await opts.supabase
    .from("training_blocks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", p.blockId)
    .eq("user_id", opts.userId)
    .eq("status", "active");
  if (updateErr) {
    return {
      ok: false,
      error: { error: `training_blocks update failed: ${updateErr.message}`, code: "block_update_failed" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  return {
    ok: true,
    data: { block_id: p.blockId, status: "completed", outcome_id: outcomeRow.id as string },
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

  // Stamp any outstanding unacknowledged block_outcomes row so the
  // BlockOutcomeCard stops surfacing and framework_state exits between-blocks
  // mode. Safe no-op when there's no such row (first-ever block, or already
  // acknowledged). Errors here are non-fatal — the block was saved.
  await opts.supabase
    .from("block_outcomes")
    .update({ athlete_acknowledged_at: new Date().toISOString() })
    .eq("user_id", opts.userId)
    .is("athlete_acknowledged_at", null);

  return {
    ok: true,
    data: data as TrainingBlock,
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}

// ── get_week_prescription executor ────────────────────────────────────────────

/** Compute the canonical Monday for a week selector. 'current' = most recent
 *  Monday on or before today; 'next' = the Monday strictly after today (on
 *  Sunday returns tomorrow, on Monday returns one week from today). */
function resolveWeekStart(selector: "current" | "next", todayIso: string): string {
  const t = new Date(todayIso + "T00:00:00Z");
  const day = t.getUTCDay(); // 0=Sun..6=Sat
  if (selector === "current") {
    // Move back to most recent Monday (Sun → -6, Mon → 0, Tue → -1, …)
    const back = day === 0 ? 6 : day - 1;
    t.setUTCDate(t.getUTCDate() - back);
  } else {
    // 'next': forward to upcoming Monday (strictly after today)
    const daysToAdd = day === 1 ? 7 : (8 - day) % 7;
    t.setUTCDate(t.getUTCDate() + (daysToAdd === 0 ? 7 : daysToAdd));
  }
  return t.toISOString().slice(0, 10);
}

export async function executeGetWeekPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{
  week_start: string;
  source: "stored" | "computed_on_the_fly";
  session_prescriptions: SessionPrescriptions;
  block: { id: string; primary_lift: PrimaryLift | null; target_metric: string | null; target_value: number | null; target_hit_at_week: number | null } | null;
}>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Resolve target week.
  const todayIso = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
  let weekStart: string;
  if (typeof i.week_start === "string") {
    if (!isYmd(i.week_start)) {
      return { ok: false, error: { error: "week_start must be YYYY-MM-DD" }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    const d = new Date(i.week_start + "T00:00:00Z");
    if (d.getUTCDay() !== 1) {
      return { ok: false, error: { error: "week_start must be a Monday" }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    weekStart = i.week_start;
  } else {
    const selector: "current" | "next" =
      i.week === "next" ? "next" : "current";
    weekStart = resolveWeekStart(selector, todayIso);
  }

  const persist = i.persist === true;

  // Pull active block for the block context block.
  const { data: blocks } = await opts.supabase
    .from("training_blocks")
    .select("id, primary_lift, target_metric, target_value, target_hit_at_week")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();
  const block = (blocks as { id: string; primary_lift: PrimaryLift | null; target_metric: string | null; target_value: number | null; target_hit_at_week: number | null } | null) ?? null;

  if (persist) {
    try {
      const out = await upsertWeekPrescription({
        supabase: opts.supabase,
        userId: opts.userId,
        weekStart,
        todayIso,
      });
      return {
        ok: true,
        data: {
          week_start: out.week_start,
          source: "stored",
          session_prescriptions: out.session_prescriptions,
          block,
        },
        meta: { ms: Date.now() - t0, result_rows: Object.keys(out.session_prescriptions).length, range_days: 7, truncated: false },
      };
    } catch (e) {
      return { ok: false, error: { error: `prescription_upsert_failed: ${String(e)}`, code: "upsert_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
  }

  // Read-only path: prefer stored row; fall back to fresh compute.
  const { data: tw } = await opts.supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", opts.userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  const existing = tw as TrainingWeek | null;
  const stored = existing?.session_prescriptions as SessionPrescriptions | null;
  if (stored && Object.keys(stored).length > 0) {
    return {
      ok: true,
      data: { week_start: weekStart, source: "stored", session_prescriptions: stored, block },
      meta: { ms: Date.now() - t0, result_rows: Object.keys(stored).length, range_days: 7, truncated: false },
    };
  }

  // No stored prescription — compute from prescribeWeek. Synthesize a minimal
  // working TrainingWeek row when none exists (prescribeWeek only reads
  // session_plan + rir_target + research_phase).
  let workingWeek: TrainingWeek;
  if (existing) {
    workingWeek = existing;
  } else {
    // Borrow prior week's session_plan, if any.
    const { data: priorRows } = await opts.supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", opts.userId)
      .lt("week_start", weekStart)
      .order("week_start", { ascending: false })
      .limit(1);
    const prior = (priorRows?.[0] as TrainingWeek | undefined) ?? null;
    workingWeek = {
      ...(prior ?? ({} as TrainingWeek)),
      id: "",
      user_id: opts.userId,
      block_id: block?.id ?? null,
      week_start: weekStart,
      session_plan: prior?.session_plan ?? {},
      original_session_plan: null,
      exercise_overrides: null,
      session_prescriptions: null,
      weekly_focus: prior?.weekly_focus ?? null,
      intensity_modifier: prior?.intensity_modifier ?? {},
      rir_target: prior?.rir_target ?? null,
      research_phase: prior?.research_phase ?? null,
      proposed_by: "coach",
      chat_message_id: null,
      endurance_session_plan: prior?.endurance_session_plan ?? null,
      committed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  // Look up the active block in full for prescribeWeek (the minimal projection
  // above lacks start_date / end_date used by the phase evaluator).
  const { data: fullBlockRows } = await opts.supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();
  const fullBlock = (fullBlockRows as TrainingBlock | null) ?? null;

  try {
    const prescription = await prescribeWeek({
      supabase: opts.supabase,
      userId: opts.userId,
      block: fullBlock,
      week: workingWeek,
      todayIso,
    });
    return {
      ok: true,
      data: { week_start: weekStart, source: "computed_on_the_fly", session_prescriptions: prescription, block },
      meta: { ms: Date.now() - t0, result_rows: Object.keys(prescription).length, range_days: 7, truncated: false },
    };
  } catch (e) {
    return { ok: false, error: { error: `prescribe_failed: ${String(e)}`, code: "prescribe_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
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

  // Strip any LLM-supplied session_prescriptions. The server computes them
  // deterministically below; accepting them from the model would re-open the
  // door to the "Carter narrates load table → propose accepts it" failure
  // mode the multi-coach team had pre-2026-05-31. The schema documents this
  // ("Do NOT pass session_prescriptions yourself") but defense-in-depth
  // matters when the schema and the LLM both forget.
  const sessionPlan = i.session_plan as Record<string, string>;
  const weekStart = i.week_start as string;
  const rirTarget = typeof i.rir_target === "number" ? i.rir_target : undefined;
  const researchPhase = typeof i.research_phase === "string" ? (i.research_phase as "accumulate" | "deload") : undefined;
  const weeklyFocus = typeof i.weekly_focus === "string" ? i.weekly_focus : undefined;
  const intensityModifier =
    typeof i.intensity_modifier === "object" && i.intensity_modifier !== null
      ? (i.intensity_modifier as Record<string, number>)
      : undefined;

  // ── Compute the canonical prescription via prescribeWeek ─────────────────
  // This is the SINGLE source of truth for per-exercise loads/reps/sets.
  // Carter doesn't author them; the rule engine does.
  const { data: activeBlocks } = await opts.supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .limit(1);
  const activeBlock = (activeBlocks?.[0] ?? null) as TrainingBlock | null;

  const prevWeekStart = subtractDaysIsoLocal(weekStart, 7);
  const { data: prevWeekRows } = await opts.supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", opts.userId)
    .eq("week_start", prevWeekStart)
    .limit(1);
  const prevWeek = (prevWeekRows?.[0] ?? null) as TrainingWeek | null;

  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));

  // Synthetic week shape for prescribeWeek — only the fields it reads matter.
  const synthesizedWeek = {
    id: "",
    user_id: opts.userId,
    block_id: activeBlock?.id ?? null,
    week_start: weekStart,
    session_plan: sessionPlan,
    original_session_plan: null,
    exercise_overrides: null,
    session_prescriptions: null,
    weekly_focus: weeklyFocus ?? null,
    intensity_modifier: intensityModifier ?? {},
    rir_target: rirTarget ?? null,
    research_phase: researchPhase ?? null,
    proposed_by: "coach" as const,
    chat_message_id: null,
    endurance_session_plan: null,
    committed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as TrainingWeek;

  let computedPrescription: SessionPrescriptions;
  try {
    computedPrescription = await prescribeWeek({
      supabase: opts.supabase,
      userId: opts.userId,
      block: activeBlock,
      week: synthesizedWeek,
      todayIso: today,
    });
  } catch (e) {
    return { ok: false, error: { error: `prescription_compute_failed: ${String(e)}`, code: "prescribe_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // ── Defense-in-depth validation against the same engine that produced the
  // prescription. A failure here is a rule-engine bug, not user input — log
  // and refuse rather than silently committing a malformed plan. Maintenance
  // baselines come from the same recent-sets sample prescribeWeek reads.
  const cutoff = subtractDaysIsoLocal(today, 28);
  const { data: workouts } = await opts.supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", opts.userId)
    .gte("date", cutoff)
    .order("date", { ascending: false });

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
  type RawEx = { name: string; exercise_sets: RawSet[] | null };
  type RawW = { date: string; exercises: RawEx[] | null };
  const wRows = (workouts ?? []) as unknown as RawW[];
  const recentSets: WorkoutSetSample[] = [];
  for (const w of wRows) {
    for (const ex of w.exercises ?? []) {
      for (const s of ex.exercise_sets ?? []) {
        if (s.kg == null || s.reps == null) continue;
        recentSets.push({
          exercise_name: ex.name,
          exercise_key: null,
          kg: s.kg,
          reps: s.reps,
          warmup: !!s.warmup,
          failure: !!s.failure,
          performed_on: w.date,
        });
      }
    }
  }

  const PRIMARY_LIFT_PATTERNS: Record<PrimaryLift, string[]> = {
    squat:    ["Squat (Barbell)"],
    bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
    deadlift: ["Deadlift (Barbell)"],
    ohp:      ["Overhead Press (Barbell)"],
  };

  const maintenanceBaselines: Partial<Record<PrimaryLift, number>> = {};
  const rirT = rirTarget ?? 2;
  for (const [lift, names] of Object.entries(PRIMARY_LIFT_PATTERNS) as Array<[PrimaryLift, string[]]>) {
    for (const n of names) {
      const m = maintenanceLoadFor(n, rirT, recentSets, today);
      if (m != null) {
        maintenanceBaselines[lift] = m;
        break;
      }
    }
  }

  const validationErr = validateWeekPrescription({
    prescription: computedPrescription,
    block: activeBlock,
    week: synthesizedWeek,
    prevWeek,
    maintenanceBaselines,
  });

  if (validationErr) {
    // The rule engine produced a result the validator rejected — almost
    // certainly a coverage gap in one of the rule modules. Surface the
    // structured error so the audit picks it up.
    console.error("[propose_week_plan] engine_output_failed_validation", {
      userId: opts.userId,
      week_start: weekStart,
      code: validationErr.code,
      message: validationErr.message,
    });
    return {
      ok: false,
      error: { error: `engine_output_invalid: ${validationErr.message}`, code: validationErr.code, hint: validationErr.hint },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const payload: ProposeWeekPlanInput = {
    week_start: weekStart,
    session_plan: sessionPlan,
    session_prescriptions: computedPrescription,
    weekly_focus: weeklyFocus,
    intensity_modifier: intensityModifier,
    rir_target: rirTarget,
    research_phase: researchPhase,
    rationale: typeof i.rationale === "string" ? i.rationale : undefined,
  };

  const token = signApprovalToken({ userId: opts.userId, action: "week", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false },
  };
}

// Local date helper for the propose_week_plan validator context. The
// maintenance-baseline module has its own private copy; we duplicate here
// (rather than export+import) to keep that module self-contained.
function subtractDaysIsoLocal(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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
    .select("*")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();
  const activeBlock = (active as TrainingBlock | null) ?? null;

  // ── Rehydrate the prescription at commit time ─────────────────────────────
  // The token's session_prescriptions was computed at propose time. Recompute
  // here so the writes reflect any workout(s) the athlete committed BETWEEN
  // propose and commit (which would shift maintenance baselines, possibly
  // toggling phase from off_pace → consolidation, etc.). The engine is
  // deterministic; if the world didn't change, the result matches the token.
  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
  const synthesizedWeek = {
    id: "",
    user_id: opts.userId,
    block_id: activeBlock?.id ?? null,
    week_start: p.week_start,
    session_plan: p.session_plan,
    original_session_plan: null,
    exercise_overrides: null,
    session_prescriptions: null,
    weekly_focus: p.weekly_focus ?? null,
    intensity_modifier: p.intensity_modifier ?? {},
    rir_target: p.rir_target ?? null,
    research_phase: p.research_phase ?? null,
    proposed_by: "coach" as const,
    chat_message_id: null,
    endurance_session_plan: null,
    committed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as TrainingWeek;

  let rehydrated: SessionPrescriptions;
  try {
    rehydrated = await prescribeWeek({
      supabase: opts.supabase,
      userId: opts.userId,
      block: activeBlock,
      week: synthesizedWeek,
      todayIso: today,
    });
  } catch (e) {
    return { ok: false, error: { error: `prescription_rehydrate_failed: ${String(e)}`, code: "prescribe_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { data, error } = await opts.supabase
    .from("training_weeks")
    .upsert(
      {
        user_id: opts.userId,
        block_id: activeBlock?.id ?? null,
        week_start: p.week_start,
        session_plan: p.session_plan,
        // Always write the rehydrated engine output, NOT what's in the token.
        // This is the load-bearing invariant: the database never stores an
        // LLM-authored prescription. Even with a stale or tampered token,
        // the stored row is the engine's verdict.
        session_prescriptions: rehydrated,
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

// ── propose_session_today / commit_session_today ─────────────────────────────
//
// One-off override of today's exercises. Writes
// training_weeks.exercise_overrides[<weekdayLong>] without the permutation
// rule the /api/training-weeks/[week_start]/exercise-overrides route enforces
// (that route still protects the drag-to-reorder chip's contract).
//
// Used for swap-policy rules 1 (pain), 3 (equipment), 6 (athlete-raised
// boredom) and illness scaling. Tomorrow's same-type session reverts to the
// template; this is single-day only.

const WEEKDAYS_LONG = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"] as const;
type WeekdayLong = (typeof WEEKDAYS_LONG)[number];

type SessionTodayPayload = {
  weekday: WeekdayLong;
  exercises: PlannedExercise[];
  rationale: string;
};

export const PROPOSE_SESSION_TODAY_TOOL = {
  name: "propose_session_today",
  description:
    "Propose a one-off override of today's exercises for the athlete to approve. Use ONLY for mid-block exceptions: pain (swap-policy rule 1), equipment unavailable (rule 3), illness scaling, athlete-raised boredom (rule 6). Tomorrow's same-type session reverts to the saved template. Writes to training_weeks.exercise_overrides[weekday]; does NOT persist beyond today. Requires a committed training_weeks row for the current week.",
  input_schema: {
    type: "object" as const,
    required: ["weekday", "exercises", "rationale"],
    properties: {
      weekday: { type: "string", enum: WEEKDAYS_LONG, description: "Full weekday name; must match today's user-tz weekday." },
      exercises: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name:     { type: "string", minLength: 2, maxLength: 80 },
            warmup:   { type: "boolean" },
            reps:     { type: "string", maxLength: 40 },
            baseKg:   { type: "number", minimum: 0, maximum: 500 },
            baseReps: { type: "integer", minimum: 1, maximum: 60 },
            sets:     { type: "integer", minimum: 1, maximum: 12 },
            key:      { type: "string", maxLength: 40 },
            note:     { type: "string", maxLength: 200 },
            increment: {
              type: "object",
              required: ["step"],
              properties: {
                step:         { type: "number", minimum: 0.5, maximum: 20 },
                intermediate: { type: "number", minimum: 0.5, maximum: 20 },
              },
            },
          },
        },
      },
      rationale: { type: "string", minLength: 4, maxLength: 400, description: "Plain-language reasoning shown to the athlete on the approval chip." },
    },
  },
};

export const COMMIT_SESSION_TODAY_TOOL = {
  name: "commit_session_today",
  description:
    "Commit a previously proposed one-off session override. Requires approval_token from propose_session_today. Writes training_weeks.exercise_overrides for today's weekday slot.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export async function executeProposeSessionToday(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: SessionTodayPayload; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.weekday !== "string" || !(WEEKDAYS_LONG as readonly string[]).includes(i.weekday)) {
    return { ok: false, error: { error: "weekday must be a full weekday name (Monday-Sunday)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!Array.isArray(i.exercises) || i.exercises.length === 0) {
    return { ok: false, error: { error: "exercises must be a non-empty array" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.rationale !== "string" || i.rationale.length < 4) {
    return { ok: false, error: { error: "rationale required (4-400 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Soft anchor: the weekday should match today's user-tz weekday. If it
  // doesn't, the override would land on the wrong day. Reject cleanly rather
  // than silently writing the wrong slot.
  const todayWeekday = weekdayInUserTz(new Date(), await getUserTimezone(opts.userId));
  if (i.weekday !== todayWeekday) {
    return {
      ok: false,
      error: { error: `weekday=${i.weekday} doesn't match today (${todayWeekday}). For future days, propose a week plan instead.` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Off-grid weight guard. Each library entry carries `increment.step` (per-DB
  // for paired DBs; total otherwise) and `pairedDb`. baseKg must be a multiple
  // of step. Free-form exercises not in the library are skipped — Carter
  // flagged the library gap in the rationale and the athlete will see it on
  // the chip. See spec 2026-05-26-carter-coherence-design.md §6.
  for (const ex of i.exercises as Array<Record<string, unknown>>) {
    const name = typeof ex.name === "string" ? ex.name : null;
    const baseKg = typeof ex.baseKg === "number" ? ex.baseKg : null;
    if (!name || baseKg == null) continue;

    const lib = resolveExercise(name);
    if (!lib || !lib.increment) continue;  // bodyweight / duration / library gap

    const step = lib.increment.step;
    const intermediate = lib.increment.intermediate;
    const onPrimaryGrid =
      Math.abs((baseKg / step) - Math.round(baseKg / step)) < 1e-6;
    const onIntermediateGrid =
      intermediate != null &&
      baseKg >= intermediate &&
      Math.abs(((baseKg - intermediate) / step) - Math.round((baseKg - intermediate) / step)) < 1e-6;
    const onGrid = onPrimaryGrid || onIntermediateGrid;
    if (!onGrid) {
      const lower = Math.max(0, Math.floor(baseKg / step) * step);
      const upper = Math.ceil(baseKg / step) * step;
      const candidates: number[] = [lower, upper];
      if (intermediate != null) {
        const offset = baseKg - intermediate;
        const interLower = intermediate + Math.floor(offset / step) * step;
        const interUpper = intermediate + Math.ceil(offset / step) * step;
        if (interLower >= 0) candidates.push(interLower);
        if (interUpper >= 0) candidates.push(interUpper);
      }
      const validNeighbors = Array.from(new Set(candidates)).filter((v) => v >= 0).sort((a, b) => a - b);
      const rule =
        lib.pairedDb === true
          ? `Paired DB: step is ${step} kg PER DB (total system load jumps by ${step * 2} kg).`
          : lib.pairedDb === false
          ? `Single DB: step is ${step} kg total.`
          : `Step is ${step} kg.`;
      return {
        ok: false,
        error: {
          error: "off_grid_weight",
          code: "off_grid_weight",
          hint: JSON.stringify({
            exercise: name,
            proposed_kg: baseKg,
            step,
            paired_db: lib.pairedDb ?? null,
            valid_neighbors: validNeighbors,
            rule,
          }),
        },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
  }

  const payload: SessionTodayPayload = {
    weekday: i.weekday as WeekdayLong,
    exercises: i.exercises as PlannedExercise[],
    rationale: i.rationale as string,
  };
  const token = signApprovalToken({ userId: opts.userId, action: "session_today", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 1, truncated: false },
  };
}

export async function executeCommitSessionToday(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ week_start: string; weekday: WeekdayLong; exercises: PlannedExercise[] }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;

  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "session_today" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the session payload. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as SessionTodayPayload;

  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
  const week_start = weekStart(today);

  const { data: row, error: loadErr } = await opts.supabase
    .from("training_weeks")
    .select("id, exercise_overrides")
    .eq("user_id", opts.userId)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return { ok: false, error: { error: "Couldn't load this week's plan. Please try again.", code: loadErr.code ?? "load_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!row) {
    return {
      ok: false,
      error: { error: "No weekly plan committed yet for this week. Tell me 'plan my week' first.", code: "no_week" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const existing = (row.exercise_overrides as Record<string, PlannedExercise[]> | null) ?? {};
  const next = { ...existing, [p.weekday]: p.exercises };

  const { error: updateErr } = await opts.supabase
    .from("training_weeks")
    .update({ exercise_overrides: next, updated_at: new Date().toISOString() })
    .eq("user_id", opts.userId)
    .eq("week_start", week_start);
  if (updateErr) {
    return { ok: false, error: { error: "Couldn't save today's session override. Please try again.", code: updateErr.code ?? "update_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { week_start, weekday: p.weekday, exercises: p.exercises },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 1, truncated: false },
  };
}

// ── propose_session_template / commit_session_template ───────────────────────
//
// Defines the canonical exercise list for a session type (what "Arms"
// contains). Persists across weeks via user_session_templates. Used for:
//   - first-time setup of a session type (today's empty-card gap)
//   - block-boundary 1-2 accessory rotation (swap-policy rule 5)
// Carter is instructed to call query_exercise_library first and prefer
// library-canonical names; free-form names are allowed but flagged in the
// rationale (they skip downstream metadata like session-structure tiering).

type SessionTemplatePayload = {
  session_type: string;
  exercises: PlannedExercise[];
  rationale: string;
};

export const PROPOSE_SESSION_TEMPLATE_TOOL = {
  name: "propose_session_template",
  description:
    "Propose the canonical exercise list for a session type (e.g. what 'Arms' contains). Persists across weeks via user_session_templates. Use when a session type has no exercises set up yet, or at a block boundary to rotate 1-2 accessories (swap-policy rule 5). Call query_exercise_library first to source canonical names; free-form names are allowed when the library has a genuine gap but should be flagged in the rationale.",
  input_schema: {
    type: "object" as const,
    required: ["session_type", "exercises", "rationale"],
    properties: {
      session_type: { type: "string", minLength: 2, maxLength: 40, description: "e.g. 'Arms', 'Push', 'Pull', 'Chest'." },
      exercises: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name:     { type: "string", minLength: 2, maxLength: 80 },
            warmup:   { type: "boolean" },
            reps:     { type: "string", maxLength: 40 },
            baseKg:   { type: "number", minimum: 0, maximum: 500 },
            baseReps: { type: "integer", minimum: 1, maximum: 60 },
            sets:     { type: "integer", minimum: 1, maximum: 12 },
            key:      { type: "string", maxLength: 40 },
            note:     { type: "string", maxLength: 200 },
            increment: {
              type: "object",
              required: ["step"],
              properties: {
                step:         { type: "number", minimum: 0.5, maximum: 20 },
                intermediate: { type: "number", minimum: 0.5, maximum: 20 },
              },
            },
          },
        },
      },
      rationale: { type: "string", minLength: 4, maxLength: 400, description: "Plain-language reasoning shown to the athlete on the approval chip." },
    },
  },
};

export const COMMIT_SESSION_TEMPLATE_TOOL = {
  name: "commit_session_template",
  description:
    "Commit a previously proposed session-type template. Requires approval_token from propose_session_template. Upserts user_session_templates by (user_id, session_type).",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export async function executeProposeSessionTemplate(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: SessionTemplatePayload; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.session_type !== "string" || i.session_type.length < 2 || i.session_type.length > 40) {
    return { ok: false, error: { error: "session_type required (2-40 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!Array.isArray(i.exercises) || i.exercises.length === 0) {
    return { ok: false, error: { error: "exercises must be a non-empty array" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.rationale !== "string" || i.rationale.length < 4) {
    return { ok: false, error: { error: "rationale required (4-400 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const payload: SessionTemplatePayload = {
    session_type: i.session_type as string,
    exercises: i.exercises as PlannedExercise[],
    rationale: i.rationale as string,
  };
  const token = signApprovalToken({ userId: opts.userId, action: "session_template", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeCommitSessionTemplate(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ session_type: string; exercises: PlannedExercise[] }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;

  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "session_template" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the template payload. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as SessionTemplatePayload;

  const { error: upsertErr } = await opts.supabase
    .from("user_session_templates")
    .upsert(
      {
        user_id: opts.userId,
        session_type: p.session_type,
        exercises: p.exercises,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,session_type" },
    );
  if (upsertErr) {
    return { ok: false, error: { error: "Couldn't save the session template. Please try again.", code: upsertErr.code ?? "upsert_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { session_type: p.session_type, exercises: p.exercises },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
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

// ── Persistent profile setters (not intake_payload) ─────────────────────────

export const SET_ROTATION_PRIORITY_LIFT_TOOL = {
  name: "set_rotation_priority_lift",
  description:
    "Set the athlete's persistent rotation priority lift (single value). When set, every other rotation slot becomes this lift, with a non-priority lift between for recovery. Pass 'none' to clear; standard D → B → S → OHP rotation resumes.",
  input_schema: {
    type: "object" as const,
    required: ["lift"],
    properties: {
      lift: { type: "string", enum: ["squat", "bench", "deadlift", "ohp", "none"] },
    },
  },
};

export const APPLY_ROTATION_OVERRIDE_TOOL = {
  name: "apply_rotation_override",
  description:
    "When the athlete picks a different lift in SETUP_BLOCK_PROMPT (not the rotation recommendation), mark the most recent unacknowledged block_outcomes row's lessons.rotation_context.athlete_overrode_rotation = true with the reason. Idempotent.",
  input_schema: {
    type: "object" as const,
    required: ["override_reason"],
    properties: {
      override_reason: { type: "string", maxLength: 200 },
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
  const planRef = envelope.ref as { doc_id?: string; payload_hash?: string } | undefined;
  if (!planRef || planRef.doc_id !== opts.draftDocId) {
    return { ok: false, error: { error: "That approval belongs to a different draft plan. Please re-propose.", code: "doc_mismatch" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const currentHash = payloadHash(draft.plan_payload);
  if (currentHash !== planRef.payload_hash) {
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

export async function executeSetRotationPriorityLift(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ rotation_priority_lift: PrimaryLift | null }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const liftRaw = i.lift;
  if (typeof liftRaw !== "string") {
    return { ok: false, error: { error: "lift required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const lift = liftRaw === "none" ? null : (liftRaw as PrimaryLift);
  if (lift !== null && !["squat", "bench", "deadlift", "ohp"].includes(lift)) {
    return { ok: false, error: { error: "invalid lift" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { error } = await opts.supabase
    .from("profiles")
    .update({ rotation_priority_lift: lift })
    .eq("user_id", opts.userId);
  if (error) {
    return { ok: false, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return {
    ok: true,
    data: { rotation_priority_lift: lift },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeApplyRotationOverride(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ outcome_id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const reason = typeof i.override_reason === "string" ? i.override_reason : null;
  if (!reason) {
    return { ok: false, error: { error: "override_reason required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { data: outcomes } = await opts.supabase
    .from("block_outcomes")
    .select("id, lessons")
    .eq("user_id", opts.userId)
    .is("athlete_acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const o = outcomes?.[0];
  if (!o) {
    return { ok: false, error: { error: "no unacknowledged outcome to override" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const oldLessons = (o.lessons as Record<string, unknown>) ?? {};
  const oldRotation = ((oldLessons.rotation_context as Record<string, unknown>) ?? {});
  const newLessons = {
    ...oldLessons,
    rotation_context: {
      ...oldRotation,
      athlete_overrode_rotation: true,
      override_reason: reason,
    },
  };

  const { error } = await opts.supabase
    .from("block_outcomes")
    .update({ lessons: newLessons, updated_at: new Date().toISOString() })
    .eq("id", o.id);
  if (error) {
    return { ok: false, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return { ok: true, data: { outcome_id: o.id }, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
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

// ── Endurance milestone tools (direct write, no HMAC; mirror GLP-1 milestone tools) ──

export const SET_ENDURANCE_PHASE_TOOL = {
  name: "set_endurance_phase",
  description:
    "Update the active athlete profile's endurance_profile.phase in place. Use when the athlete transitions phases (aerobic_base → build, build → race_prep, etc). Optionally update weekly_volume_target_hours in the same call. Phase 1 supports aerobic_base only; other phases will write but the composer won't produce prescriptions for them yet.",
  input_schema: {
    type: "object" as const,
    required: ["phase"],
    properties: {
      phase: { type: "string", enum: ["aerobic_base", "build", "race_prep", "taper", "off_season"] },
      weekly_volume_target_hours: { type: "number", minimum: 0.5, maximum: 20 },
    },
  },
} as const;

export const SET_ENDURANCE_DISCIPLINE_TOOL = {
  name: "set_endurance_discipline",
  description:
    "Update the active athlete profile's endurance_profile.discipline. Use when transitioning from cycling-only to triathlon (or vice versa). Phase 1 ships cycling only; setting 'triathlon' or 'running' is permitted but the composer will return ok:false until Phase 2.",
  input_schema: {
    type: "object" as const,
    required: ["discipline"],
    properties: {
      discipline: { type: "string", enum: ["cycling", "running", "triathlon"] },
    },
  },
} as const;

export const SET_THRESHOLD_HR_TOOL = {
  name: "set_threshold_hr",
  description:
    "Set the athlete's lactate-threshold HR (LTHR, bpm). Used as the anchor for HR-based TSS computation and Z2/Z4 zone derivation. Without it, TSS for new activities is null. Calibration sources: 30-minute time trial average HR (gold standard), or recent threshold-effort average HR.",
  input_schema: {
    type: "object" as const,
    required: ["bpm"],
    properties: { bpm: { type: "integer", minimum: 80, maximum: 220 } },
  },
} as const;

export const SET_FTP_TOOL = {
  name: "set_ftp",
  description:
    "Set the athlete's functional threshold power (FTP, watts) for cycling. Phase 2 use — once power data exists in endurance_activities, computeTssForActivity will prefer the power formula over HR. Setting this in Phase 1 is harmless; the column simply isn't read yet.",
  input_schema: {
    type: "object" as const,
    required: ["watts"],
    properties: { watts: { type: "integer", minimum: 50, maximum: 600 } },
  },
} as const;

async function patchEnduranceProfile(
  userId: string,
  patch: Partial<import("@/lib/coach/endurance/types").EnduranceProfile>,
): Promise<import("@/lib/coach/endurance/types").EnduranceProfile> {
  const sb = (await import("@/lib/supabase/server")).createSupabaseServiceRoleClient();
  const { data: row, error } = await sb
    .from("athlete_profile_documents")
    .select("id, endurance_profile")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`read athlete profile: ${error.message}`);
  if (!row) throw new Error("No active athlete profile; complete onboarding first.");

  const existing = (row.endurance_profile ?? {
    discipline: "cycling",
    phase: "aerobic_base",
    threshold_hr: null,
    hr_max: null,
    hr_zones: null,
    ftp_watts: null,
    threshold_pace_s_per_km: null,
    weekly_volume_target_hours: 1,
    preferred_endurance_day: null,
    current_race: null,
    set_at: new Date().toISOString(),
  }) as import("@/lib/coach/endurance/types").EnduranceProfile;

  const merged = { ...existing, ...patch, set_at: new Date().toISOString() };
  const { error: upErr } = await sb
    .from("athlete_profile_documents")
    .update({ endurance_profile: merged })
    .eq("id", row.id);
  if (upErr) throw new Error(`update athlete profile: ${upErr.message}`);
  return merged;
}

export async function executeSetEndurancePhase(opts: {
  userId: string;
  input: { phase: "aerobic_base" | "build" | "race_prep" | "taper" | "off_season"; weekly_volume_target_hours?: number };
}) {
  const t0 = Date.now();
  const patch: Partial<import("@/lib/coach/endurance/types").EnduranceProfile> = { phase: opts.input.phase };
  if (opts.input.weekly_volume_target_hours != null) {
    patch.weekly_volume_target_hours = opts.input.weekly_volume_target_hours;
  }
  const merged = await patchEnduranceProfile(opts.userId, patch);
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
}

export async function executeSetEnduranceDiscipline(opts: {
  userId: string;
  input: { discipline: "cycling" | "running" | "triathlon" };
}) {
  const t0 = Date.now();
  const merged = await patchEnduranceProfile(opts.userId, { discipline: opts.input.discipline });
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
}

export async function executeSetThresholdHr(opts: { userId: string; input: { bpm: number } }) {
  const t0 = Date.now();
  const merged = await patchEnduranceProfile(opts.userId, { threshold_hr: opts.input.bpm });
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
}

export async function executeSetFtp(opts: { userId: string; input: { watts: number } }) {
  const t0 = Date.now();
  const merged = await patchEnduranceProfile(opts.userId, { ftp_watts: opts.input.watts });
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
}

// ── Endurance query + propose/commit week (HMAC) ──

export const QUERY_ENDURANCE_ACTIVITIES_TOOL = {
  name: "query_endurance_activities",
  description:
    "Read endurance_activities rows (Strava-ingested rides/runs/swims) for the athlete in a date range. Returns per-activity: started_at, sport, duration_s, distance_m, avg_hr, max_hr, tss, hr_zone_distribution. Distinct from query_daily_logs which returns day-level totals. Use for 'what did I do this week' / 'how many Z2 minutes' / 'show me my last ride' questions. 90-day range cap.",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", description: "YYYY-MM-DD local date (inclusive)" },
      end_date:   { type: "string", description: "YYYY-MM-DD local date (inclusive)" },
      sport:      { type: "string", enum: ["cycling", "running", "swimming", "other"] },
      min_duration_min: { type: "integer", minimum: 1 },
    },
  },
} as const;

export async function executeQueryEnduranceActivities(opts: {
  userId: string;
  input: { start_date: string; end_date: string; sport?: string; min_duration_min?: number };
}) {
  const t0 = Date.now();
  const start = new Date(`${opts.input.start_date}T00:00:00Z`);
  const end = new Date(`${opts.input.end_date}T00:00:00Z`);
  const days = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
  if (days > 90) {
    return { ok: false as const, error: { error: "range > 90 days" }, meta: { ms: Date.now() - t0, range_days: days } };
  }
  const sb = (await import("@/lib/supabase/server")).createSupabaseServiceRoleClient();
  let q = sb
    .from("endurance_activities")
    .select("id, started_at, local_date, sport, duration_s, distance_m, avg_hr, max_hr, tss, hr_zone_distribution, avg_speed_kmh, calories")
    .eq("user_id", opts.userId)
    .is("deleted_at", null)
    .gte("local_date", opts.input.start_date)
    .lte("local_date", opts.input.end_date)
    .order("started_at", { ascending: false })
    .limit(100);
  if (opts.input.sport) q = q.eq("sport", opts.input.sport);
  if (opts.input.min_duration_min) q = q.gte("duration_s", opts.input.min_duration_min * 60);
  const { data, error } = await q;
  if (error) return { ok: false as const, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: days } };
  const rows = data ?? [];
  return { ok: true as const, data: rows, meta: { ms: Date.now() - t0, result_rows: rows.length, range_days: days, truncated: rows.length >= 100 } };
}

export const PROPOSE_ENDURANCE_WEEK_TOOL = {
  name: "propose_endurance_week",
  description:
    "Generate a preview of a weekly endurance prescription. Does NOT write. Returns preview + approval_token. Carter calls composeZ2Base internally (Phase 1 supports aerobic_base / cycling only). User must approve via commit_endurance_week.",
  input_schema: {
    type: "object" as const,
    required: ["week_start"],
    properties: {
      week_start: { type: "string", description: "YYYY-MM-DD of the Sunday starting the prescribed week" },
      preferred_day: { type: "integer", minimum: 0, maximum: 6, description: "0=Sun..6=Sat, day to anchor first session on; default Wed (3)" },
    },
  },
} as const;

export const COMMIT_ENDURANCE_WEEK_TOOL = {
  name: "commit_endurance_week",
  description:
    "Commit a previously proposed endurance week. Requires approval_token from propose_endurance_week. Idempotent on (user_id, week_start) — re-committing UPDATEs training_weeks.endurance_session_plan.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: { approval_token: { type: "string", minLength: 60 } },
  },
} as const;

type ProposeEnduranceInput = { week_start: string; preferred_day?: 0|1|2|3|4|5|6 };
type EnduranceWeekPayload = {
  week_start: string;
  plan: import("@/lib/coach/endurance/types").EnduranceSessionPlan;
  rationale: string;
};

export async function executeProposeEnduranceWeek(opts: {
  userId: string;
  input: ProposeEnduranceInput;
}) {
  const t0 = Date.now();
  const sb = (await import("@/lib/supabase/server")).createSupabaseServiceRoleClient();
  const { data: profileRow, error } = await sb
    .from("athlete_profile_documents")
    .select("endurance_profile")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !profileRow?.endurance_profile) {
    return { ok: false as const, error: { error: "No endurance_profile — set up on /profile first." }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const { composeZ2Base } = await import("@/lib/coach/endurance/compose-z2-base");
  const result = composeZ2Base({
    profile: profileRow.endurance_profile as import("@/lib/coach/endurance/types").EnduranceProfile,
    preferredDay: opts.input.preferred_day,
  });
  if (!result.ok) {
    return { ok: false as const, error: { error: result.reason }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const payload: EnduranceWeekPayload = {
    week_start: opts.input.week_start,
    plan: result.plan,
    rationale: result.rationale,
  };
  const token = signApprovalToken({ userId: opts.userId, action: "endurance_week", payload });
  return {
    ok: true as const,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeCommitEnduranceWeek(opts: {
  userId: string;
  input: { approval_token: string };
}) {
  const t0 = Date.now();
  let env;
  try {
    env = verifyApprovalToken({ token: opts.input.approval_token, userId: opts.userId, action: "endurance_week" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false as const, error: { error: approvalTokenUserMessage(e.code) }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    throw e;
  }
  const payload = env.payload as EnduranceWeekPayload;
  const sb = (await import("@/lib/supabase/server")).createSupabaseServiceRoleClient();

  // Upsert: training_weeks may or may not have a row for this week yet.
  const { data: existing } = await sb
    .from("training_weeks")
    .select("id")
    .eq("user_id", opts.userId)
    .eq("week_start", payload.week_start)
    .maybeSingle();
  if (existing) {
    const { error } = await sb
      .from("training_weeks")
      .update({ endurance_session_plan: payload.plan })
      .eq("id", existing.id);
    if (error) return { ok: false as const, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  } else {
    const { error } = await sb
      .from("training_weeks")
      .insert({
        user_id: opts.userId,
        week_start: payload.week_start,
        // session_plan is NOT NULL on training_weeks — empty object means "no strength prescription at this row";
        // getEffectiveSessionPlan falls through to static SESSION_PLANS defaults.
        session_plan: {},
        endurance_session_plan: payload.plan,
      });
    if (error) return { ok: false as const, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return { ok: true as const, data: { week_start: payload.week_start, plan: payload.plan }, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
}

// ────────────────────────────────────────────────────────────────────────────
// Library tools — search_library, pick_library_item, save_to_library.
// Nora-only. Operate on user_food_items; pick_library_item also patches a
// draft food_log_entries row in place.
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

  // Token-AND requirement instead of raw substring: every query word must
  // appear as a whole-word match (word boundary on both sides) inside the
  // name. Prevents the 2026-05-22 "grilled chicken → McDonald's Chicken
  // Salad with Grilled Chicken" miss-hit where a substring match grabbed
  // a brand item with extra prefix tokens. Fetch a wider candidate window
  // first (ilike on the first token still uses the trigram index), then
  // rank in JS so the cheapest exact / prefix matches win.
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return {
      ok: true,
      data: { items: [] },
      meta: { ms: Date.now() - t0, result_rows: 0, range_days: 0, truncated: false },
    };
  }

  // Pull a generous candidate window keyed on the longest token (most
  // selective on average). Score + filter happens client-side.
  const seedToken = [...tokens].sort((a, b) => b.length - a.length)[0];
  const { data, error } = await opts.supabase
    .from("user_food_items")
    .select("id, name")
    .eq("user_id", opts.userId)
    .ilike("name", `%${seedToken}%`)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) {
    return {
      ok: false,
      error: { error: error.message },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const wordBoundary = (haystack: string, token: string) =>
    new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack);

  type Row = { id: string; name: string };
  const rows = (data ?? []) as Row[];
  const scored: Array<{ row: Row; score: number }> = [];
  const lowerQuery = query.toLowerCase();
  for (const row of rows) {
    const lowerName = row.name.toLowerCase();
    // Require ALL tokens to be word-boundary present. Anything less and we
    // drop the candidate — better to return 0 hits than the wrong row.
    const allPresent = tokens.every((tok) => wordBoundary(lowerName, tok));
    if (!allPresent) continue;
    let score = 0;
    if (lowerName === lowerQuery) score = 100;
    else if (lowerName.startsWith(lowerQuery)) score = 80;
    else if (lowerName.includes(lowerQuery)) score = 60;
    else score = 40;
    // Length-penalty so "Grilled Chicken Breast" outranks
    // "McDonald's Grilled Chicken Salad Wrap Combo with Side" when both
    // satisfy the tokens. 1 pt off per extra word past the query length.
    const nameWords = lowerName.split(/\s+/).length;
    const queryWords = tokens.length;
    if (nameWords > queryWords) score -= Math.min(20, nameWords - queryWords);
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const items = scored.slice(0, limit).map((s) => s.row);
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
// resolve_food_macros — read-only chain wrapper for Nora.
//
// Exposes lib/food/lookup.ts:resolveItemMacros (library → food_db_cache → USDA
// → OpenFoodFacts → LLM) to chat. Lets Nora resolve macros without burning
// web_search budget on whole foods her training data already covers. The
// underlying resolver writes USDA / OFF hits to food_db_cache, so repeated
// lookups of the same item short-circuit.
// ────────────────────────────────────────────────────────────────────────────

export const RESOLVE_FOOD_MACROS_TOOL: ToolSchema = {
  name: "resolve_food_macros",
  description:
    "Resolve per-100g macros for a food item via library → cache → USDA → OpenFoodFacts → LLM fallback. Use this BEFORE propose_meal_log when the user hasn't given you explicit macros. Cheap and cached — prefer this over web_search for standard foods.",
  input_schema: {
    type: "object" as const,
    required: ["name", "qty_g"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120, description: "Display name (e.g., 'grilled chicken breast', '200g brown rice cooked')." },
      qty_g: { type: "number", minimum: 0.1, maximum: 5000, description: "Quantity in grams." },
    },
  },
};

export async function executeResolveFoodMacros(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ name: string; qty_g: number; kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number; per_100g: FoodMacros; source: "db" | "llm"; db_ref: { source: string; canonical_id: string } | null; confidence: "high" | "medium" | "low" | null; match_score: number | null; library_item_id: string | null }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const name = typeof i.name === "string" ? i.name.trim() : "";
  const qty_g = typeof i.qty_g === "number" && i.qty_g > 0 ? i.qty_g : NaN;
  if (!name || !Number.isFinite(qty_g)) {
    return { ok: false, error: { error: "name (string) and qty_g (positive number) required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  try {
    const item = await resolveItemMacros(name, qty_g, opts.userId);
    return {
      ok: true,
      data: {
        name: item.name,
        qty_g: item.qty_g,
        kcal: item.kcal,
        protein_g: item.protein_g,
        carbs_g: item.carbs_g,
        fat_g: item.fat_g,
        fiber_g: item.fiber_g,
        per_100g: item.per_100g,
        source: item.source,
        db_ref: item.db_ref,
        confidence: item.confidence,
        match_score: item.match_score,
        library_item_id: item.db_ref?.source === "user_library" ? item.db_ref.canonical_id : null,
      },
      meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
    };
  } catch (err) {
    return {
      ok: false,
      error: { error: `resolve failed for "${name}": ${(err as Error).message}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// propose_meal_log / commit_meal_log — Nora's confirm-gated meal write.
//
// Replaces the legacy fire-and-confirm log_meal_entry tool. Nora calls propose
// with raw (name, qty_g) tuples; the executor resolves each via
// resolveItemMacros, builds the preview, and signs an approval token. The chat
// UI renders MealLogProposalCard with an Approve button. On approval the
// athlete's message contains [approve:<token>], Nora calls commit, the
// food_log_entries row is inserted, any non-library items get auto-saved to
// user_food_items as a side effect (idempotent via 23505 dedup floor), and
// the day re-aggregates.
//
// Auto-save: items resolved from the personal library (db_ref.source ===
// 'user_library') pass through with library_item_id stamped on the food log
// item. All other items (USDA / OFF / LLM-estimated) get inserted into
// user_food_items so the next log of the same name short-circuits at the
// library lookup. executeSaveToLibrary already handles the 23505 unique
// violation as was_duplicate=true — no extra collision logic needed here.
// ────────────────────────────────────────────────────────────────────────────

type ProposeMealLogItem = {
  name: string;
  qty_g: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: FoodItem["db_ref"];
  confidence: "high" | "medium" | "low" | null;
  match_score: number | null;
  library_item_id: string | null;
};

type MealLogPayload = {
  items: ProposeMealLogItem[];
  meal_slot: MealSlot;
  eaten_at: string;
  raw_text: string;
  totals: FoodMacros;
};

export const PROPOSE_MEAL_LOG_TOOL: ToolSchema = {
  name: "propose_meal_log",
  description:
    "Propose a meal-log write for the athlete to approve. Server-side: resolves each item's macros via library → cache → USDA → OpenFoodFacts → LLM, builds a preview with day-totals delta, and signs an approval token. The chat UI surfaces an Approve chip; the athlete's approval triggers commit_meal_log. Use AFTER you've confirmed item names + quantities with the athlete. Do NOT call resolve_food_macros first — this tool resolves everything itself.",
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
          required: ["name", "qty_g"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            qty_g: { type: "number", minimum: 0.1, maximum: 5000 },
          },
        },
      },
      meal_slot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
      eaten_at: { type: "string", description: "Optional ISO-8601 timestamp. Defaults to now." },
      raw_text: { type: "string", description: "Optional original user message for traceability." },
    },
  },
};

export const COMMIT_MEAL_LOG_TOOL: ToolSchema = {
  name: "commit_meal_log",
  description:
    "Commit a previously proposed meal-log entry. Requires approval_token from propose_meal_log. Writes food_log_entries, auto-saves any non-library items to user_food_items, and reaggregates daily_logs.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export const PROPOSE_MEAL_SUGGESTIONS_TOOL: ToolSchema = {
  name: "propose_meal_suggestions",
  description:
    "Generate 2-3 meal options for a slot, grounded in the athlete's 90-day eating identity, with hard dietary exclusions enforced. Each option is one-tap loggable via pre-issued HMAC approval token. Use when the athlete asks 'what should I have for X', 'alternatives to Y', or 'I'm bored of Z' — never improvise meal names in prose.",
  input_schema: {
    type: "object" as const,
    required: ["slot"],
    properties: {
      slot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
      count: { type: "number", minimum: 2, maximum: 4, default: 3 },
      prefer_novelty: { type: "boolean", default: false },
    },
  },
};

export async function executeProposeMealLog(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
  /** The currently-streaming assistant chat_messages row id. When present
   *  the token uses a `ref` envelope and the proposal payload is read back
   *  out of chat_messages.tool_calls at commit time — keeps the token to
   *  ~300 chars vs ~7000 for an embedded 12-item meal payload. Null when
   *  the caller can't provide one (e.g. unit tests); falls back to legacy
   *  embedded-payload form. */
  assistantMessageId?: string | null;
}): Promise<ToolResult<{ preview: MealLogPayload; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const meal_slot = i.meal_slot as MealSlot | undefined;
  if (!meal_slot || !["breakfast", "lunch", "dinner", "snack"].includes(meal_slot)) {
    return { ok: false, error: { error: "meal_slot must be one of breakfast|lunch|dinner|snack" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const itemsInput = Array.isArray(i.items) ? (i.items as Array<Record<string, unknown>>) : [];
  if (itemsInput.length === 0 || itemsInput.length > 15) {
    return { ok: false, error: { error: "items must contain 1..15 entries" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const eaten_at_raw = typeof i.eaten_at === "string" ? i.eaten_at : null;
  const eaten_at =
    eaten_at_raw && !Number.isNaN(Date.parse(eaten_at_raw))
      ? new Date(eaten_at_raw).toISOString()
      : new Date().toISOString();
  const raw_text = typeof i.raw_text === "string" ? i.raw_text : "Logged via chat";

  const resolved: ProposeMealLogItem[] = [];
  for (const it of itemsInput) {
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const qty_g = typeof it.qty_g === "number" && it.qty_g > 0 ? it.qty_g : NaN;
    if (!name || !Number.isFinite(qty_g)) {
      return { ok: false, error: { error: `item missing name/qty_g: ${JSON.stringify(it).slice(0, 120)}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    try {
      const item = await resolveItemMacros(name, qty_g, opts.userId);
      resolved.push({
        name: item.name,
        qty_g: item.qty_g,
        kcal: item.kcal,
        protein_g: item.protein_g,
        carbs_g: item.carbs_g,
        fat_g: item.fat_g,
        fiber_g: item.fiber_g,
        per_100g: item.per_100g,
        source: item.source,
        db_ref: item.db_ref,
        confidence: item.confidence,
        match_score: item.match_score,
        library_item_id: item.db_ref?.source === "user_library" ? item.db_ref.canonical_id : null,
      });
    } catch (err) {
      return {
        ok: false,
        error: { error: `resolve failed for "${name}": ${(err as Error).message}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
  }
  const totals = sumMacros(resolved);

  const payload: MealLogPayload = {
    items: resolved,
    meal_slot,
    eaten_at,
    raw_text,
    totals,
  };
  // Ref-based token when we know the streaming assistant row — propose's
  // result is persisted to chat_messages.tool_calls via PERSIST_RESULT_TOOLS,
  // so commit can read the payload back from there. Token shrinks from ~7k
  // chars (12-item embedded payload base64'd) to ~300 chars, which is the
  // difference between the model fitting commit_meal_log({approval_token})
  // inside MAX_TOKENS=2000 vs streaming for 60s+ trying to echo the token.
  const token = opts.assistantMessageId
    ? signApprovalToken({
        userId: opts.userId,
        action: "meal_log",
        ref: { chat_message_id: opts.assistantMessageId },
      })
    : signApprovalToken({ userId: opts.userId, action: "meal_log", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeCommitMealLog(opts: {
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
    saved_library_ids: string[];
  }>
> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;
  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "meal_log" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  // Resolve the proposal payload. Two forms supported:
  //   1. Ref-based (current): token carries chat_message_id. Look up the
  //      propose assistant row's tool_calls — propose_meal_log persists its
  //      result via PERSIST_RESULT_TOOLS, so the preview is right there.
  //   2. Embedded (legacy): token carries the full payload. Used by tokens
  //      signed before the ref migration (still valid until their 30-min TTL
  //      expires) or by callers without an assistantMessageId.
  let p: MealLogPayload | null = null;
  const ref = envelope.ref as { chat_message_id?: string } | undefined;
  if (ref?.chat_message_id) {
    const { data: row, error: lookupErr } = await opts.supabase
      .from("chat_messages")
      .select("tool_calls")
      .eq("user_id", opts.userId)
      .eq("id", ref.chat_message_id)
      .maybeSingle();
    if (lookupErr || !row) {
      return { ok: false, error: { error: "That proposal can't be found — please re-propose.", code: "ref_not_found" }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    const calls = (row as { tool_calls?: Array<{ name: string; result?: unknown }> }).tool_calls ?? [];
    const proposeCall = calls.find((c) => c.name === "propose_meal_log");
    const preview = (proposeCall?.result as { preview?: unknown } | undefined)?.preview;
    if (!preview || typeof preview !== "object") {
      return { ok: false, error: { error: "That proposal can't be found — please re-propose.", code: "ref_no_preview" }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    p = preview as MealLogPayload;
  } else if (envelope.payload && typeof envelope.payload === "object") {
    p = envelope.payload as MealLogPayload;
  }
  if (!p) {
    return { ok: false, error: { error: "That approval is missing the meal payload. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const saved_library_ids: string[] = [];
  const itemsWithLibRefs: FoodItem[] = [];
  for (const it of p.items) {
    let library_item_id = it.library_item_id;
    if (!library_item_id) {
      const save = await executeSaveToLibrary({
        supabase: opts.supabase,
        userId: opts.userId,
        input: { kind: "item", name: it.name, source: "user_manual", per_100g: it.per_100g },
      });
      if (save.ok) {
        library_item_id = save.data.id;
        if (!save.data.was_duplicate) saved_library_ids.push(save.data.id);
      }
    }
    itemsWithLibRefs.push({
      name: it.name,
      qty_g: it.qty_g,
      kcal: it.kcal,
      protein_g: it.protein_g,
      carbs_g: it.carbs_g,
      fat_g: it.fat_g,
      fiber_g: it.fiber_g,
      per_100g: it.per_100g,
      source: library_item_id ? "db" : it.source,
      db_ref: library_item_id
        ? { source: "user_library", canonical_id: library_item_id }
        : it.db_ref,
      confidence: it.confidence,
      match_score: it.match_score,
    });
  }

  const { data: inserted, error } = await opts.supabase
    .from("food_log_entries")
    .insert({
      user_id: opts.userId,
      eaten_at: p.eaten_at,
      kind: "text",
      meal_slot: p.meal_slot,
      raw_input: { kind: "text", text: p.raw_text },
      items: itemsWithLibRefs,
      totals: p.totals,
      is_estimated: itemsWithLibRefs.some((it) => it.source === "llm"),
      status: "committed",
    })
    .select("id, eaten_at")
    .single();
  if (error || !inserted) {
    return { ok: false, error: { error: error?.message ?? "insert returned no row" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const date = utcDate((inserted as { eaten_at: string }).eaten_at);
  const day_totals = foodLogOwnsDailyLogs()
    ? await reaggregateDay(opts.supabase, opts.userId, date)
    : await sumFoodEntriesForDate(opts.supabase, opts.userId, date);

  return {
    ok: true,
    data: {
      entry_id: (inserted as { id: string }).id,
      meal_slot: p.meal_slot,
      eaten_at: p.eaten_at,
      item_count: itemsWithLibRefs.length,
      totals: p.totals,
      day_totals,
      date,
      saved_library_ids,
    },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// propose_meal_suggestions — Nora's suggestion engine call.
//
// Wraps the pure `suggestMeal` engine (lib/coach/nora-suggestions/suggest-meal.ts)
// with the I/O needed to ground it: loads (and refreshes if stale) the user's
// 90-day eating identity, computes remaining-macros for the day, derives the
// per-slot kcal+protein target via typedTargetsForAllSlots, looks up recent
// recipe-discovery saves for §9.6 boost, then calls the engine. Each surfaced
// suggestion is paired with a freshly-minted meal_log approval token so the
// UI card can offer one-tap "Log this" without a round-trip through
// propose_meal_log.
// ────────────────────────────────────────────────────────────────────────────

const SUGGESTION_CACHE_STALE_MS = 48 * 3_600_000;

type ProposeMealSuggestionsData = {
  suggestions: MealSuggestion[];
  tokens: string[];
  context: SuggestEngineOutput["context"];
  filter_stats: SuggestEngineOutput["filter_stats"];
};

export async function executeProposeMealSuggestions(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<ProposeMealSuggestionsData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  const slot = i.slot as MealSlot | undefined;
  if (!slot || !["breakfast", "lunch", "dinner", "snack"].includes(slot)) {
    return {
      ok: false,
      error: { error: "slot must be one of breakfast|lunch|dinner|snack" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const countRaw = typeof i.count === "number" ? Math.floor(i.count) : 3;
  const count = Math.max(2, Math.min(4, countRaw));
  const prefer_novelty = i.prefer_novelty === true;

  // 1. Load (and refresh if stale) eating identity + exclusions.
  const { data: prof } = await opts.supabase
    .from("profiles")
    .select("eating_identity_cache, dietary_exclusions")
    .eq("user_id", opts.userId)
    .single();
  let identity = (prof?.eating_identity_cache ?? null) as EatingIdentity | null;
  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
  const staleMs = identity?.generated_on
    ? Date.now() - new Date(identity.generated_on).getTime()
    : Infinity;
  if (!identity || staleMs > SUGGESTION_CACHE_STALE_MS) {
    identity = await composeEatingIdentity({ supabase: opts.supabase, userId: opts.userId, today });
    const { error: cacheWriteErr } = await opts.supabase
      .from("profiles")
      .update({ eating_identity_cache: identity })
      .eq("user_id", opts.userId);
    if (cacheWriteErr) console.error("[propose_meal_suggestions] cache write failed:", cacheWriteErr.message);
  }
  const exclusions =
    (prof?.dietary_exclusions as DietaryExclusions | null) ?? { tags: [], free_text: null, version: 1 };

  // 2. Remaining-macros for today = targets − sum of committed entries.
  const targets = await getTodayTargets(opts.supabase, opts.userId);
  const { data: todayEntries } = await opts.supabase
    .from("food_log_entries")
    .select("totals")
    .eq("user_id", opts.userId)
    .eq("status", "committed")
    .gte("eaten_at", `${today}T00:00:00Z`)
    .lte("eaten_at", `${today}T23:59:59Z`);
  const totals = (todayEntries ?? []).reduce(
    (
      acc: { kcal: number; protein_g: number; carbs_g: number; fat_g: number },
      r: { totals?: Partial<FoodMacros> | null },
    ) => ({
      kcal: acc.kcal + (r.totals?.kcal ?? 0),
      protein_g: acc.protein_g + (r.totals?.protein_g ?? 0),
      carbs_g: acc.carbs_g + (r.totals?.carbs_g ?? 0),
      fat_g: acc.fat_g + (r.totals?.fat_g ?? 0),
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
  // getTodayTargets uses `carb_g` (singular); the engine expects `carbs_g`.
  const remainingMacros = {
    kcal: Math.max(0, (targets?.kcal ?? 2400) - totals.kcal),
    protein_g: Math.max(0, (targets?.protein_g ?? 180) - totals.protein_g),
    carbs_g: Math.max(0, (targets?.carb_g ?? 240) - totals.carbs_g),
    fat_g: Math.max(0, (targets?.fat_g ?? 70) - totals.fat_g),
  };

  // 3. Per-slot target — use the typed helper (Task 10 fix: the plain
  //    targetsForAllSlots returns Record<MealSlot, number> and produces NaN
  //    when the engine reads .protein_g on it).
  const slotTargetsAll = targets
    ? typedTargetsForAllSlots(
        { kcal: targets.kcal, protein_g: targets.protein_g },
        targets.meal_ratios ?? DEFAULT_MEAL_RATIOS,
      )
    : null;
  const slotTargets = slotTargetsAll?.[slot] ?? { kcal: 600, protein_g: 45 };

  // 4. Recipe-discovery boost (§9.6) — recipes saved in last 7d via the
  //    recipe-discovery flow pin to rank 1.
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: recentRecipes } = await opts.supabase
    .from("user_food_items")
    .select("id, metadata, created_at")
    .eq("user_id", opts.userId)
    .gte("created_at", sevenDaysAgoIso);
  const newRecipeBoosts = ((recentRecipes ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>)
    .filter((r) => r.metadata && (r.metadata as { source?: string }).source === "recipe_discovery")
    .map((r) => ({ library_item_id: r.id, weight: 0.15 }));

  // 5. Engine call.
  const out = suggestMeal({
    slot,
    count,
    eatingIdentity: identity,
    exclusions,
    remainingMacros,
    slotTargets,
    preferNovelty: prefer_novelty,
    newRecipeBoosts,
  });

  if (out.error) {
    return {
      ok: false,
      error: { error: out.error, code: out.error },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // 6. Mint one meal_log approval token per surfaced suggestion. Embedded
  //    payload form (no chat_message_id ref) — these tokens are issued ahead
  //    of any "approve" message and are independent of the streaming
  //    assistant row.
  //
  //    v1 token TTL is 30min (inherited from approval-token.ts). Spec §8.1 specified
  //    24h for the tap-later UX; per-token TTL deferred to v2 (would require widening
  //    signApprovalToken's envelope + verifyApprovalToken to honor a per-token override).
  //    User-visible failure mode: card taps after 30min surface the standard
  //    "approval expired" message and the athlete re-asks Nora — same recovery as
  //    other propose/commit tools.
  //
  //    Payload shape MUST match MealLogPayload exactly — executeCommitMealLog reads
  //    p.totals, p.raw_text, p.eaten_at, and every per-item macro/source/db_ref field
  //    directly into the food_log_entries insert. Stub payloads ({name, qty_g, per_100g})
  //    would write undefined macros and NULL totals → broken aggregation.
  const eatenAtIso = new Date().toISOString();
  const tokens = out.suggestions.map((s) => {
    const items: ProposeMealLogItem[] = s.items.map((it) => {
      const m = macrosForQty(it.per_100g, it.qty_g);
      const libraryItemId = it.library_item_id ?? null;
      return {
        name: it.name,
        qty_g: it.qty_g,
        kcal: m.kcal,
        protein_g: m.protein_g,
        carbs_g: m.carbs_g,
        fat_g: m.fat_g,
        fiber_g: m.fiber_g,
        per_100g: it.per_100g,
        source: libraryItemId ? "db" : "llm",
        db_ref: libraryItemId
          ? { source: "user_library", canonical_id: libraryItemId }
          : null,
        confidence: null,
        match_score: null,
        library_item_id: libraryItemId,
      };
    });
    const payload: MealLogPayload = {
      items,
      meal_slot: slot,
      eaten_at: eatenAtIso,
      raw_text: "Logged via Nora suggestion",
      // daily_logs.calories_eaten is INTEGER — round kcal at the totals layer so
      // the downstream upsert doesn't 500 on a decimal (see reference memory
      // note: reference_daily_logs_calories_int).
      totals: {
        kcal: Math.round(s.total_macros.kcal),
        protein_g: s.total_macros.protein_g,
        carbs_g: s.total_macros.carbs_g,
        fat_g: s.total_macros.fat_g,
        fiber_g: s.total_macros.fiber_g,
      },
    };
    return signApprovalToken({
      userId: opts.userId,
      action: "meal_log",
      payload,
    });
  });

  return {
    ok: true,
    data: {
      suggestions: out.suggestions,
      tokens,
      context: out.context,
      filter_stats: out.filter_stats,
    },
    meta: {
      ms: Date.now() - t0,
      result_rows: out.suggestions.length,
      range_days: 0,
      truncated: false,
    },
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
  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
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

  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
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
  GET_WEEK_PRESCRIPTION_TOOL,
  PROPOSE_BLOCK_TOOL,
  COMMIT_BLOCK_TOOL,
  PROPOSE_CLOSE_BLOCK_TOOL,
  COMMIT_CLOSE_BLOCK_TOOL,
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
  SET_ROTATION_PRIORITY_LIFT_TOOL,
  APPLY_ROTATION_OVERRIDE_TOOL,
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
  GET_WEEK_PRESCRIPTION_TOOL,
  PROPOSE_WEEK_PLAN_TOOL,
  COMMIT_WEEK_PLAN_TOOL,
  PROPOSE_SESSION_TODAY_TOOL,
  COMMIT_SESSION_TODAY_TOOL,
  PROPOSE_SESSION_TEMPLATE_TOOL,
  COMMIT_SESSION_TEMPLATE_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
  SET_ROTATION_PRIORITY_LIFT_TOOL,
  APPLY_ROTATION_OVERRIDE_TOOL,
  QUERY_ENDURANCE_ACTIVITIES_TOOL,
  PROPOSE_ENDURANCE_WEEK_TOOL,
  COMMIT_ENDURANCE_WEEK_TOOL,
  SET_ENDURANCE_PHASE_TOOL,
  SET_ENDURANCE_DISCIPLINE_TOOL,
  SET_THRESHOLD_HR_TOOL,
  SET_FTP_TOOL,
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
  RESOLVE_FOOD_MACROS_TOOL,
  PROPOSE_MEAL_LOG_TOOL,
  COMMIT_MEAL_LOG_TOOL,
  PROPOSE_MEAL_SUGGESTIONS_TOOL,
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
