import { describe, it, expect } from "vitest";
import {
  rawTonnage,
  muscleFactor,
  intensityFactor,
  rirFactor,
  combinedFactor,
  mechanicalLoad,
  type MechanicalExercise,
} from "@/lib/coach/strain/mechanical-load";

function ex(
  name: string,
  sets: Array<{ kg: number; reps: number; warmup?: boolean; rir?: number | null }>,
  e1rm: number | null = null,
): MechanicalExercise {
  return {
    name,
    e1rm,
    sets: sets.map((s) => ({
      kg: s.kg,
      reps: s.reps,
      warmup: s.warmup ?? false,
      rir: s.rir ?? null,
    })),
  };
}

describe("rawTonnage", () => {
  it("sums kg × reps over working sets", () => {
    expect(rawTonnage([ex("Squat (Barbell)", [{ kg: 100, reps: 5 }, { kg: 100, reps: 5 }])])).toBe(1000);
  });

  it("excludes warmup sets — the fit was performed on working sets only", () => {
    expect(
      rawTonnage([ex("Squat (Barbell)", [{ kg: 60, reps: 5, warmup: true }, { kg: 100, reps: 5 }])]),
    ).toBe(500);
  });

  it("treats null kg or reps as zero rather than throwing", () => {
    const e: MechanicalExercise = {
      name: "Plank",
      e1rm: null,
      sets: [{ kg: null, reps: null, warmup: false, rir: null }],
    };
    expect(rawTonnage([e])).toBe(0);
  });

  it("is 0 for no exercises", () => {
    expect(rawTonnage([])).toBe(0);
  });
});

describe("muscleFactor", () => {
  it("weights a large-muscle compound above a small-muscle isolation", () => {
    expect(muscleFactor("Deadlift (Barbell)")).toBeGreaterThan(muscleFactor("Bicep Curl (Dumbbell)"));
  });

  it("returns a neutral 1 for an unmapped exercise name", () => {
    expect(muscleFactor("Completely Invented Movement 9000")).toBe(1);
  });

  it("stays inside ±15% so it redistributes rather than rescales", () => {
    for (const n of ["Deadlift (Barbell)", "Bicep Curl (Dumbbell)", "Unknown Thing"]) {
      expect(muscleFactor(n)).toBeGreaterThanOrEqual(0.85);
      expect(muscleFactor(n)).toBeLessThanOrEqual(1.15);
    }
  });
});

describe("intensityFactor", () => {
  it("is neutral when no e1RM history exists", () => {
    expect(intensityFactor(100, null)).toBe(1);
    expect(intensityFactor(100, 0)).toBe(1);
  });

  it("rewards load near the athlete's ceiling", () => {
    expect(intensityFactor(180, 200)).toBeGreaterThan(intensityFactor(80, 200));
  });

  it("floors at 0.85 for light work and caps at 1.15 at the ceiling", () => {
    expect(intensityFactor(20, 200)).toBeCloseTo(0.85, 9);
    expect(intensityFactor(200, 200)).toBeCloseTo(1.15, 9);
  });

  it("is monotonic across the ramp", () => {
    const ratios = [0.5, 0.6, 0.7, 0.8, 0.9];
    const values = ratios.map((r) => intensityFactor(r * 200, 200));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
  });
});

describe("rirFactor", () => {
  it("is exactly neutral at the block's target — a typical session is unchanged", () => {
    expect(rirFactor(2, 2)).toBe(1);
  });

  it("is neutral when RIR or the target is missing", () => {
    // Pre-migration-0045 sessions carry no RIR. They must score identically to
    // the calibration set, which had none either.
    expect(rirFactor(null, 2)).toBe(1);
    expect(rirFactor(2, null)).toBe(1);
  });

  it("rewards taking a set closer to failure than prescribed", () => {
    expect(rirFactor(0, 2)).toBeGreaterThan(1);
  });

  it("discounts a sandbagged set", () => {
    expect(rirFactor(4, 2)).toBeLessThan(1);
  });

  it("stays inside ±15% — the bound that keeps it uncalibrated-but-safe", () => {
    for (const rir of [0, 1, 2, 3, 4, 8, 10]) {
      expect(rirFactor(rir, 2)).toBeGreaterThanOrEqual(0.85);
      expect(rirFactor(rir, 2)).toBeLessThanOrEqual(1.15);
    }
  });
});

