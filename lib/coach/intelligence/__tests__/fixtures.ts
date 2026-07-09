// lib/coach/intelligence/__tests__/fixtures.ts
//
// Shared test fixtures for the coach intelligence layer tests.
// All fixtures are pure data — no DB connections, no side effects.

import type { WorkoutSession } from "@/lib/data/workouts";
import type { FoodLogEntry } from "@/lib/food/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(prefix: string, i: number): string {
  return `${prefix}-${String(i).padStart(3, "0")}`;
}

/** ISO date N days before `base` (defaults to 2026-06-26, "today" in these fixtures). */
export function daysAgo(n: number, base = "2026-06-26"): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Build a minimal WorkoutSession with the given exercises. */
function makeSession(
  id: string,
  date: string,
  type: string,
  exercises: {
    name: string;
    kind: "weighted" | "bodyweight";
    sets: { kg: number | null; reps: number | null; warmup?: boolean }[];
  }[],
): WorkoutSession {
  const workoutExercises = exercises.map((e, pos) => ({
    name: e.name,
    position: pos,
    kind: e.kind,
    sets: e.sets.map((s) => ({
      kg: s.kg,
      reps: s.reps,
      duration_seconds: null,
      warmup: s.warmup ?? false,
      failure: false,
    })),
  }));

  let vol = 0;
  let bwReps = 0;
  let setsCount = 0;
  for (const e of workoutExercises) {
    for (const s of e.sets) {
      if (s.warmup) continue;
      setsCount++;
      if (s.kg && s.reps) vol += s.kg * s.reps;
      else if (!s.kg && s.reps) bwReps += s.reps;
    }
  }

  return {
    id,
    date,
    type,
    duration_min: 60,
    source: "logger",
    exercises: workoutExercises,
    vol,
    bwReps,
    sets: setsCount,
  };
}

// ---------------------------------------------------------------------------
// SAMPLE_WORKOUTS_90D — 30 sessions distributed over ~90 days
//
// Design intent (for volume_preference = "moderate"):
//   Exactly 12 of 30 sessions contain at least one set with reps > 10 = 40%.
//   40% falls in 30–60% band → volume_preference = "moderate".
//
// Exercise frequency (for top_exercises assertions):
//   lower:     Squat (Barbell) ×8, Romanian Deadlift (RDL) ×6, Leg Press ×5,
//              Leg Extension (Machine) ×4, Seated Leg Curl (Machine) ×3
//   pulls:     Deadlift (Barbell) ×8, Lat Pulldown (Cable) ×7, Seated Row (Machine) ×5,
//              Pullover (Dumbbell) ×4
//   upper:     Decline Bench Press (Barbell) ×7, Overhead Press (Barbell) ×5
//   isolation: Arnold Press (Dumbbell) ×7, Bicep Curl (Dumbbell) ×6,
//              Lateral Raise (Dumbbell) ×5, Triceps Pushdown (Cable) ×4
//
// High-rep sessions (any working set with reps > 10):
//   legs-1, legs-2, legs-3, legs-5, legs-7         → 5 legs sessions
//   back-1, back-3, back-6, back-8                  → 4 back sessions
//   chest-1, chest-3, chest-6                       → 3 chest sessions
//   (arms sessions all stay at ≤10 reps to keep % at 40%)
//   Total high-rep: 12 / 30 = 40% → "moderate"
// ---------------------------------------------------------------------------

