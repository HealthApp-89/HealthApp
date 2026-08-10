import { describe, it, expect } from "vitest";
import { seedRir } from "@/lib/logger/seed-rir";
import { effortBand } from "@/lib/coach/live-session/helpers";
import type { ExerciseSetDraft } from "@/lib/logger/types";

describe("seedRir", () => {
  it("prefers the exercise's prescribed RIR over the week target", () => {
    expect(seedRir({ rir: 4 }, 2)).toBe(4);
  });

  it("falls back to the week target when the exercise has no prescribed RIR", () => {
    expect(seedRir({ rir: undefined }, 3)).toBe(3);
  });

  it("falls back to 2 when neither is present", () => {
    expect(seedRir({ rir: undefined }, null)).toBe(2);
    expect(seedRir({ rir: undefined }, undefined)).toBe(2);
  });

  it("keeps a prescribed RIR of 0 — it is a real target, not an absent one", () => {
    expect(seedRir({ rir: 0 }, 2)).toBe(0);
  });
});

describe("seedRir × effortBand — the auto-patch regression", () => {
  /** A day the engine lightened: patch-today raised Decline Bench to
   *  baseReps 7 @ RIR 4. The athlete hits exactly 7 and never touches the RIR
   *  box, so the set carries whatever was seeded. */
  const prescribed = { rir: 4 };
  const effortTarget = prescribed.rir;

  function setWith(rir: number): ExerciseSetDraft {
    return {
      set_index: 0, kg: 60, reps: 7, duration_seconds: null,
      warmup: false, failure: false, rir, committed_at: "2026-08-10T09:00:00Z",
    };
  }

  it("seeding the WEEK target would band an on-plan set as strained", () => {
    // Documents the old behaviour so a regression is unmistakable: the seeded
    // value was `weekRirTarget ?? 2`, and effortBand(2, 4) is r < t.
    expect(effortBand(setWith(2), effortTarget)).toBe("strained");
  });

  it("seeding the PRESCRIBED RIR bands the same set as on-plan", () => {
    expect(effortBand(setWith(seedRir(prescribed, 2)), effortTarget)).toBe("on");
  });
});
