import { describe, it, expect } from "vitest";
import { assembleDay, type AssembleInput } from "@/lib/coach/strain/assemble";
import type { HrSample } from "@/lib/coach/strain/types";

const DAY0 = Date.parse("2026-08-11T00:00:00.000Z");
const SESSION_START = DAY0 + 9 * 3600_000;
const SESSION_S = 3000;

function allDay(bpm = 65): HrSample[] {
  return Array.from({ length: 720 }, (_, i) => ({ ts: DAY0 + i * 120_000, bpm }));
}

function mkInput(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    allDaySamples: allDay(),
    activities: [],
    workouts: [],
    hrRest: 55,
    hrMax: 183,
    rirTarget: 2,
    ...over,
  };
}

const SESSION_ACTIVITY = {
  external_id: "act-1",
  started_at: new Date(SESSION_START).toISOString(),
  duration_s: SESSION_S,
  device_id: "3491966227",
  activity_type: "strength_training",
  hr_samples: Array.from(
    { length: SESSION_S + 1 },
    (_, i) => [SESSION_START + i * 1000, 120] as [number, number],
  ),
};

const SESSION_WORKOUT = {
  workout_id: "w-1",
  startMs: SESSION_START + 120_000,
  endMs: SESSION_START + SESSION_S * 1000,
  exercises: [
    {
      name: "Deadlift (Barbell)",
      e1rm: 180,
      sets: [
        { kg: 140, reps: 5, warmup: false, rir: 2 },
        { kg: 140, reps: 5, warmup: false, rir: 2 },
      ],
    },
  ],
};

describe("assembleDay", () => {
  it("scores a bare living day above zero", () => {
    const r = assembleDay(mkInput());
    expect(r.load.baseline).toBeGreaterThan(0);
    expect(r.strain).toBeGreaterThan(0);
  });

  it("returns zero strain for a day with no data at all", () => {
    const r = assembleDay(mkInput({ allDaySamples: [] }));
    expect(r.strain).toBe(0);
  });

  it("adds mechanical load for a logged session", () => {
    const withLift = assembleDay(mkInput({ workouts: [SESSION_WORKOUT] }));
    const without = assembleDay(mkInput());
    expect(withLift.load.mechanical).toBeGreaterThan(0);
    expect(withLift.strain).toBeGreaterThan(without.strain);
  });

  it("excludes a scored activity's window from the baseline term", () => {
    const withActivity = assembleDay(
      mkInput({ activities: [SESSION_ACTIVITY], workouts: [SESSION_WORKOUT] }),
    );
    const bare = assembleDay(mkInput());
    expect(withActivity.load.baseline).toBeLessThan(bare.load.baseline);
    expect(withActivity.load.activity).toBeGreaterThan(0);
  });

  it("does not double-count the session hour", () => {
    // The activity's own span must be removed from baseline, so baseline plus
    // activity is strictly less than naively summing both over the same hour.
    const r = assembleDay(mkInput({ activities: [SESSION_ACTIVITY] }));
    const bare = assembleDay(mkInput());
    const naive = bare.load.baseline + r.load.activity;
    expect(r.load.baseline + r.load.activity).toBeLessThan(naive);
  });

  it("keeps an unmatched activity in the cardio term", () => {
    const r = assembleDay(mkInput({ activities: [SESSION_ACTIVITY] }));
    expect(r.load.activity).toBeGreaterThan(0);
    expect(r.keptActivityIds).toEqual(["act-1"]);
  });

  it("scores a logged session with no activity record — the fallback path", () => {
    const r = assembleDay(mkInput({ workouts: [SESSION_WORKOUT] }));
    expect(r.load.activity).toBe(0);
    expect(r.load.mechanical).toBeGreaterThan(0);
    expect(r.strain).toBeGreaterThan(assembleDay(mkInput()).strain);
  });

  it("leaves an activity with no HR stream inside the baseline", () => {
    // Nothing to score in the activity term, so its window must NOT be cut out
    // of baseline — that would delete the hour from the day entirely.
    const noHr = { ...SESSION_ACTIVITY, hr_samples: null };
    const r = assembleDay(mkInput({ activities: [noHr] }));
    const bare = assembleDay(mkInput());
    expect(r.load.activity).toBe(0);
    expect(r.load.baseline).toBeCloseTo(bare.load.baseline, 9);
  });

  it("reports superseded activities from cross-device dedup", () => {
    const band = { ...SESSION_ACTIVITY, external_id: "act-2", device_id: "cirqa-1" };
    const r = assembleDay(mkInput({ activities: [SESSION_ACTIVITY, band] }));
    expect(r.keptActivityIds).toHaveLength(1);
    expect(r.superseded).toHaveLength(1);
  });

  it("ranks a heavy lifting day above a quiet day, which is the whole point", () => {
    // Ordering only, deliberately — no magnitude threshold here. How FAR apart
    // the two land is a calibration property, and the constants are still the
    // provisional two-term fit (see constants.ts) in which baseline was a flat
    // +3.5 offset outside the log rather than a load term inside it. A full
    // day of ordinary living contributes ~83 TRIMP units against a hard
    // session's ~43 + ~13, so every day currently sits high on the flat part
    // of the curve and differences compress.
    //
    // The magnitude claim is asserted where the evidence lives:
    // scripts/audit-strain-calibration.mjs replays 61 labelled days through
    // the fitted constants and requires heavy sessions above 13 and living
    // days above 0. Repeating a weaker version of it here against unfitted
    // constants would only pin today's accident.
    const quiet = assembleDay(mkInput());
    const heavy = assembleDay(
      mkInput({ activities: [SESSION_ACTIVITY], workouts: [SESSION_WORKOUT] }),
    );
    expect(heavy.strain).toBeGreaterThan(quiet.strain);
  });
});