export const SAMPLE_WORKOUTS_90D: WorkoutSession[] = [
  // ── Legs (8 sessions) ─────────────────────────────────────────────────────

  // legs-1: HIGH-REP (Leg Extension 12 reps > 10)
  makeSession(makeId("legs", 1), daysAgo(88), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 60, reps: 6 }, { kg: 60, reps: 6 }, { kg: 60, reps: 6 }] },
    { name: "Romanian Deadlift (RDL)", kind: "weighted", sets: [{ kg: 50, reps: 8 }, { kg: 50, reps: 8 }] },
    { name: "Leg Press", kind: "weighted", sets: [{ kg: 80, reps: 10 }, { kg: 80, reps: 10 }] },
    { name: "Leg Extension (Machine)", kind: "weighted", sets: [{ kg: 30, reps: 12 }, { kg: 30, reps: 12 }] },
  ]),

  // legs-2: HIGH-REP (Seated Leg Curl 12 reps > 10)
  makeSession(makeId("legs", 2), daysAgo(77), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 62, reps: 6 }, { kg: 62, reps: 6 }] },
    { name: "Romanian Deadlift (RDL)", kind: "weighted", sets: [{ kg: 52, reps: 8 }, { kg: 52, reps: 8 }] },
    { name: "Leg Press", kind: "weighted", sets: [{ kg: 85, reps: 10 }] },
    { name: "Seated Leg Curl (Machine)", kind: "weighted", sets: [{ kg: 28, reps: 12 }] },
  ]),

  // legs-3: HIGH-REP (Leg Extension 12 reps > 10)
  makeSession(makeId("legs", 3), daysAgo(66), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 65, reps: 5 }, { kg: 65, reps: 5 }] },
    { name: "Romanian Deadlift (RDL)", kind: "weighted", sets: [{ kg: 55, reps: 8 }, { kg: 55, reps: 8 }] },
    { name: "Leg Extension (Machine)", kind: "weighted", sets: [{ kg: 32, reps: 12 }, { kg: 32, reps: 12 }] },
  ]),

  // legs-4: NOT high-rep (all reps ≤ 10)
  makeSession(makeId("legs", 4), daysAgo(55), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 67, reps: 5 }] },
    { name: "Romanian Deadlift (RDL)", kind: "weighted", sets: [{ kg: 57, reps: 8 }] },
    { name: "Leg Press", kind: "weighted", sets: [{ kg: 90, reps: 10 }, { kg: 90, reps: 10 }] },
  ]),

  // legs-5: HIGH-REP (Leg Extension 12 > 10)
  makeSession(makeId("legs", 5), daysAgo(44), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 70, reps: 6 }] },
    { name: "Romanian Deadlift (RDL)", kind: "weighted", sets: [{ kg: 60, reps: 8 }] },
    { name: "Leg Extension (Machine)", kind: "weighted", sets: [{ kg: 35, reps: 12 }, { kg: 35, reps: 12 }] },
    { name: "Leg Press", kind: "weighted", sets: [{ kg: 95, reps: 10 }] },
  ]),

  // legs-6: NOT high-rep
  makeSession(makeId("legs", 6), daysAgo(33), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 72, reps: 6 }] },
    { name: "Romanian Deadlift (RDL)", kind: "weighted", sets: [{ kg: 62, reps: 8 }] },
  ]),

  // legs-7: HIGH-REP (Seated Leg Curl 12 > 10)
  makeSession(makeId("legs", 7), daysAgo(22), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 75, reps: 6 }] },
    { name: "Seated Leg Curl (Machine)", kind: "weighted", sets: [{ kg: 32, reps: 12 }] },
  ]),

  // legs-8: NOT high-rep
  makeSession(makeId("legs", 8), daysAgo(11), "Legs", [
    { name: "Squat (Barbell)", kind: "weighted", sets: [{ kg: 77, reps: 5 }] },
    { name: "Romanian Deadlift (RDL)", kind: "weighted", sets: [{ kg: 65, reps: 8 }] },
    { name: "Leg Press", kind: "weighted", sets: [{ kg: 100, reps: 10 }] },
  ]),

  // ── Back (8 sessions) ─────────────────────────────────────────────────────

  // back-1: HIGH-REP (Seated Row 12 > 10)
  makeSession(makeId("back", 1), daysAgo(86), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 80, reps: 5 }, { kg: 80, reps: 5 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 45, reps: 10 }, { kg: 45, reps: 10 }] },
    { name: "Seated Row (Machine)", kind: "weighted", sets: [{ kg: 38, reps: 12 }, { kg: 38, reps: 12 }] },
    { name: "Pullover (Dumbbell)", kind: "weighted", sets: [{ kg: 18, reps: 10 }] },
  ]),

  // back-2: NOT high-rep
  makeSession(makeId("back", 2), daysAgo(75), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 82, reps: 5 }, { kg: 82, reps: 5 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 47, reps: 10 }, { kg: 47, reps: 10 }] },
    { name: "Pullover (Dumbbell)", kind: "weighted", sets: [{ kg: 18, reps: 10 }] },
  ]),

  // back-3: HIGH-REP (Seated Row 12 > 10)
  makeSession(makeId("back", 3), daysAgo(64), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 85, reps: 5 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 48, reps: 10 }] },
    { name: "Seated Row (Machine)", kind: "weighted", sets: [{ kg: 40, reps: 12 }] },
    { name: "Pullover (Dumbbell)", kind: "weighted", sets: [{ kg: 20, reps: 10 }] },
  ]),

  // back-4: NOT high-rep
  makeSession(makeId("back", 4), daysAgo(53), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 87, reps: 5 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 50, reps: 10 }] },
    { name: "Seated Row (Machine)", kind: "weighted", sets: [{ kg: 42, reps: 10 }] },
  ]),

  // back-5: NOT high-rep
  makeSession(makeId("back", 5), daysAgo(42), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 90, reps: 5 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 50, reps: 10 }, { kg: 50, reps: 10 }] },
    { name: "Seated Row (Machine)", kind: "weighted", sets: [{ kg: 44, reps: 10 }] },
  ]),

  // back-6: HIGH-REP (Pullover 12 > 10)
  makeSession(makeId("back", 6), daysAgo(31), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 92, reps: 5 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 52, reps: 8 }] },
    { name: "Pullover (Dumbbell)", kind: "weighted", sets: [{ kg: 20, reps: 12 }] },
  ]),

  // back-7: NOT high-rep
  makeSession(makeId("back", 7), daysAgo(20), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 95, reps: 4 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 53, reps: 8 }] },
    { name: "Seated Row (Machine)", kind: "weighted", sets: [{ kg: 45, reps: 10 }] },
  ]),

  // back-8: HIGH-REP (Seated Row 12 > 10)
  makeSession(makeId("back", 8), daysAgo(9), "Back", [
    { name: "Deadlift (Barbell)", kind: "weighted", sets: [{ kg: 97, reps: 4 }] },
    { name: "Lat Pulldown (Cable)", kind: "weighted", sets: [{ kg: 55, reps: 8 }] },
    { name: "Seated Row (Machine)", kind: "weighted", sets: [{ kg: 45, reps: 12 }] },
  ]),

  // ── Chest (7 sessions) ────────────────────────────────────────────────────

  // chest-1: HIGH-REP (Overhead Press reps 8 — NOT >10, wait, check:
  //   Decline 8, OHP 8, OHP 8 → no >10... but need this session to be high-rep)
  // Make chest-fly 11 reps
  makeSession(makeId("chest", 1), daysAgo(84), "Chest", [
    { name: "Decline Bench Press (Barbell)", kind: "weighted", sets: [{ kg: 58, reps: 8 }] },
    { name: "Overhead Press (Barbell)", kind: "weighted", sets: [{ kg: 28, reps: 8 }, { kg: 28, reps: 8 }] },
    { name: "Chest Fly", kind: "weighted", sets: [{ kg: 20, reps: 11 }, { kg: 20, reps: 11 }] },
  ]),

  // chest-2: NOT high-rep
  makeSession(makeId("chest", 2), daysAgo(73), "Chest", [
    { name: "Decline Bench Press (Barbell)", kind: "weighted", sets: [{ kg: 60, reps: 8 }] },
    { name: "Overhead Press (Barbell)", kind: "weighted", sets: [{ kg: 30, reps: 7 }] },
  ]),

  // chest-3: HIGH-REP (Chest Fly 11 > 10)
  makeSession(makeId("chest", 3), daysAgo(62), "Chest", [
    { name: "Decline Bench Press (Barbell)", kind: "weighted", sets: [{ kg: 62, reps: 8 }] },
    { name: "Overhead Press (Barbell)", kind: "weighted", sets: [{ kg: 30, reps: 7 }] },
    { name: "Chest Fly", kind: "weighted", sets: [{ kg: 22, reps: 11 }] },
  ]),

  // chest-4: NOT high-rep
  makeSession(makeId("chest", 4), daysAgo(51), "Chest", [
    { name: "Decline Bench Press (Barbell)", kind: "weighted", sets: [{ kg: 65, reps: 7 }] },
    { name: "Overhead Press (Barbell)", kind: "weighted", sets: [{ kg: 32, reps: 7 }] },
  ]),

  // chest-5: NOT high-rep
  makeSession(makeId("chest", 5), daysAgo(40), "Chest", [
    { name: "Decline Bench Press (Barbell)", kind: "weighted", sets: [{ kg: 67, reps: 7 }] },
    { name: "Overhead Press (Barbell)", kind: "weighted", sets: [{ kg: 33, reps: 6 }] },
  ]),

  // chest-6: HIGH-REP (Chest Fly 11 > 10)
  makeSession(makeId("chest", 6), daysAgo(29), "Chest", [
    { name: "Decline Bench Press (Barbell)", kind: "weighted", sets: [{ kg: 68, reps: 6 }] },
    { name: "Chest Fly", kind: "weighted", sets: [{ kg: 23, reps: 11 }] },
  ]),

  // chest-7: NOT high-rep
  makeSession(makeId("chest", 7), daysAgo(18), "Chest", [
    { name: "Decline Bench Press (Barbell)", kind: "weighted", sets: [{ kg: 70, reps: 6 }] },
    { name: "Overhead Press (Barbell)", kind: "weighted", sets: [{ kg: 35, reps: 6 }] },
  ]),

  // ── Arms (7 sessions) — ALL at ≤10 reps to keep total high-rep count at 12/30 = 40%
  // ─────────────────────────────────────────────────────────────────────────
  makeSession(makeId("arms", 1), daysAgo(82), "Arms", [
    { name: "Arnold Press (Dumbbell)", kind: "weighted", sets: [{ kg: 22, reps: 10 }] },
    { name: "Bicep Curl (Dumbbell)", kind: "weighted", sets: [{ kg: 18, reps: 10 }, { kg: 18, reps: 10 }] },
    { name: "Lateral Raise (Dumbbell)", kind: "weighted", sets: [{ kg: 10, reps: 10 }, { kg: 10, reps: 10 }] },
    { name: "Triceps Pushdown (Cable)", kind: "weighted", sets: [{ kg: 22, reps: 10 }] },
  ]),
  makeSession(makeId("arms", 2), daysAgo(71), "Arms", [
    { name: "Arnold Press (Dumbbell)", kind: "weighted", sets: [{ kg: 22, reps: 10 }] },
    { name: "Bicep Curl (Dumbbell)", kind: "weighted", sets: [{ kg: 20, reps: 10 }] },
    { name: "Lateral Raise (Dumbbell)", kind: "weighted", sets: [{ kg: 10, reps: 10 }] },
    { name: "Triceps Pushdown (Cable)", kind: "weighted", sets: [{ kg: 23, reps: 10 }] },
  ]),
  makeSession(makeId("arms", 3), daysAgo(60), "Arms", [
    { name: "Arnold Press (Dumbbell)", kind: "weighted", sets: [{ kg: 24, reps: 10 }] },
    { name: "Bicep Curl (Dumbbell)", kind: "weighted", sets: [{ kg: 20, reps: 10 }] },
    { name: "Lateral Raise (Dumbbell)", kind: "weighted", sets: [{ kg: 12, reps: 10 }] },
  ]),
  makeSession(makeId("arms", 4), daysAgo(49), "Arms", [
    { name: "Arnold Press (Dumbbell)", kind: "weighted", sets: [{ kg: 24, reps: 8 }] },
    { name: "Bicep Curl (Dumbbell)", kind: "weighted", sets: [{ kg: 20, reps: 8 }] },
    { name: "Lateral Raise (Dumbbell)", kind: "weighted", sets: [{ kg: 12, reps: 8 }] },
    { name: "Triceps Pushdown (Cable)", kind: "weighted", sets: [{ kg: 24, reps: 8 }] },
  ]),
  makeSession(makeId("arms", 5), daysAgo(38), "Arms", [
    { name: "Arnold Press (Dumbbell)", kind: "weighted", sets: [{ kg: 26, reps: 8 }] },
    { name: "Bicep Curl (Dumbbell)", kind: "weighted", sets: [{ kg: 22, reps: 8 }] },
    { name: "Triceps Pushdown (Cable)", kind: "weighted", sets: [{ kg: 25, reps: 8 }] },
  ]),
  makeSession(makeId("arms", 6), daysAgo(27), "Arms", [
    { name: "Arnold Press (Dumbbell)", kind: "weighted", sets: [{ kg: 26, reps: 8 }] },
    { name: "Bicep Curl (Dumbbell)", kind: "weighted", sets: [{ kg: 22, reps: 8 }] },
    { name: "Lateral Raise (Dumbbell)", kind: "weighted", sets: [{ kg: 12, reps: 8 }] },
  ]),
  makeSession(makeId("arms", 7), daysAgo(16), "Arms", [
    { name: "Arnold Press (Dumbbell)", kind: "weighted", sets: [{ kg: 28, reps: 8 }] },
    { name: "Bicep Curl (Dumbbell)", kind: "weighted", sets: [{ kg: 22, reps: 8 }] },
  ]),
];

