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
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";

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

/** Builds a workout where each exercise carries an explicit list of sets. */
function makeWorkoutWithSets(
  id: string,
  date: string,
  exercises: { name: string; sets: { kg: number; reps: number; warmup?: boolean }[] }[],
  type = "Legs",
) {
  return {
    id,
    type,
    date,
    exercises: exercises.map((ex, i) => ({
      name: ex.name,
      position: i,
      exercise_sets: ex.sets.map((s, j) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup ?? false,
        set_index: j,
        duration_seconds: null,
        failure: false,
      })),
    })),
  };
}

const THREE_SETS = [
  { kg: 40, reps: 12 },
  { kg: 40, reps: 12 },
  { kg: 40, reps: 12 },
];

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
    // Template order is preserved and every template entry is present, even
    // the ones absent from all six fixture sessions (Leg Press, Hip Thrust).
    // The off-script "Leg Press Single Leg" is a tier-2 secondary compound and
    // slots after the tier-1 squat, ahead of every tier-3 isolation machine.
    expect(names).toEqual([
      "Squat (Barbell)",
      "Leg Press",
      "Hip Thrust (Machine)",
      "Leg Press Single Leg",
      "Leg Extension (Machine)",
      "Seated Leg Curl (Machine)",
      "Hip Abductor (Machine)",
      "Seated Calf Raise",
    ]);
  });

  it("NEVER drops a template exercise the athlete stopped doing", async () => {
    // The one-way door. Hip Thrust (Machine) is in SESSION_PLANS.Legs and
    // absent from all six sessions. Dropping it removed it from the
    // prescription, which is what the athlete trains from — so it could never
    // climb back over the threshold it had just failed. It vanished from the
    // real program in June 2026 exactly this way, leaving Legs with no hinge.
    const withoutHinge = LEGS_SESSION.filter((e) => !/hip thrust/i.test(e.name));
    const workouts = Array.from({ length: 6 }, (_, i) =>
      makeWorkout(`w${i}`, `2026-07-${String(20 - i * 3).padStart(2, "0")}`, withoutHinge),
    );
    const discovered = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u1",
      sessionType: "Legs",
    });
    const names = discovered!.map((e) => e.name);
    expect(names).toContain("Hip Thrust (Machine)");
    expect(names).toContain("Leg Press");

    // Retained at TEMPLATE defaults, not at invented numbers.
    const template = SESSION_PLANS.Legs!.find((e) => e.name === "Hip Thrust (Machine)")!;
    const got = discovered!.find((e) => e.name === "Hip Thrust (Machine)")!;
    expect(got.baseKg).toBe(template.baseKg);
    expect(got.sets).toBe(template.sets);
  });

  it("collapses a logged alias into its template entry rather than listing both", async () => {
    // "Seated Calf Raise (Machine)" is logged; "Seated Calf Raise" is the
    // template name. Both resolve to library id `seated_calf`, so keeping
    // every template entry must not produce two rows for one movement.
    const workouts = Array.from({ length: 6 }, (_, i) =>
      makeWorkout(`w${i}`, `2026-07-${String(20 - i * 3).padStart(2, "0")}`, LEGS_SESSION),
    );
    const discovered = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u1",
      sessionType: "Legs",
    });
    const calf = discovered!.filter((e) => /seated calf raise/i.test(e.name));
    expect(calf).toHaveLength(1);
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

    // Every template entry survives, in template order; the three the athlete
    // actually performed carry refreshed numbers.
    const names = discovered!.map((e) => e.name);
    expect(names.slice(0, 3)).toEqual([
      "Squat (Barbell)",
      "Leg Press",
      "Hip Thrust (Machine)",
    ]);
    expect(names).toEqual(SESSION_PLANS.Legs!.map((e) => e.name));
  });
});

describe("discoverEffectiveExercises — realized set counts", () => {
  it("derives sets from the median realized working-set count, not the library default", async () => {
    // Lat Pulldown's SESSION_PLANS.Back default is 4 sets; athlete does 3.
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      makeWorkoutWithSets(`w${i}`, d, [{ name: "Lat Pulldown (Cable)", sets: THREE_SETS }], "Back"),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Back",
    });
    const pulldown = out?.find((e) => e.name === "Lat Pulldown (Cable)");
    expect(pulldown?.sets).toBe(3);
  });

  it("aggregates every row sharing a name within a session (warmup-split rows)", async () => {
    // Squat is stored as three rows: two warmup ramp rows + the working row.
    // Only the 3 non-warmup sets count, and baseKg must come from them.
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      makeWorkoutWithSets(`w${i}`, d, [
        { name: "Squat (Barbell)", sets: [{ kg: 47.5, reps: 5, warmup: true }] },
        { name: "Squat (Barbell)", sets: [{ kg: 62.5, reps: 3, warmup: true }] },
        { name: "Squat (Barbell)", sets: [{ kg: 80, reps: 10 }, { kg: 80, reps: 10 }, { kg: 80, reps: 10 }] },
      ]),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Legs",
    });
    const squat = out?.find((e) => e.name === "Squat (Barbell)");
    expect(squat?.sets).toBe(3);
    expect(squat?.baseKg).toBe(80);
  });

  it("falls back to the library set count when only warmup sets were logged", async () => {
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      makeWorkoutWithSets(`w${i}`, d, [
        { name: "Leg Extension (Machine)", sets: [{ kg: 30, reps: 10, warmup: true }] },
      ]),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Legs",
    });
    const legExt = out?.find((e) => e.name === "Leg Extension (Machine)");
    // SESSION_PLANS.Legs lists Leg Extension (Machine) at 3 sets.
    expect(legExt?.sets).toBe(3);
  });

  it("uses realized counts for off-script exercises instead of the hardcoded 3", async () => {
    const fourSets = [...THREE_SETS, { kg: 40, reps: 12 }];
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      makeWorkoutWithSets(`w${i}`, d, [{ name: "Leg Press Single Leg", sets: fourSets }]),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Legs",
    });
    const lp = out?.find((e) => e.name === "Leg Press Single Leg");
    expect(lp?.sets).toBe(4);
  });
});
