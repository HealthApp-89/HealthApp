// lib/coach/interventions/detect-inferred.ts
//
// Pure function: scans a completed workout series inside a training block and
// emits InferredCandidate objects for events the athlete never narrated to the
// coach (mid-block load drops, exercise substitutions).
//
// Design rules:
//   1. SORT INPUTS INTERNALLY — never trust caller ordering (Phase 1 lesson).
//   2. Every candidate MUST route through classifyDeload / classifySwap from
//      classify-strength.ts. A planned event (deload_week drop, block-boundary
//      rotation) must never produce a candidate.
//   3. Nutrition: NOT inferred in v1. Only strength events here.
//   4. Pure function — no I/O, safe to call in tests.

import type { WorkoutSession } from "@/lib/data/workouts";
import type { TrainingBlock } from "@/lib/data/types";
import type { BlockContext } from "./types";
import type { InterventionKind } from "./types";
import { classifyDeload, classifySwap, DELOAD_MIN_DROP_PCT } from "./classify-strength";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A candidate inferred from workout history — source is set to "inferred" by
 *  the caller (Task 6 scanner). `context` shape varies per kind:
 *  - reactive_deload: BlockContext + deload_depth_pct + trigger
 *  - exercise_swap:   BlockContext + from_exercise + to_exercise + reason */
export type InferredCandidate = {
  kind: InterventionKind;
  started_on: string; // ISO YYYY-MM-DD of the first workout that evidences the change
  context: Record<string, unknown>;
};