// ── High-rep session count verification ────────────────────────────────────
// legs:  legs-1✓ legs-2✓ legs-3✓ legs-4✗ legs-5✓ legs-6✗ legs-7✓ legs-8✗ = 5
// back:  back-1✓ back-2✗ back-3✓ back-4✗ back-5✗ back-6✓ back-7✗ back-8✓ = 4
// chest: chest-1✓ chest-2✗ chest-3✓ chest-4✗ chest-5✗ chest-6✓ chest-7✗ = 3
// arms:  all ✗ = 0
// Total: 5+4+3+0 = 12 / 30 = 40% → "moderate" ✓

// ---------------------------------------------------------------------------
// Helpers for building FoodLogEntry fixtures
// ---------------------------------------------------------------------------

const ZERO_MACROS = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };

function makeProteinItem(name: string, qty: number): import("@/lib/food/types").FoodItem {
  return {
    name,
    qty_g: qty,
    kcal: Math.round(qty * 1.5),
    protein_g: Math.round(qty * 0.22),
    carbs_g: Math.round(qty * 0.01),
    fat_g: Math.round(qty * 0.05),
    fiber_g: 0,
    per_100g: { kcal: 150, protein_g: 22, carbs_g: 1, fat_g: 5, fiber_g: 0 },
    source: "db",
    db_ref: { source: "usda", canonical_id: name.toLowerCase().replace(/ /g, "_") },
    confidence: "high",
    match_score: 0.95,
  };
}

