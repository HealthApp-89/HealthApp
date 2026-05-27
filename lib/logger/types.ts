import type { PlannedExercise } from "@/lib/coach/sessionPlans";

/**
 * In-flight set during a logger session, before commit.
 * `committed_at` is set when the user taps ✓; null while pending.
 */
export type ExerciseSetDraft = {
  set_index: number;
  kg: number | null;
  reps: number | null;
  /** Actual seconds achieved for time-based exercises (foam rolls, planks,
   *  dead hangs, etc.). Set on Stop tap; null for rep-based sets and for
   *  any time-based set the user hasn't yet started. */
  duration_seconds: number | null;
  warmup: boolean;
  failure: boolean;
  committed_at: string | null; // ISO timestamp on ✓
  /** Carried across edit cycles: the timer-recorded rest before this set
   *  when re-committing an edited workout. Undefined on fresh logger sessions
   *  (computed from committed_at deltas at commit time). */
  rest_seconds_actual?: number | null;
};

/**
 * In-flight exercise in a logger session. `sets` may include uncommitted rows.
 */
export type ExerciseDraft = {
  name: string;
  position: number;
  /** Snapshot of the prescribed plan for this exercise (for "did it diverge?" check). */
  prescribed: PlannedExercise;
  sets: ExerciseSetDraft[];
};

export type LoggerDraft = {
  user_id: string;
  session_type: string;
  date: string;           // YYYY-MM-DD
  /** Preserved across edit cycles: the original workout's recorded duration.
   *  Set by `hydrateWorkoutAsDraft`. Fresh logger sessions leave this
   *  undefined — `commitNow` then derives duration from elapsed timer. */
  duration_min?: number | null;
  started_at: string;     // ISO timestamp at sheet open; anchors elapsed timer
  updated_at: string;     // ISO timestamp on every change
  /** ISO timestamp when timer was paused; null = running. */
  paused_at: string | null;
  /** Total ms accumulated across previously-completed pause intervals. */
  paused_ms_total: number;
  exercises: ExerciseDraft[];
  /** Resolved-plan exercise list at sheet open, for divergence detection. */
  resolved_plan: PlannedExercise[];
  /** Client-generated UUID; reused across commit retries for idempotency. */
  external_id: string;
};

/**
 * Wire shape sent to /api/logger/session.
 */
export type CommitSessionPayload = {
  user_id: string;
  external_id: string;
  date: string;
  type: string;
  duration_min: number | null;
  exercises: {
    name: string;
    position: number;
    sets: {
      set_index: number;
      kg: number | null;
      reps: number | null;
      duration_seconds: number | null;
      warmup: boolean;
      failure: boolean;
      rest_seconds_actual: number | null;
    }[];
  }[];
};
