// lib/coach/live-session/types.ts
//
// Shapes for the between-sets coaching line. Pure data — no behaviour here.
// Spec: docs/superpowers/specs/2026-08-10-live-session-coaching-design.md

import type { ExerciseSetDraft, ExerciseDraft } from "@/lib/logger/types";
import type { WorkoutSetSample, BlockPhase } from "@/lib/coach/prescription/types";

export type CoachLineKind = "pr" | "guardrail" | "load_call";

export type CoachLine = {
  kind: CoachLineKind;
  /** Single sentence, no markdown. Target <= 90 chars. */
  text: string;
  /** Present only on load calls that name a new number. Tapping writes this
   *  into the next pending set's kg field. Absent when the call is "same
   *  weight" or when the exercise has no equipment grid. */
  apply_kg?: number;
  /** True only for PRs — the one line that also earns visual emphasis. */
  cue: boolean;
  /** Which rule produced this line. For tests and future observability. */
  rule: string;
};

/** A committed set anywhere in today's session, with its exercise name.
 *  The failure budget is a session-level count, not a per-exercise one. */
export type SessionSetRef = {
  exerciseName: string;
  set: ExerciseSetDraft;
};

export type LiveSessionContext = {
  /** Per exercise name (verbatim draft name): 28 days of prior sets, in the
   *  exact shape the weekly prescription engine consumes. */
  historyByExercise: Record<string, WorkoutSetSample[]>;
  /** Per exercise name: best Brzycki e1RM over a 180-day window. Null when
   *  there is no usable history — a first-ever entry is not a PR. */
  bestByExercise: Record<string, number | null>;
  blockPhase: BlockPhase;
  /** training_weeks.rir_target for the current week, `?? 2` applied by the
   *  fetcher — the same fallback expression prescribeWeek uses. */
  rirTarget: number;
};

export type LiveSetInput = {
  /** The set just committed. `committed_at` is already populated. */
  set: ExerciseSetDraft;
  /** Its exercise, including `prescribed: PlannedExercise`. */
  exercise: ExerciseDraft;
  /** ALL committed non-warmup sets this session INCLUDING the one above. */
  sessionSets: SessionSetRef[];
  context: LiveSessionContext;
};
