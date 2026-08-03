import { describe, expect, it } from "vitest";
import { setAdherenceFor, IGNORED_EXPOSURES_LIMIT } from "@/lib/coach/prescription/volume-adherence";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

/** n non-warmup sets of the named exercise on the given date. */
function session(date: string, n: number, name = "Leg Extension (Machine)"): WorkoutSetSample[] {
  return Array.from({ length: n }, () => ({
    exercise_name: name,
    exercise_key: null,
    kg: 40,
    reps: 12,
    warmup: false,
    failure: false,
    performed_on: date,
    rir: 2,
  }));
}

describe("setAdherenceFor", () => {
  it("reports zero ignored exposures when nothing was prescribed", () => {
    const out = setAdherenceFor("Leg Extension (Machine)", null, session("2026-08-01", 3), "2026-08-03");
    expect(out.ignoredExposures).toBe(0);
    expect(out.prescribed).toBeNull();
  });

  it("counts consecutive sessions that fell short of the prescription", () => {
    const sets = [...session("2026-08-01", 3), ...session("2026-07-25", 3), ...session("2026-07-18", 3)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(3);
    expect(out.realizedMedian).toBe(3);
  });

  it("stops counting at the first session that met the prescription", () => {
    // Newest-first: 3 (short), 4 (met) → stops at 1.
    const sets = [...session("2026-08-01", 3), ...session("2026-07-25", 4), ...session("2026-07-18", 3)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(1);
  });

  it("returns zero ignored exposures when the prescription is being met", () => {
    const sets = [...session("2026-08-01", 4), ...session("2026-07-25", 4)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(0);
    expect(out.realizedMedian).toBe(4);
  });

  it("returns nulls and zero when the exercise has no recent sets", () => {
    const out = setAdherenceFor("Leg Extension (Machine)", 4, [], "2026-08-03");
    expect(out.realizedMedian).toBeNull();
    expect(out.ignoredExposures).toBe(0);
  });

  it("excludes warmup sets and other exercises from the per-session count", () => {
    const sets = [
      ...session("2026-08-01", 3),
      { ...session("2026-08-01", 1)[0], warmup: true },
      ...session("2026-08-01", 2, "Seated Row (Machine)"),
    ];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.realizedMedian).toBe(3);
    expect(out.ignoredExposures).toBe(1);
  });

  it("excludes sessions outside the 28-day window", () => {
    const sets = [...session("2026-07-05", 3)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(0);
    expect(out.realizedMedian).toBeNull();
  });

  it("exposes the limit the engine gates on", () => {
    expect(IGNORED_EXPOSURES_LIMIT).toBe(2);
  });
});