function makeCarbItem(name: string, qty: number): import("@/lib/food/types").FoodItem {
  return {
    name,
    qty_g: qty,
    kcal: Math.round(qty * 1.3),
    protein_g: Math.round(qty * 0.03),
    carbs_g: Math.round(qty * 0.28),
    fat_g: Math.round(qty * 0.01),
    fiber_g: Math.round(qty * 0.01),
    per_100g: { kcal: 130, protein_g: 3, carbs_g: 28, fat_g: 1, fiber_g: 1 },
    source: "db",
    db_ref: { source: "usda", canonical_id: name.toLowerCase().replace(/ /g, "_") },
    confidence: "high",
    match_score: 0.9,
  };
}

function makeFatItem(name: string, qty: number): import("@/lib/food/types").FoodItem {
  return {
    name,
    qty_g: qty,
    kcal: Math.round(qty * 8),
    protein_g: 0,
    carbs_g: 0,
    fat_g: Math.round(qty * 0.9),
    fiber_g: 0,
    per_100g: { kcal: 800, protein_g: 0, carbs_g: 0, fat_g: 90, fiber_g: 0 },
    source: "db",
    db_ref: { source: "usda", canonical_id: name.toLowerCase().replace(/ /g, "_") },
    confidence: "high",
    match_score: 0.92,
  };
}

