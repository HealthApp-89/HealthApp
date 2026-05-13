// Spot-check the muscle aggregation. Delete after PR merges.
// Run with:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/verify-muscle-aggregation.mts

import {
  aggregateSessionMuscles,
  MUSCLE_NAMES,
  type MuscleId,
} from "@/lib/coach/exercise-muscles";
import type { WorkoutExercise } from "@/lib/data/workouts";

function ex(
  name: string,
  sets: { kg: number | null; reps: number; warmup?: boolean }[],
): WorkoutExercise {
  return {
    name,
    position: 0,
    kind: sets.some((s) => s.kg === null) ? "bodyweight" : "weighted",
    sets: sets.map((s) => ({
      kg: s.kg,
      reps: s.reps,
      duration_seconds: null,
      warmup: s.warmup ?? false,
      failure: false,
    })),
  };
}

function fmt(ids: MuscleId[]): string {
  return ids.map((id) => MUSCLE_NAMES[id]).join(", ") || "(none)";
}

const chestDay: WorkoutExercise[] = [
  ex("Bench Press (Barbell)", [
    { kg: 60, reps: 10, warmup: true },
    { kg: 90, reps: 8 },
    { kg: 100, reps: 6 },
    { kg: 100, reps: 6 },
    { kg: 100, reps: 5 },
  ]),
  ex("Incline Dumbbell Press", [
    { kg: 28, reps: 12 },
    { kg: 32, reps: 10 },
    { kg: 32, reps: 8 },
  ]),
  ex("Cable Fly", [
    { kg: 20, reps: 12 },
    { kg: 20, reps: 12 },
    { kg: 20, reps: 12 },
  ]),
  ex("Tricep Pushdown", [
    { kg: 25, reps: 12 },
    { kg: 25, reps: 12 },
    { kg: 25, reps: 12 },
  ]),
];

const legsDay: WorkoutExercise[] = [
  ex("Squat", [
    { kg: 80, reps: 5, warmup: true },
    { kg: 120, reps: 5 },
    { kg: 130, reps: 5 },
    { kg: 130, reps: 5 },
    { kg: 130, reps: 5 },
  ]),
  ex("Romanian Deadlift", [
    { kg: 100, reps: 8 },
    { kg: 110, reps: 8 },
    { kg: 110, reps: 8 },
  ]),
  ex("Leg Extension", [
    { kg: 60, reps: 12 },
    { kg: 60, reps: 12 },
    { kg: 60, reps: 12 },
  ]),
  ex("Calf Raise", [
    { kg: 80, reps: 15 },
    { kg: 80, reps: 15 },
    { kg: 80, reps: 15 },
  ]),
];

const unknownDay: WorkoutExercise[] = [
  ex("Some Exotic Exercise We Haven't Mapped", [
    { kg: 50, reps: 10 },
    { kg: 50, reps: 10 },
  ]),
];

function run(label: string, exs: WorkoutExercise[], type: string | null) {
  const result = aggregateSessionMuscles(exs, type);
  console.log(`\n=== ${label} (type=${type ?? "null"}) ===`);
  console.log(`  primary:   ${fmt(result.primary)}`);
  console.log(`  secondary: ${fmt(result.secondary)}`);
}

run("Chest day", chestDay, "Chest");
run("Legs day", legsDay, "Legs");
run("Unknown exercises only", unknownDay, "Chest");
run("Empty session, type=Back", [], "Back");
run("Empty session, no type", [], null);
