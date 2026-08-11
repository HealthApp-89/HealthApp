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
        superset_group: null,
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
            started_at: "2026-08-10T09:15:00.000Z",
            work_seconds: 33,
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

describe("hydrateWorkoutAsDraft — per-set timing preservation", () => {
  it("carries started_at and work_seconds from the saved set onto the draft", () => {
    const draft = hydrateWorkoutAsDraft(workoutFixture(), []);
    expect(draft.exercises[0].sets[0].started_at).toBe("2026-08-10T09:15:00.000Z");
    expect(draft.exercises[0].sets[0].work_seconds).toBe(33);
  });
});

describe("hydrateWorkoutAsDraft — superset grouping", () => {
  it("restores the saved tag onto prescribed", () => {
    const w = workoutFixture();
    w.exercises[0].superset_group = "A";
    const draft = hydrateWorkoutAsDraft(w, []);
    expect(draft.exercises[0].prescribed.superset).toBe("A");
  });

  it("leaves prescribed untagged for an exercise performed alone", () => {
    const draft = hydrateWorkoutAsDraft(workoutFixture(), []);
    expect(draft.exercises[0].prescribed.superset).toBeUndefined();
  });

  it("strips a tag today's plan carries when the saved row was performed alone", () => {
    // The half the "saved grouping wins" comment did not implement. `base`
    // comes from TODAY's resolveSessionPlan, so a pre-branch Arms workout
    // opened in edit mode would silently inherit today's pairing — and with
    // persistedGroupTags at the commit site, saving a typo'd rep would stamp
    // ten independent lifts as supersets.
    const draft = hydrateWorkoutAsDraft(workoutFixture(), [
      { name: "Decline Bench", sets: 3, baseReps: 8, superset: "C" },
    ]);
    expect(draft.exercises[0].prescribed.superset).toBeUndefined();
    // The rest of today's plan entry still applies — only the grouping is a
    // fact about the past.
    expect(draft.exercises[0].prescribed.sets).toBe(3);
  });

  it("prefers the saved tag over today's plan entry", () => {
    // The plan may have been re-paired since; this row records what happened.
    const w = workoutFixture();
    w.exercises[0].superset_group = "A";
    const draft = hydrateWorkoutAsDraft(w, [
      { name: "Decline Bench", sets: 3, baseReps: 8, superset: "C" },
    ]);
    expect(draft.exercises[0].prescribed.superset).toBe("A");
  });
});
