// lib/coach/blocks/summary.ts
//
// Read-side payload for the Blocks tab monitor UI (Block Command Center).
// One module, two exports:
//
//   computeBlockPace     — pure OLS pace projection over per-week best values
//   assembleBlockSummary — Supabase-driven orchestrator; null = no active block
//
// The chart / pace points carry the block's COMPARISON VALUE matched to
// `training_blocks.target_metric` (Brzycki e1RM for 'e1rm' blocks, max raw
// working kg for 'working_weight' blocks — NULL metric defaults to
// working_weight per the 0041 grandfather rule). The field is named `e1rm`
// per the payload contract; treat it as "comparison value in kg".
//
// Timezone: the caller supplies `todayIso` (already keyed to the user's tz).
// All date math in here is pure UTC-day arithmetic on keyed YMD strings —
// no live-clock reads (audit-timezone-usage gate).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift, TargetMetric, TrainingBlock, TrainingWeek } from "@/lib/data/types";
import type { BlockPhase } from "@/lib/coach/prescription/types";
import { olsSlope } from "@/lib/coach/trends/linear-regression";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import { PRIMARY_LIFT_NAME_PATTERNS } from "@/lib/coach/prescription/current-comparison-value";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { getEffectiveSessionPlan } from "@/lib/coach/sessionPlans";

// ── pure pace projection ─────────────────────────────────────────────────

export function computeBlockPace(
  points: Array<{ week: number; e1rm: number }>,
  target: number | null,
  totalWeeks: number,
): { currentBest: number | null; slopePerWeek: number | null; projectedHitWeek: number | null; kgToGo: number | null } {
  if (points.length === 0) return { currentBest: null, slopePerWeek: null, projectedHitWeek: null, kgToGo: null };
  const last = points[points.length - 1];
  const currentBest = last.e1rm;

  // When target is null (grandfathered blocks), compute slope but return null pace fields.
  if (target == null) {
    if (points.length < 2) return { currentBest, slopePerWeek: null, projectedHitWeek: null, kgToGo: null };
    const slope = olsSlope(points.map((p) => ({ x: p.week, y: p.e1rm })));
    return { currentBest, slopePerWeek: slope, projectedHitWeek: null, kgToGo: null };
  }

  const kgToGo = Math.max(0, target - currentBest);
  if (points.length < 2) return { currentBest, slopePerWeek: null, projectedHitWeek: null, kgToGo };
  const slope = olsSlope(points.map((p) => ({ x: p.week, y: p.e1rm })));
  if (slope == null || slope <= 0) return { currentBest, slopePerWeek: slope, projectedHitWeek: null, kgToGo };
  if (currentBest >= target) return { currentBest, slopePerWeek: slope, projectedHitWeek: last.week, kgToGo: 0 };
  const projected = Math.ceil(last.week + (target - currentBest) / slope);
  return { currentBest, slopePerWeek: slope, projectedHitWeek: Math.min(projected, totalWeeks + 3), kgToGo };
}

// ── payload types ────────────────────────────────────────────────────────

export type BlockSummaryPace = ReturnType<typeof computeBlockPace>;

export type BlockSummaryNextSession = {
  /** Full weekday name ("Monday"…"Sunday"). */
  weekday: string;
  /** Session type from the committed session_plan (e.g. "Legs"). */
  type: string;
  exercises: Array<{ name: string; kg: number | null; reps: number | null; sets: number | null }>;
} | null;

export type BlockSummaryPayload = {
  block: {
    id: string;
    goal_text: string;
    primary_lift: PrimaryLift | null;
    target_metric: TargetMetric | null;
    target_value: number | null;
    target_hit_at_week: number | null;
    start_date: string;
    end_date: string;
  };
  /** 1-based week index within the block for `todayIso` (clamped ≥ 1). */
  weekNum: number;
  totalWeeks: number;
  phase: BlockPhase;
  pace: BlockSummaryPace;
  /** Per-block-week max comparison value for the primary lift (metric-aware;
   *  field named e1rm per the payload contract). Weeks without sets are
   *  omitted — absence is the signal. */
  chart: Array<{ week: number; e1rm: number }>;
  thisWeek: {
    rir: number | null;
    /** Per-lift intensity modifier map from the committed week (empty when
     *  no week row). */
    intensity: Partial<Record<PrimaryLift, number>>;
    /** Distinct workout dates logged in [weekMonday, todayIso]. */
    sessionsDone: number;
    /** Non-REST entries in the committed session_plan (Mobility counts —
     *  it is a planned session). 0 when no committed week. */
    sessionsPlanned: number;
    nextSession: BlockSummaryNextSession;
  };
  /** Non-focus primary lifts: max non-warmup working kg over the last 14
   *  days. `clampHeld` is null in v1 — the block-outcomes clamp evaluator is
   *  inline in generateBlockOutcome and not importable without refactor. */
  secondaries: Array<{ lift: PrimaryLift; kg: number | null; clampHeld: boolean | null }>;
};