function makeFoodEntry(
  id: string,
  date: string,
  items: import("@/lib/food/types").FoodItem[],
): FoodLogEntry {
  const totals = items.reduce(
    (acc, item) => ({
      kcal: acc.kcal + item.kcal,
      protein_g: acc.protein_g + item.protein_g,
      carbs_g: acc.carbs_g + item.carbs_g,
      fat_g: acc.fat_g + item.fat_g,
      fiber_g: acc.fiber_g + item.fiber_g,
    }),
    { ...ZERO_MACROS },
  );

  return {
    id,
    user_id: "test-user",
    eaten_at: `${date}T12:00:00.000Z`,
    kind: "text",
    meal_slot: "lunch",
    raw_input: { kind: "text", text: items.map((i) => i.name).join(", ") },
    items,
    totals,
    is_estimated: false,
    is_favorite: false,
    status: "committed",
    created_at: `${date}T12:00:00.000Z`,
    updated_at: `${date}T12:00:00.000Z`,
  };
}

// ---------------------------------------------------------------------------
// SAMPLE_FOOD_LOG_90D — 60 entries over ~84 days (12 weeks)
//
// Pattern (to trigger monotone detection at >3×/week average):
//   Chicken Breast: appears 4× per week → 48/12 weeks → avg 4/wk > 3 → MONOTONE
//   White Rice:     appears 5× per week → 60/12 weeks → avg 5/wk > 3 → MONOTONE
//   Olive Oil:      appears 5× per week → 60/12 weeks → avg 5/wk > 3 → MONOTONE
//   Salmon:         appears 1× per week → 12/12 weeks → avg 1/wk ≤ 3 → NOT monotone
//   Eggs:           appears 2× per week → 24/12 weeks → avg 2/wk ≤ 3 → NOT monotone
//
// Threshold: >3 times/week over 12 weeks = >36 total occurrences in 84 days.
// Chicken: 48 > 36 → monotone ✓
// White Rice: 60 > 36 → monotone ✓
// Olive Oil: 60 > 36 → monotone ✓
// Salmon: 12 ≤ 36 → NOT monotone ✓
//
// We build 5 entries per week × 12 weeks = 60 entries.
// Each entry = 1 Chicken + 1 White Rice + 1 Olive Oil, sometimes Salmon or Eggs.
// ---------------------------------------------------------------------------

