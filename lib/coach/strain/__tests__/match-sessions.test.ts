import { describe, it, expect } from "vitest";
import {
  dedupeActivities,
  matchActivityToWorkout,
  MATCH_TOLERANCE_MS,
  type WorkoutWindow,
} from "@/lib/coach/strain/match-sessions";
import type { ActivityInput } from "@/lib/coach/strain/activity-load";

const T0 = Date.parse("2026-08-11T09:00:00.000Z");

function mkActivity(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    external_id: "a1",
    started_at: new Date(T0).toISOString(),
    duration_s: 3000,
    device_id: "3491966227",
    activity_type: "strength_training",
    hr_samples: [
      [T0, 100],
      [T0 + 1000, 100],
    ],
    ...over,
  };
}

function mkWorkout(over: Partial<WorkoutWindow> = {}): WorkoutWindow {
  return { workout_id: "w1", startMs: T0, endMs: T0 + 3000 * 1000, ...over };
}

describe("matchActivityToWorkout", () => {
  it("matches when windows overlap and starts are close", () => {
    expect(matchActivityToWorkout(mkActivity(), [mkWorkout()])).toBe("w1");
  });

  it("absorbs the few-minute gap between starting the watch and the logger", () => {
    const w = mkWorkout({ startMs: T0 + 4 * 60_000 });
    expect(matchActivityToWorkout(mkActivity(), [w])).toBe("w1");
  });

  it("still matches when the athlete stops the activity late", () => {
    const a = mkActivity({ duration_s: 4500 });
    expect(matchActivityToWorkout(a, [mkWorkout()])).toBe("w1");
  });

  it("does not match a workout whose start is beyond the tolerance", () => {
    const w = mkWorkout({
      startMs: T0 + MATCH_TOLERANCE_MS + 60_000,
      endMs: T0 + MATCH_TOLERANCE_MS + 3000_000,
    });
    expect(matchActivityToWorkout(mkActivity(), [w])).toBeNull();
  });

  it("does not match when windows do not overlap at all", () => {
    const w = mkWorkout({ startMs: T0 - 3000 * 1000 - 1, endMs: T0 - 1 });
    expect(matchActivityToWorkout(mkActivity(), [w])).toBeNull();
  });

  it("returns null when there are no workouts", () => {
    expect(matchActivityToWorkout(mkActivity(), [])).toBeNull();
  });

  it("picks the nearest workout when two are candidates", () => {
    const near = mkWorkout({ workout_id: "near", startMs: T0 + 60_000 });
    const far = mkWorkout({ workout_id: "far", startMs: T0 + 20 * 60_000 });
    expect(matchActivityToWorkout(mkActivity(), [far, near])).toBe("near");
  });
});

describe("dedupeActivities", () => {
  it("keeps a single activity untouched", () => {
    const { kept, superseded } = dedupeActivities([mkActivity()]);
    expect(kept).toHaveLength(1);
    expect(superseded).toHaveLength(0);
  });

  it("keeps both when windows do not overlap", () => {
    const later = mkActivity({
      external_id: "a2",
      started_at: new Date(T0 + 6 * 3600_000).toISOString(),
    });
    expect(dedupeActivities([mkActivity(), later]).kept).toHaveLength(2);
  });

  it("keeps both when the same device recorded two overlapping records", () => {
    // Same device cannot double-record a session; overlapping same-device rows
    // are two genuine activities (e.g. a paused-and-resumed record).
    const b = mkActivity({ external_id: "a2", started_at: new Date(T0 + 60_000).toISOString() });
    expect(dedupeActivities([mkActivity(), b]).kept).toHaveLength(2);
  });

  it("collapses overlapping records from different devices", () => {
    const band = mkActivity({ external_id: "a2", device_id: "cirqa-1" });
    const { kept, superseded } = dedupeActivities([mkActivity(), band]);
    expect(kept).toHaveLength(1);
    expect(superseded).toHaveLength(1);
  });

  it("prefers the better sensor when devices disagree", () => {
    // Unmapped 'cirqa-1' resolves to unknown, which ranks below the mapped
    // wrist device — so the mapped one survives.
    const band = mkActivity({ external_id: "a2", device_id: "cirqa-1" });
    const { kept, superseded } = dedupeActivities([band, mkActivity()]);
    expect(kept[0].external_id).toBe("a1");
    expect(superseded[0]).toEqual({ external_id: "a2", superseded_by: "a1" });
  });

  it("breaks a sensor tie on sample density", () => {
    const sparse = mkActivity({
      external_id: "sparse",
      device_id: "dev-x",
      hr_samples: [[T0, 100]],
    });
    const dense = mkActivity({
      external_id: "dense",
      device_id: "dev-y",
      hr_samples: Array.from({ length: 500 }, (_, i) => [T0 + i * 1000, 100] as [number, number]),
    });
    expect(dedupeActivities([sparse, dense]).kept[0].external_id).toBe("dense");
  });

  it("is deterministic regardless of input order", () => {
    const band = mkActivity({ external_id: "a2", device_id: "cirqa-1" });
    const forward = dedupeActivities([mkActivity(), band]).kept[0].external_id;
    const reverse = dedupeActivities([band, mkActivity()]).kept[0].external_id;
    expect(forward).toBe(reverse);
  });

  it("points a chain-superseded record at the eventual winner, not a middle one", () => {
    // Three devices, one real session. Processed in external_id order, the
    // mid-quality record wins against the worst and then loses to the best.
    // The first loser must still name the SURVIVOR — superseded_by is
    // documented as naming the activity that won, and a pointer to something
    // itself superseded makes the audit trail require a walk nobody performs.
    const stream = (n: number): Array<[number, number]> =>
      Array.from({ length: n }, (_, i) => [T0 + i * 1000, 110] as [number, number]);
    const worst = mkActivity({ external_id: "a", device_id: "d3", hr_samples: stream(100) });
    const middle = mkActivity({ external_id: "b", device_id: "d2", hr_samples: stream(200) });
    const best = mkActivity({ external_id: "c", device_id: "d1", hr_samples: stream(300) });

    const { kept, superseded } = dedupeActivities([worst, middle, best]);
    expect(kept.map((k) => k.external_id)).toEqual(["c"]);
    expect(superseded).toHaveLength(2);
    for (const entry of superseded) expect(entry.superseded_by).toBe("c");
  });
});