// ── Supabase-driven orchestrator ─────────────────────────────────────────

type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null };
type RawExercise = { name: string; exercise_sets: RawSet[] | null };
type RawWorkout = { date: string; exercises: RawExercise[] | null };

const ALL_PRIMARY_LIFTS: PrimaryLift[] = ["squat", "bench", "deadlift", "ohp"];
const SECONDARIES_WINDOW_DAYS = 14;
const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function assembleBlockSummary(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<BlockSummaryPayload | null> {
  const { supabase, userId, todayIso } = opts;

  const { data: blockRow, error: blockErr } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (blockErr) throw blockErr;
  const block = blockRow as TrainingBlock | null;
  if (!block) return null;

  const weekMonday = mondayOnOrBefore(todayIso);

  // One workouts fetch covers the chart (block window) AND the secondaries
  // (last-14d window, which can start before a young block's start_date).
  const fetchFrom = minIso(block.start_date, addDaysIso(todayIso, -SECONDARIES_WINDOW_DAYS));
  const [{ data: workoutRows, error: wErr }, { data: weekRow, error: twErr }] = await Promise.all([
    supabase
      .from("workouts")
      .select("date, exercises(name, exercise_sets(kg, reps, warmup))")
      .eq("user_id", userId)
      .gte("date", fetchFrom)
      .lte("date", todayIso)
      .order("date", { ascending: true }),
    supabase
      .from("training_weeks")
      .select("session_plan, exercise_overrides, session_prescriptions, rir_target, intensity_modifier")
      .eq("user_id", userId)
      .eq("week_start", weekMonday)
      .maybeSingle(),
  ]);
  if (wErr) throw wErr;
  if (twErr) throw twErr;
  const workouts = (workoutRows ?? []) as unknown as RawWorkout[];
  const week = (weekRow ?? null) as Pick<
    TrainingWeek,
    "session_plan" | "exercise_overrides" | "session_prescriptions" | "rir_target" | "intensity_modifier"
  > | null;

  // ── chart: per-block-week max comparison value for the primary lift ──
  const metric: TargetMetric = block.target_metric ?? "working_weight";
  const primaryNames = block.primary_lift
    ? new Set((PRIMARY_LIFT_NAME_PATTERNS[block.primary_lift] ?? []).map((n) => n.toLowerCase()))
    : new Set<string>();
  const weekMax = new Map<number, number>();
  for (const w of workouts) {
    if (w.date < block.start_date) continue; // secondaries-only window
    const weekN = blockWeekOf(block.start_date, w.date);
    for (const ex of w.exercises ?? []) {
      if (!primaryNames.has(ex.name.toLowerCase())) continue;
      const best = bestComparisonValue(ex.exercise_sets ?? [], metric);
      if (best == null) continue;
      weekMax.set(weekN, Math.max(weekMax.get(weekN) ?? 0, best));
    }
  }
  const chart = Array.from(weekMax.entries())
    .map(([week, e1rm]) => ({ week, e1rm }))
    .sort((a, b) => a.week - b.week);

  const totalWeeks = Math.max(1, Math.round(daysBetween(block.start_date, block.end_date) / 7));
  const weekNum = Math.min(blockWeekOf(block.start_date, todayIso), totalWeeks);

  const pace = computeBlockPace(chart, block.target_value, totalWeeks);
  const phase = evaluateBlockPhase({
    block,
    currentWorkingKg: pace.currentBest,
    recentProgressionRatePerWeek: pace.slopePerWeek,
    todayIso,
  });

  // ── thisWeek ──
  const doneDates = new Set(workouts.filter((w) => w.date >= weekMonday).map((w) => w.date));
  const sessionsPlanned = week
    ? WEEKDAY_FULL.filter((d) => {
        const s = readSessionForDay(week.session_plan, d);
        return s != null && s.toUpperCase() !== "REST";
      }).length
    : 0;

  const nextSession = findNextSession({ week, todayIso, doneToday: doneDates.has(todayIso) });

  // ── secondaries: last-14d max non-warmup working kg per non-focus lift ──
  const secondariesFrom = addDaysIso(todayIso, -SECONDARIES_WINDOW_DAYS);
  const secondaries = ALL_PRIMARY_LIFTS.filter((l) => l !== block.primary_lift).map((lift) => {
    const names = new Set(PRIMARY_LIFT_NAME_PATTERNS[lift].map((n) => n.toLowerCase()));
    let kg: number | null = null;
    for (const w of workouts) {
      if (w.date < secondariesFrom) continue;
      for (const ex of w.exercises ?? []) {
        if (!names.has(ex.name.toLowerCase())) continue;
        const best = bestComparisonValue(ex.exercise_sets ?? [], "working_weight");
        if (best != null && (kg == null || best > kg)) kg = best;
      }
    }
    return { lift, kg, clampHeld: null };
  });

  return {
    block: {
      id: block.id,
      goal_text: block.goal_text,
      primary_lift: block.primary_lift,
      target_metric: block.target_metric,
      target_value: block.target_value,
      target_hit_at_week: block.target_hit_at_week,
      start_date: block.start_date,
      end_date: block.end_date,
    },
    weekNum,
    totalWeeks,
    phase,
    pace,
    chart,
    thisWeek: {
      rir: week?.rir_target ?? null,
      intensity: week?.intensity_modifier ?? {},
      sessionsDone: doneDates.size,
      sessionsPlanned,
      nextSession,
    },
    secondaries,
  };
}

// ── helpers (pure UTC-day arithmetic on keyed YMD strings) ───────────────

function findNextSession(opts: {
  week: Pick<TrainingWeek, "session_plan" | "exercise_overrides" | "session_prescriptions"> | null;
  todayIso: string;
  doneToday: boolean;
}): BlockSummaryNextSession {
  const { week, todayIso, doneToday } = opts;
  if (!week) return null;
  // Walk today (skipped when already logged) → Sunday of the current week.
  const todayDow = dayOfWeek(todayIso); // 0=Sun..6=Sat
  const daysLeftInWeek = todayDow === 0 ? 0 : 7 - todayDow; // Mon-keyed week ends Sunday
  for (let offset = doneToday ? 1 : 0; offset <= daysLeftInWeek; offset++) {
    const iso = addDaysIso(todayIso, offset);
    const weekday = WEEKDAY_FULL[dayOfWeek(iso)];
    const type = readSessionForDay(week.session_plan, weekday);
    if (!type || type.toUpperCase() === "REST") continue;
    const plan = getEffectiveSessionPlan(
      type,
      weekday,
      week.session_prescriptions,
      week.exercise_overrides,
      null,
    );
    return {
      weekday,
      type,
      exercises: plan.map((ex) => ({
        name: ex.name,
        kg: ex.baseKg ?? null,
        reps: ex.baseReps ?? null,
        sets: ex.sets ?? null,
      })),
    };
  }
  return null;
}

/** 1-based week index of `dateIso` within a block starting `startIso`. */
function blockWeekOf(startIso: string, dateIso: string): number {
  return Math.max(1, Math.floor(daysBetween(startIso, dateIso) / 7) + 1);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + "T00:00:00Z").getTime();
  const to = new Date(toIso + "T00:00:00Z").getTime();
  return Math.floor((to - from) / 86_400_000);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z"); // noon = DST-safe day walk
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0=Sunday..6=Saturday for a keyed YMD string (pure calendar math — the
 *  string is already in the user's tz, so no tz conversion is needed). */
function dayOfWeek(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

/** Monday on or before `iso` (training_weeks.week_start is Monday-keyed). */
function mondayOnOrBefore(iso: string): string {
  const dow = dayOfWeek(iso); // Sun=0 → back 6; Mon=1 → back 0; Sat=6 → back 5
  return addDaysIso(iso, -((dow + 6) % 7));
}

function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}
