// lib/coach/trends/__tests__/compose-strength.test.ts
//
// TDD coverage for injury gating in composeStrength + checkPlateau suppression.
// Task 6, Injury Lifecycle arc.
//
// Window semantics: plateau_active is driven by the 12w non-deload tail;
// injury gating therefore uses the same 12w window (windowStart12w → today).
// Tests verify:
//   (a) lift with plateau_active + gating injury → injury_gated true, injury_area
//       set, checkPlateau emits nothing for it
//   (b) same lift without injury → unchanged pre-task behavior
//   (c) injury overlapping <50% of the window → not gated

import { describe, it, expect, vi } from "vitest";
import type { Injury } from "@/lib/data/types";
import { checkPlateau } from "@/lib/coach/proactive/check-plateau";
import type { CoachTrendsPayload } from "@/lib/data/types";

// ── Minimal Injury fixture ────────────────────────────────────────────────────

/** Deadlift injury active from 2026-06-01, within the 12w window ending 2026-07-13 */
const DEADLIFT_INJURY: Injury = {
  id: "inj-dl-1",
  user_id: "u1",
  area: "lower back",
  side: null,
  cause: null,
  severity: "moderate",
  onset_date: "2026-06-01",
  status: "active",
  resolved_at: null,
  affected_session_types: ["Back"],
  affected_lifts: ["deadlift"],
  notes: null,
  created_at: "2026-06-01T08:00:00Z",
  updated_at: "2026-06-01T08:00:00Z",
};

// ── Supabase mock factory ─────────────────────────────────────────────────────

type MockSetRow = { kg: number; reps: number; warmup: boolean };
type MockExercise = { name: string; sets: MockSetRow[] };
type MockWorkout = { date: string; exercises: MockExercise[] };

/**
 * Builds a minimal Supabase mock that returns workouts and training_weeks rows.
 * The mock covers the two .from() calls inside composeStrength.
 */
function makeSupabaseMock(
  workouts: MockWorkout[],
  trainingWeeks: { week_start: string; research_phase: string | null }[] = [],
) {
  // Each .from() call chains: .select().eq().gte().lte()
  // We return { data, error: null } at the terminal method.
  const makeChain = (data: unknown[]) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      lte: () => chain,
      // composeStrength calls these as awaitable; return a settled promise
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve().then(() => resolve({ data, error: null })),
    };
    return chain;
  };

  return {
    from: (table: string) => {
      if (table === "workouts") return makeChain(workouts);
      if (table === "training_weeks") return makeChain(trainingWeeks);
      return makeChain([]);
    },
  };
}

// ── Workout fixture helpers ───────────────────────────────────────────────────

/**
 * Produces 4 identical weekly deadlift sessions (one per week) starting at
 * weekStart, each with the same e1RM so plateau_active fires.
 */