export type DetectInferredOpts = {
  /** Workout sessions to scan. Order is unimportant — sorted internally. */
  workouts: WorkoutSession[];
  /** The active training block for context. */
  block: TrainingBlock;
  /** Primary-lift exercise name as it appears in workouts (e.g. "Deadlift (Barbell)").
   *  Used for load-drop detection. */
  primaryLift: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** A mid-block load drop must be this fraction or larger to be flagged. Mirrors
 *  DELOAD_MIN_DROP_PCT from classify-strength so the threshold is single-source. */
const LOAD_DROP_THRESHOLD = DELOAD_MIN_DROP_PCT;

// ── Main export ───────────────────────────────────────────────────────────────

/** Scan a block's workout history for inferred reactive interventions.
 *  Returns an empty array for empty input — never throws. */
export function detectInferredInterventions(opts: DetectInferredOpts): InferredCandidate[] {
  if (opts.workouts.length === 0) return [];

  // Step 1 — sort by date ascending (never trust caller order)
  const sorted = [...opts.workouts].sort((a, b) => a.date.localeCompare(b.date));

  // Step 2 — bucket workouts into block-week indices
  const weeks = bucketByBlockWeek(sorted, opts.block);
  const weekNumbers = [...weeks.keys()].sort((a, b) => a - b);

  if (weekNumbers.length === 0) return [];

  const candidates: InferredCandidate[] = [];

  // Step 3 — reactive_deload detection
  const deloadCandidates = detectReactiveDeload(weeks, weekNumbers, opts);
  candidates.push(...deloadCandidates);

  // Step 4 — exercise_swap detection (per-session-type)
  const swapCandidates = detectExerciseSwaps(weeks, weekNumbers, opts);
  candidates.push(...swapCandidates);

  // Step 5 — sort final output by started_on ascending
  return candidates.sort((a, b) => a.started_on.localeCompare(b.started_on));
}

// ── Reactive deload detector ───────────────────────────────────────────────────

function detectReactiveDeload(
  weeks: Map<number, WorkoutSession[]>,
  weekNumbers: number[],
  opts: DetectInferredOpts,
): InferredCandidate[] {
  const candidates: InferredCandidate[] = [];
  const target_metric = opts.block.target_metric ?? "working_weight";

  // Compute per-week primary-lift best comparison value
  const weekValues = new Map<number, { value: number; firstDate: string }>();
  for (const wn of weekNumbers) {
    const sessions = weeks.get(wn)!;
    // Collect all working sets for the primary lift across this week's sessions
    const allSets = collectPrimaryLiftSets(sessions, opts.primaryLift);
    const val = bestComparisonValue(allSets, target_metric);
    if (val != null) {
      const firstDate = sessions[0].date;
      weekValues.set(wn, { value: val, firstDate });
    }
  }

  // Compare consecutive weeks that both have primary-lift data
  const dataWeeks = [...weekValues.keys()].sort((a, b) => a - b);
  for (let i = 1; i < dataWeeks.length; i++) {
    const prevWn = dataWeeks[i - 1];
    const currWn = dataWeeks[i];
    const prev = weekValues.get(prevWn)!;
    const curr = weekValues.get(currWn)!;

    // Load drop fraction: positive = dropped
    const loadDropPct = prev.value > 0 ? (prev.value - curr.value) / prev.value : 0;

    if (loadDropPct < LOAD_DROP_THRESHOLD) continue;

    // Determine block phase for the week of the drop using the first date in that week
    const dropDateIso = curr.firstDate;
    const weekPhase = evaluateBlockPhase({
      block: opts.block,
      currentWorkingKg: curr.value,
      // Use a simple progression rate estimate: change per week
      recentProgressionRatePerWeek: prev.value > 0 ? (curr.value - prev.value) : null,
      todayIso: dropDateIso,
    });

    // Route through the classifier — only emit if reactive
    const classification = classifyDeload({
      block: opts.block,
      weekPhase,
      loadDropPct,
      todayIso: dropDateIso,
    });

    if (classification !== "reactive") continue;

    const blockCtx: BlockContext = {
      block_id: opts.block.id,
      block_phase: weekPhase,
      block_week: currWn,
    };

    candidates.push({
      kind: "reactive_deload",
      started_on: dropDateIso,
      context: {
        ...blockCtx,
        deload_depth_pct: Math.round(loadDropPct * 1000) / 1000,
        trigger: "inferred",
      },
    });
  }

  return candidates;
}

// ── Exercise swap detector ─────────────────────────────────────────────────────

function detectExerciseSwaps(
  weeks: Map<number, WorkoutSession[]>,
  weekNumbers: number[],
  opts: DetectInferredOpts,
): InferredCandidate[] {
  const candidates: InferredCandidate[] = [];

  // Group sessions by session type (e.g. "Legs Day", "Deadlift Day")
  const sessionTypes = collectSessionTypes(weeks);

  for (const sessionType of sessionTypes) {
    // Build per-week exercise sets for this session type
    const weekExercises = new Map<number, Set<string>>();
    for (const wn of weekNumbers) {
      const sessions = (weeks.get(wn) ?? []).filter((s) => s.type === sessionType);
      if (sessions.length === 0) continue;
      const names = new Set<string>();
      for (const s of sessions) {
        for (const e of s.exercises) {
          names.add(e.name);
        }
      }
      weekExercises.set(wn, names);
    }

    const exerciseWeeks = [...weekExercises.keys()].sort((a, b) => a - b);
    if (exerciseWeeks.length < 2) continue;

    // Detect exercises that disappeared mid-block (present in at least one prior
    // week, absent in at least one later week, with a new exercise entering)
    for (let i = 1; i < exerciseWeeks.length; i++) {
      const prevWn = exerciseWeeks[i - 1];
      const currWn = exerciseWeeks[i];
      const prevExercises = weekExercises.get(prevWn)!;
      const currExercises = weekExercises.get(currWn)!;

      // Exercises that left
      const left = [...prevExercises].filter((e) => !currExercises.has(e));
      // Exercises that entered
      const entered = [...currExercises].filter((e) => !prevExercises.has(e));

      if (left.length === 0 || entered.length === 0) continue;

      // Block boundary: week 1 of the block would be isBoundaryWeek=true (block
      // starts at week 1; first inter-week comparison is week 1 → week 2, so
      // week 2 is NOT a boundary). isBoundaryWeek = true only when the *current*
      // week is the very first week of the block (week 1 → never a swap since
      // there's no prior week in block). Here currWn >= 2 always.
      // True block-boundary means the comparison is between the last week of the
      // prior block and the first week of this block. That case can't happen here
      // since all workouts are within the block. So isBoundaryWeek is always false.
      const isBoundaryWeek = false;

      // Get the first date of the current week (the swap date)
      const currSessions = (weeks.get(currWn) ?? []).filter((s) => s.type === sessionType);
      const swapDateIso = currSessions[0]?.date ?? weeks.get(currWn)![0].date;

      // Evaluate block phase for the swap week
      const weekPhase = evaluateBlockPhase({
        block: opts.block,
        currentWorkingKg: null,
        recentProgressionRatePerWeek: null,
        todayIso: swapDateIso,
      });

      // Pair each left exercise with the first entered exercise
      // (most common case: 1:1 swap; for multi-swaps emit one candidate per pair)
      const pairCount = Math.min(left.length, entered.length);
      for (let p = 0; p < pairCount; p++) {
        const fromExercise = left[p];
        const toExercise = entered[p];

        const classification = classifySwap({
          isBoundaryWeek,
          sameExercise: fromExercise === toExercise,
        });

        if (classification !== "reactive") continue;

        const blockCtx: BlockContext = {
          block_id: opts.block.id,
          block_phase: weekPhase,
          block_week: currWn,
        };

        candidates.push({
          kind: "exercise_swap",
          started_on: swapDateIso,
          context: {
            ...blockCtx,
            from_exercise: fromExercise,
            to_exercise: toExercise,
            reason: "boredom" as const, // inferred reason defaults to boredom; caller can override
          },
        });
      }
    }
  }

  return candidates;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Bucket workouts by block-week index (1-based). Workouts outside the block
 *  window are discarded. */
function bucketByBlockWeek(
  sorted: WorkoutSession[],
  block: TrainingBlock,
): Map<number, WorkoutSession[]> {
  const blockStart = new Date(block.start_date + "T00:00:00Z").getTime();
  const blockEnd = new Date(block.end_date + "T00:00:00Z").getTime();
  const result = new Map<number, WorkoutSession[]>();

  for (const w of sorted) {
    const dateMs = new Date(w.date + "T00:00:00Z").getTime();
    if (dateMs < blockStart || dateMs > blockEnd) continue;
    const dayOffset = Math.floor((dateMs - blockStart) / (24 * 60 * 60 * 1000));
    const weekNum = Math.floor(dayOffset / 7) + 1; // 1-based
    if (!result.has(weekNum)) result.set(weekNum, []);
    result.get(weekNum)!.push(w);
  }

  return result;
}

/** Collect all non-warmup sets for the primary lift across a week's sessions. */
function collectPrimaryLiftSets(
  sessions: WorkoutSession[],
  primaryLift: string,
): Array<{ kg: number | null; reps: number | null; warmup?: boolean | null }> {
  const sets: Array<{ kg: number | null; reps: number | null; warmup?: boolean | null }> = [];
  const normalizedTarget = primaryLift.toLowerCase();
  for (const s of sessions) {
    for (const e of s.exercises) {
      if (e.name.toLowerCase() !== normalizedTarget) continue;
      for (const set of e.sets) {
        sets.push({ kg: set.kg, reps: set.reps, warmup: set.warmup });
      }
    }
  }
  return sets;
}

/** Collect all distinct session types across all weeks. */
function collectSessionTypes(weeks: Map<number, WorkoutSession[]>): Set<string> {
  const types = new Set<string>();
  for (const sessions of weeks.values()) {
    for (const s of sessions) {
      if (s.type) types.add(s.type);
    }
  }
  return types;
}
