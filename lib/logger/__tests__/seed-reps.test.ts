import { describe, it, expect } from "vitest";
import { seedReps } from "@/lib/logger/seed-reps";
import { brzycki } from "@/lib/coach/e1rm";

describe("seedReps", () => {
  it("seeds the prescribed rep count", () => {
    expect(seedReps({ baseReps: 8, duration_seconds: undefined })).toBe(8);
  });

  it("returns null when the exercise prescribes no rep count", () => {
    expect(seedReps({ baseReps: undefined, duration_seconds: undefined })).toBeNull();
    expect(seedReps({})).toBeNull();
  });

  it("returns null for time-based work, which is measured in seconds", () => {
    // A plank prescribed at 60s must not come through as "60 reps" just
    // because some plan shape also carried a baseReps.
    expect(seedReps({ baseReps: 10, duration_seconds: 60 })).toBeNull();
  });
});

describe("seedReps — what a null rep count costs downstream", () => {
  it("makes the set invisible to e1RM, which is why the seed exists", () => {
    // Brzycki is the gate every strength consumer sits behind. A set that
    // reaches exercise_sets with reps null cannot produce a number here, so it
    // reads as "did not train" rather than "logged badly".
    expect(brzycki(100, 5)).toBeGreaterThan(100);
    const seeded = seedReps({ baseReps: 5, duration_seconds: undefined });
    expect(seeded).not.toBeNull();
    expect(brzycki(100, seeded as number)).toBeGreaterThan(100);
  });
});
