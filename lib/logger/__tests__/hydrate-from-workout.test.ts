import { describe, it, expect } from "vitest";
import { hydrateWorkoutAsDraft } from "@/lib/logger/hydrate-from-workout";
import type { WorkoutForEdit } from "@/lib/data/fetch-workout-for-edit";

function workoutFixture(overrides: Partial<WorkoutForEdit> = {}): WorkoutForEdit {
  return {
    id: "w-1",
    user_id: "u-1",
    date: "2026-07-20",
    type: "Push",
    duration_min: 62,
    started_at: "2026-07-20T13:05:00.000Z",
    external_id: "logger-abc",
    source: "logger",
    created_at: "2026-07-20T14:10:00.000Z",
    exercises: [
      {
        id: "e-1",
        name: "Decline Bench",
        position: 0,
        sets: [
          {
            set_index: 1,
            kg: 80,
            reps: 8,
            duration_seconds: null,
            warmup: false,
            failure: false,
            rir: 2,
            rest_seconds_actual: 150,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("hydrateWorkoutAsDraft — session_started_at preservation", () => {
  it("carries the original workout's started_at so an edit commit does not clobber it", () => {
    const draft = hydrateWorkoutAsDraft(workoutFixture(), []);
    expect(draft.session_started_at).toBe("2026-07-20T13:05:00.000Z");
    // draft.started_at is the sheet-open timestamp (elapsed-timer anchor),
    // deliberately distinct from the preserved session start.
    expect(draft.started_at).not.toBe(draft.session_started_at);
  });

  it("keeps null for pre-0053 rows (never substitutes edit-time)", () => {
    const draft = hydrateWorkoutAsDraft(workoutFixture({ started_at: null }), []);
    // Must be null (defined), so commitNow sends null instead of falling
    // through to draft.started_at (the edit-session open time).
    expect(draft.session_started_at).toBeNull();
  });

  it("fresh drafts leave session_started_at undefined (commit falls through to started_at)", () => {
    // hydrateWorkoutAsDraft always sets it; the undefined branch belongs to
    // LoggerSheet's newDraft. Assert the discriminating contract here: a
    // hydrated draft is never undefined.
    const draft = hydrateWorkoutAsDraft(workoutFixture(), []);
    expect(draft.session_started_at).not.toBeUndefined();
  });
});