function flatDeadliftWorkouts(weekStart: string, e1rmKg = 180): MockWorkout[] {
  const result: MockWorkout[] = [];
  const base = new Date(weekStart + "T12:00:00Z");
  for (let w = 0; w < 4; w++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + w * 7);
    result.push({
      date: d.toISOString().slice(0, 10),
      exercises: [
        {
          name: "Deadlift (Barbell)",
          sets: [
            { kg: e1rmKg, reps: 5, warmup: false },
          ],
        },
      ],
    });
  }
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("composeStrength — injury gating", () => {
  it("(a) plateau_active lift + gating injury → injury_gated true, injury_area set", async () => {
    // today = 2026-07-13, windowStart12w = 2026-04-20 (12 weeks back)
    const today = "2026-07-13";
    // DEADLIFT_INJURY onset 2026-06-01: overlaps ~43 of 84 days (51% ≥ 50%)
    // → should gate.
    const workouts = flatDeadliftWorkouts("2026-06-16", 180); // 4 identical weeks → plateau

    const supabase = makeSupabaseMock(workouts);
    const { composeStrength } = await import("@/lib/coach/trends/compose-strength");

    const result = await composeStrength({
      supabase: supabase as never,
      userId: "u1",
      today,
      injuries: [DEADLIFT_INJURY],
    });

    const dl = result.per_lift.find((p) => p.lift === "Deadlift (Barbell)")!;
    expect(dl).toBeDefined();
    expect(dl.plateau_active).toBe(true);
    expect(dl.injury_gated).toBe(true);
    expect(dl.injury_area).toBe("lower back");
    // Prose must include "injury-gated" and onset date
    expect(dl.plateau_label).toContain("injury-gated");
    expect(dl.plateau_label).toContain("lower back");
    expect(dl.plateau_label).toContain("2026-06-01");
  });

  it("(a-checkPlateau) checkPlateau emits no event for an injury-gated lift", () => {
    const mockTrends = {
      strength: {
        per_lift: [
          {
            lift: "Deadlift (Barbell)",
            e1rm_kg_now: 180,
            slope_pct_per_wk_4w: null,
            slope_pct_per_wk_12w: null,
            r_squared_4w: null,
            r_squared_12w: null,
            plateau_active: true,
            plateau_weeks_flat: 4,
            injury_gated: true,
            injury_area: "lower back",
            plateau_label: "flat — injury-gated (lower back since 2026-06-01)",
          },
        ],
      },
    } as unknown as CoachTrendsPayload;

    const events = checkPlateau(mockTrends);
    expect(events).toHaveLength(0);
  });

  it("(b) same lift without injury → pre-task behavior: injury_gated false, checkPlateau fires", async () => {
    const today = "2026-07-13";
    const workouts = flatDeadliftWorkouts("2026-06-16", 180);

    const supabase = makeSupabaseMock(workouts);
    const { composeStrength } = await import("@/lib/coach/trends/compose-strength");

    const result = await composeStrength({
      supabase: supabase as never,
      userId: "u1",
      today,
      injuries: [], // No injuries
    });

    const dl = result.per_lift.find((p) => p.lift === "Deadlift (Barbell)")!;
    expect(dl).toBeDefined();
    expect(dl.plateau_active).toBe(true);
    expect(dl.injury_gated).toBe(false);
    expect(dl.injury_area).toBeNull();
    // plateau_label is set but does NOT contain "injury-gated"
    expect(dl.plateau_label).not.toContain("injury-gated");
    expect(dl.plateau_label).toMatch(/^\d+w flat$/);

    // checkPlateau should emit an event
    const mockTrends = {
      strength: { per_lift: [dl] },
    } as unknown as CoachTrendsPayload;
    const events = checkPlateau(mockTrends);
    expect(events).toHaveLength(1);
    expect(events[0].trigger_key).toBe("plateau:Deadlift (Barbell)");
  });

  it("(c) injury overlapping <50% of the 12w window → not gated", async () => {
    // 12w window: 2026-04-20 → 2026-07-13 = 84 days
    // Injury onset 2026-07-11 → only 2 days overlap (2/84 < 50%)
    const shortInjury: Injury = {
      ...DEADLIFT_INJURY,
      id: "inj-dl-short",
      onset_date: "2026-07-11", // 2 days before today
    };

    const today = "2026-07-13";
    const workouts = flatDeadliftWorkouts("2026-06-16", 180);

    const supabase = makeSupabaseMock(workouts);
    const { composeStrength } = await import("@/lib/coach/trends/compose-strength");

    const result = await composeStrength({
      supabase: supabase as never,
      userId: "u1",
      today,
      injuries: [shortInjury],
    });

    const dl = result.per_lift.find((p) => p.lift === "Deadlift (Barbell)")!;
    expect(dl).toBeDefined();
    expect(dl.injury_gated).toBe(false);
    expect(dl.injury_area).toBeNull();
    // plateau_label (if set) should not contain injury-gated
    if (dl.plateau_label) {
      expect(dl.plateau_label).not.toContain("injury-gated");
    }
  });
});
