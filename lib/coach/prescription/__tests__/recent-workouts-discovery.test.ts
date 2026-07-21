// Ordering regression test for discoverEffectiveExercises.
//
// The 2026-07-21 Leg Press bug: rotation renamed "Leg Press" → "Leg Press
// Single Leg", which is not a SESSION_PLANS.Legs name, so discovery's
// second pass appended it AFTER the isolation machines. The engine wrote
// that order into session_prescriptions every Sunday, so a tier-2 secondary
// compound rendered at the end of the session on every surface. Off-script
// survivors must be inserted by fatigue tier, not appended.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { discoverEffectiveExercises } from "@/lib/coach/prescription/recent-workouts-discovery";

type FixtureExercise = { name: string; kg?: number; reps?: number };

function makeWorkout(id: string, date: string, exercises: FixtureExercise[]) {
  return {
    id,
    type: "Legs",
    date,
    exercises: exercises.map((ex, i) => ({
      name: ex.name,
      position: i,
      exercise_sets: [
        { kg: ex.kg ?? null, reps: ex.reps ?? null, warmup: false, set_index: 0, duration_seconds: null, failure: false },
      ],
    })),
  };
}

/** Minimal chainable stub matching the single query discovery makes. */
function fakeSupabase(workouts: unknown[]): SupabaseClient {
  const result = { data: workouts, error: null };
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(result),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const LEGS_SESSION: FixtureExercise[] = [
  { name: "Squat (Barbell)", kg: 70, reps: 6 },
  { name: "Leg Extension (Machine)", kg: 38, reps: 12 },
  { name: "Seated Leg Curl (Machine)", kg: 35, reps: 12 },
  { name: "Hip Abductor (Machine)", kg: 61, reps: 15 },
  { name: "Leg Press Single Leg", kg: 55, reps: 10 },
  { name: "Seated Calf Raise (Machine)", kg: 45, reps: 15 },
];

describe("discoverEffectiveExercises ordering", () => {
  it("inserts off-script exercises by fatigue tier instead of appending", async () => {
    const workouts = Array.from({ length: 6 }, (_, i) =>
      makeWorkout(`w${i}`, `2026-07-${String(20 - i * 3).padStart(2, "0")}`, LEGS_SESSION),
    );
    const discovered = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u1",
      sessionType: "Legs",
    });

    expect(discovered).not.toBeNull();
    const names = discovered!.map((e) => e.name);
    // Tier-2 secondary compound slots directly after the tier-1 squat,
    // ahead of every tier-3 isolation machine.
    expect(names).toEqual([
      "Squat (Barbell)",
      "Leg Press Single Leg",
      "Leg Extension (Machine)",
      "Seated Leg Curl (Machine)",
      "Hip Abductor (Machine)",
      "Seated Calf Raise (Machine)",
    ]);
  });

  it("keeps library-order behavior unchanged when every exercise is on-script", async () => {
    const onScript: FixtureExercise[] = [
      { name: "Squat (Barbell)", kg: 70, reps: 6 },
      { name: "Leg Press", kg: 90, reps: 12 },
      { name: "Leg Extension (Machine)", kg: 38, reps: 12 },
    ];
    const workouts = Array.from({ length: 5 }, (_, i) =>
      makeWorkout(`w${i}`, `2026-07-${String(19 - i * 3).padStart(2, "0")}`, onScript),
    );
    const discovered = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u1",
      sessionType: "Legs",
    });

    expect(discovered!.map((e) => e.name)).toEqual([
      "Squat (Barbell)",
      "Leg Press",
      "Leg Extension (Machine)",
    ]);
  });
});
