// The two ramped warmup entries are built by spreading the working compound,
// so without an explicit strip they inherit its superset tag and the logger
// pulls the warmups into the pair. The athlete ramps the press alone.

import { describe, it, expect } from "vitest";
import { augmentFirstLoadedCompoundWithWarmups } from "@/lib/coach/prescription/prescribe-week";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const ARMS: PlannedExercise[] = [
  { name: "Arnold Press (Dumbbell)", baseKg: 24, baseReps: 15, sets: 3, increment: { step: 4 }, superset: "A" },
  { name: "Bicep Curl (Dumbbell)", baseKg: 20, baseReps: 15, sets: 3, increment: { step: 4 }, superset: "A" },
];

describe("augmentFirstLoadedCompoundWithWarmups", () => {
  it("inserts two warmup entries before the first loaded compound", () => {
    const out = augmentFirstLoadedCompoundWithWarmups(ARMS);
    expect(out).toHaveLength(4);
    expect(out[0].warmup).toBe(true);
    expect(out[1].warmup).toBe(true);
    expect(out[2].name).toBe("Arnold Press (Dumbbell)");
  });

  it("strips the superset tag from the warmup entries", () => {
    const out = augmentFirstLoadedCompoundWithWarmups(ARMS);
    expect(out[0].superset).toBeUndefined();
    expect(out[1].superset).toBeUndefined();
  });

  it("leaves the working entries' tags intact", () => {
    const out = augmentFirstLoadedCompoundWithWarmups(ARMS);
    expect(out[2].superset).toBe("A");
    expect(out[3].superset).toBe("A");
  });
});
