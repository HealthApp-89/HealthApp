import { describe, it, expect } from "vitest";
import {
  activityWindow,
  activityTrimp,
  resolveHrSource,
  toHrSamples,
  type ActivityInput,
} from "@/lib/coach/strain/activity-load";
import { banisterOverIntervals } from "@/lib/coach/strain/trimp";

const T0 = Date.parse("2026-08-11T08:52:48.000Z");

function mkActivity(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    external_id: "23933506849",
    started_at: new Date(T0).toISOString(),
    duration_s: 3016,
    device_id: "3491966227",
    activity_type: "strength_training",
    hr_samples: Array.from({ length: 3017 }, (_, i) => [T0 + i * 1000, 98] as [number, number]),
    ...over,
  };
}

describe("activityWindow", () => {
  it("spans started_at through started_at + duration", () => {
    const w = activityWindow(mkActivity());
    expect(w.startMs).toBe(T0);
    expect(w.endMs).toBe(T0 + 3016 * 1000);
  });

  it("never produces an inverted window for a zero-duration record", () => {
    const w = activityWindow(mkActivity({ duration_s: 0 }));
    expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
  });
});

describe("activityTrimp", () => {
  it("returns 0 when the activity carries no HR stream", () => {
    expect(activityTrimp(mkActivity({ hr_samples: null }), 50, 183)).toBe(0);
    expect(activityTrimp(mkActivity({ hr_samples: [] }), 50, 183)).toBe(0);
  });

  it("equals a direct Banister walk over its samples", () => {
    const a = mkActivity();
    expect(activityTrimp(a, 50, 183)).toBeCloseTo(
      banisterOverIntervals(toHrSamples(a.hr_samples), 50, 183),
      9,
    );
  });

  it("scores a hard session above an easy one of equal length", () => {
    const easy = mkActivity({
      hr_samples: Array.from({ length: 1801 }, (_, i) => [T0 + i * 1000, 95] as [number, number]),
    });
    const hard = mkActivity({
      hr_samples: Array.from({ length: 1801 }, (_, i) => [T0 + i * 1000, 150] as [number, number]),
    });
    expect(activityTrimp(hard, 50, 183)).toBeGreaterThan(activityTrimp(easy, 50, 183));
  });

  it("captures a spike that 2-minute sampling would alias away", () => {
    // 30 min: 150 bpm for 40 s of every 3 min, 75 bpm otherwise — a lifting set
    // pattern. Sampled at 1 s it registers; sampled every 2 min it may not.
    const dense: Array<[number, number]> = [];
    for (let s = 0; s <= 1800; s++) {
      const phase = s % 180;
      dense.push([T0 + s * 1000, phase < 40 ? 150 : 75]);
    }
    const sparse = dense.filter((_, i) => i % 120 === 60); // samples land in the rest phase
    const denseTrimp = activityTrimp(mkActivity({ hr_samples: dense }), 50, 183);
    const sparseTrimp = activityTrimp(mkActivity({ hr_samples: sparse }), 50, 183);
    expect(denseTrimp).toBeGreaterThan(sparseTrimp);
  });
});

describe("resolveHrSource", () => {
  it("maps a known device", () => {
    expect(resolveHrSource("3491966227")).toBe("wrist");
  });

  it("returns unknown for an unmapped or absent device", () => {
    expect(resolveHrSource("999999")).toBe("unknown");
    expect(resolveHrSource(null)).toBe("unknown");
  });
});

describe("toHrSamples", () => {
  it("returns an empty array for null", () => {
    expect(toHrSamples(null)).toEqual([]);
  });

  it("drops pairs with a null or non-finite bpm", () => {
    const raw = [
      [1000, 60],
      [2000, null],
      [3000, 70],
    ] as unknown as Array<[number, number]>;
    expect(toHrSamples(raw)).toEqual([
      { ts: 1000, bpm: 60 },
      { ts: 3000, bpm: 70 },
    ]);
  });

  it("sorts by timestamp", () => {
    const raw: Array<[number, number]> = [
      [3000, 70],
      [1000, 60],
    ];
    expect(toHrSamples(raw).map((s) => s.ts)).toEqual([1000, 3000]);
  });
});