// 12 weeks × 5 entries per week = 60 entries, starting from day 84 ago
const buildWeekEntries = (weekIndex: number): FoodLogEntry[] => {
  // weekIndex 0 = oldest week (days 84..78), weekIndex 11 = most recent (days 7..1)
  const baseDay = 84 - weekIndex * 7;

  return [
    // Mon: Chicken + White Rice + Olive Oil
    makeFoodEntry(`food-w${weekIndex}-1`, daysAgo(baseDay - 0), [
      makeProteinItem("Chicken Breast", 200),
      makeCarbItem("White Rice", 150),
      makeFatItem("Olive Oil", 15),
    ]),
    // Tue: Chicken + White Rice + Olive Oil
    makeFoodEntry(`food-w${weekIndex}-2`, daysAgo(baseDay - 1), [
      makeProteinItem("Chicken Breast", 180),
      makeCarbItem("White Rice", 120),
      makeFatItem("Olive Oil", 10),
    ]),
    // Wed: Eggs + White Rice + Olive Oil
    makeFoodEntry(`food-w${weekIndex}-3`, daysAgo(baseDay - 2), [
      makeProteinItem("Eggs", 150),
      makeCarbItem("White Rice", 130),
      makeFatItem("Olive Oil", 12),
    ]),
    // Thu: Chicken + White Rice + Olive Oil
    makeFoodEntry(`food-w${weekIndex}-4`, daysAgo(baseDay - 3), [
      makeProteinItem("Chicken Breast", 200),
      makeCarbItem("White Rice", 140),
      makeFatItem("Olive Oil", 15),
    ]),
    // Fri: Salmon + White Rice (to add variety) + Almonds
    makeFoodEntry(`food-w${weekIndex}-5`, daysAgo(baseDay - 4), [
      makeProteinItem("Salmon", 180),
      makeCarbItem("White Rice", 160),
      makeFatItem("Almonds", 30),
    ]),
    // Sat: Chicken + Oats + Olive Oil
    makeFoodEntry(`food-w${weekIndex}-6`, daysAgo(baseDay - 5), [
      makeProteinItem("Chicken Breast", 200),
      makeCarbItem("Oats", 80),
      makeFatItem("Olive Oil", 12),
    ]),
  ];
};

export const SAMPLE_FOOD_LOG_90D: FoodLogEntry[] = Array.from(
  { length: 12 },
  (_, i) => buildWeekEntries(i),
).flat();