describe("mechanicalLoad", () => {
  it("is 0 for no exercises", () => {
    expect(mechanicalLoad([], 2)).toBe(0);
  });

  it("stays within ±15% of raw tonnage for any single session", () => {
    const session = [
      ex("Deadlift (Barbell)", [{ kg: 140, reps: 5 }, { kg: 140, reps: 5 }], 180),
      ex("Bicep Curl (Dumbbell)", [{ kg: 16, reps: 12 }], 24),
    ];
    const raw = rawTonnage(session);
    const load = mechanicalLoad(session, 2);
    expect(load).toBeGreaterThan(raw * 0.85);
    expect(load).toBeLessThan(raw * 1.15);
  });

  it("ranks a heavy compound session above a light isolation session of equal tonnage", () => {
    const heavy = [ex("Deadlift (Barbell)", [{ kg: 180, reps: 5 }], 200)];
    const light = [ex("Bicep Curl (Dumbbell)", [{ kg: 15, reps: 60 }], 30)];
    expect(rawTonnage(heavy)).toBe(rawTonnage(light));
    expect(mechanicalLoad(heavy, 2)).toBeGreaterThan(mechanicalLoad(light, 2));
  });

  it("ignores warmups", () => {
    const withWarmup = [
      ex("Squat (Barbell)", [{ kg: 60, reps: 5, warmup: true }, { kg: 120, reps: 5 }], 150),
    ];
    const without = [ex("Squat (Barbell)", [{ kg: 120, reps: 5 }], 150)];
    expect(mechanicalLoad(withWarmup, 2)).toBeCloseTo(mechanicalLoad(without, 2), 9);
  });

  it("reduces to raw tonnage when nothing is known — unmapped, no e1RM, no RIR", () => {
    const blind = [ex("Completely Invented Movement 9000", [{ kg: 50, reps: 10 }], null)];
    expect(mechanicalLoad(blind, null)).toBeCloseTo(rawTonnage(blind), 9);
  });

  it("bounds the worst compounding case — the reason the product is clamped", () => {
    // Large muscle (1.15) × near-ceiling intensity (~1.06) × two reps past the
    // RIR target (1.15) multiplies to 1.40 if each factor is clamped alone.
    // Clamping the product holds it at 1.15.
    const brutal = [ex("Deadlift (Barbell)", [{ kg: 140, reps: 5, rir: 0 }], 180)];
    const raw = rawTonnage(brutal);
    expect(mechanicalLoad(brutal, 2)).toBeLessThanOrEqual(raw * 1.15 + 1e-9);
    expect(mechanicalLoad(brutal, 2)).toBeCloseTo(raw * 1.15, 6);
  });
});

describe("combinedFactor", () => {
  it("clamps the product, not the individual factors", () => {
    // Each factor is inside 0.85-1.15, but 1.15 × 1.058 × 1.15 = 1.40 unclamped.
    expect(combinedFactor("Deadlift (Barbell)", 140, 180, 0, 2)).toBeCloseTo(1.15, 9);
  });

  it("clamps the floor case too", () => {
    // Small muscle × light load × heavily sandbagged would fall to 0.61.
    expect(combinedFactor("Bicep Curl (Dumbbell)", 5, 100, 8, 2)).toBeCloseTo(0.85, 9);
  });

  it("is neutral when nothing is known", () => {
    expect(combinedFactor("Completely Invented Movement 9000", 50, null, null, null)).toBe(1);
  });
});
