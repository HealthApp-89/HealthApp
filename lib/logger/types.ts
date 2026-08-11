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
  /** Reps in reserve the athlete left on this set (0 = to failure). null =
   *  not recorded. Effort signal for the effort-adjusted e1RM debrief. */
  rir: number | null;
  committed_at: string | null; // ISO timestamp on ✓
  /** Carried across edit cycles: the timer-recorded rest before this set
   *  when re-committing an edited workout. Undefined on fresh logger sessions
   *  (computed from committed_at deltas at commit time). */
  rest_seconds_actual?: number | null;
  /** True set start (logger countdown end), ISO. Undefined/null when the set
   *  was not timed — hand-logged sets and pre-0056 hydrated rows. */
  started_at?: string | null;
  /** Honest time under load in seconds, phone lag already deducted. */
  work_seconds?: number | null;
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
  /** Athlete's manual rest override for this exercise, in seconds. Applies to
   *  every set of the exercise for the rest of the session. Null/undefined =
   *  use the tier prescription from annotateSession.
   *
   *  Lives on the draft rather than in ExerciseCard state because two places
   *  need it: the card's "+ Add set (m:ss)" label and LoggerSheet's
   *  `press_stop`, which seeds the rest countdown. Holding it in both meant
   *  keeping two copies agreeing across every list edit — a card's `key`
   *  embeds its index AND its name, so Remove, Reorder and Replace all remount
   *  it and silently reset the local half. Carrying the value on the exercise
   *  entry makes the two agree by construction, and lets an override survive a
   *  reorder instead of being dropped to stay consistent.
   *
   *  Draft-only: not sent to commit_logger_session and not persisted past the
   *  session, so it can never shadow a future change to the engine's values. */
  rest_override_seconds?: number | null;
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
  /** Preserved across edit cycles: the original workout's recorded started_at.
   *  Set by `hydrateWorkoutAsDraft` (may be null for pre-0053 rows). Fresh
   *  logger sessions leave this undefined — `commitNow` then sends
   *  `started_at` (the Start Session tap). */
  session_started_at?: string | null;
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
  /** Docked timer state, mirrored to IndexedDB so a reload mid-set resumes the
   *  running clock. Anchors are absolute epoch ms, so resume is exact.
   *  Optional so drafts written before the docked timer still load. */
  timer?: import("@/lib/logger/set-timer").TimerState | null;
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
  /** ISO timestamp of the latest "Start session" tap; edits preserve the
   *  original workout's value. Written to workouts.started_at. */
  started_at: string | null;
  exercises: {
    name: string;
    position: number;
    /** Superset tag when this exercise was performed back-to-back with its
     *  neighbours; null when performed alone. See migration 0057 for what it
     *  tells a reader about work_seconds and rest_seconds_actual. */
    superset_group: string | null;
    sets: {
      set_index: number;
      kg: number | null;
      reps: number | null;
      duration_seconds: number | null;
      warmup: boolean;
      failure: boolean;
      rir: number | null;
      rest_seconds_actual: number | null;
      started_at: string | null;
      work_seconds: number | null;
    }[];
  }[];
};