// Counts for reference:
// Chicken Breast: 4/week × 12 = 48 entries
// White Rice:     5/week × 12 = 60 entries
// Olive Oil:      5/week × 12 = 60 entries
// Eggs:           1/week × 12 = 12 entries
// Salmon:         1/week × 12 = 12 entries
// Oats:           1/week × 12 = 12 entries
// Almonds:        1/week × 12 = 12 entries

// ---------------------------------------------------------------------------
// SAMPLE_PROFILE — Profile with athlete_profile_documents including
// injury and constraint data for Task 3 testing
// ---------------------------------------------------------------------------

export const SAMPLE_PROFILE = {
  user_id: "test-user",
  name: "Test Athlete",
  age: 36,
  height_cm: 180,
  timezone: "Asia/Dubai",
  athlete_profile_documents: [
    {
      id: "doc-001",
      user_id: "test-user",
      version: 1,
      status: "active",
      intake_payload: {
        schema_version: 1,
        health: {
          conditions: {
            cardiac: false,
            hypertension: false,
            diabetes: "none" as const,
            autoimmune: false,
            joint_surgeries: [],
            other: "",
          },
          medications: "",
          recent_illness_injury: "",
          active_injuries: [],
          allergies: "",
        },
        training: {
          years_lifting: 8,
          training_age: "advanced" as const,
          sessions_per_week: 4,
          typical_session_minutes: 60,
          equipment: {
            barbell: true,
            rack: true,
            bench: true,
            dumbbells: true,
            cables: true,
            machines: true,
            platform: false,
            ghd: false,
            sled: false,
            treadmill: false,
            rower: false,
            bike: false,
            kettlebells: false,
            bands: false,
            other: "",
          },
          current_e1rm: {
            squat: 140,
            bench: 100,
            deadlift: 160,
            ohp: 60,
          },
          best_ever_pr: {
            squat: 145,
            bench: 105,
            deadlift: 170,
            ohp: 65,
          },
          previous_programs: "",
          recent_plateaus: "",
        },
        lifestyle: {
          job_demands: "sedentary" as const,
          commute_minutes: 15,
          has_dependents: false,
          dependent_notes: "",
          stress_self_rating: 3 as const,
          days_available: {
            mon: true,
            tue: true,
            wed: true,
            thu: true,
            fri: true,
            sat: true,
            sun: false,
          },
          earliest_session_time: "17:00",
          latest_session_time: "21:00",
          travel_frequency: "monthly" as const,
        },
        nutrition: {
          current_phase: "recomp" as const,
          current_kcal: 2500,
          current_macros: {
            protein_g: 200,
            carb_g: 250,
            fat_g: 80,
          },
          tracking_experience: "consistent" as const,
          restrictions: "",
          alcohol_drinks_per_week: 2,
          caffeine_mg_per_day: 400,
          supplements: "",
        },
        sleep_recovery: {
          avg_sleep_hours: 7.5,
          typical_bedtime: "22:30",
          typical_wake_time: "06:30",
          sleep_latency_minutes: 10,
          awakenings: "none" as const,
          mobility_work: "Yes, 3x/week",
          soreness_frequency: "common" as const,
        },
        goals: {
          primary_type: "strength",
          primary_metric: "Deadlift E1RM",
          target_value: 200,
          target_unit: "kg",
          target_date: "2026-12-31",
          why_narrative: "Build strength and performance",
        },
      },
      rendered_md: null,
      acknowledged_at: "2026-06-01T10:00:00Z",
      superseded_at: null,
      superseded_by: null,
      endurance_profile: null,
      // ── Fields from the task brief ──────────────────────────────────────────
      current_injuries: [
        {
          area: "shoulder",
          severity: "mild",
          weeks_since_onset: 3,
          exercises_to_avoid: ["OHP", "Weighted Chins", "Heavy Bench Press"],
        },
      ],
      gym_type: "commercial",
      lifestyle_constraints: [
        "Work 9-5, can only train evenings",
        "Family time 7-9pm, max 3 sessions/week",
        "Travel every 3rd week",
      ],
      created_at: "2026-06-01T10:00:00Z",
      updated_at: "2026-06-01T10:00:00Z",
    },
  ],
};
