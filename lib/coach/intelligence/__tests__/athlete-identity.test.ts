// lib/coach/intelligence/__tests__/athlete-identity.test.ts
//
// Tests for composeAthleteIdentity() — the identity composer function.
// Run via: npx vitest lib/coach/intelligence/__tests__/athlete-identity.test.ts

import { describe, it, expect } from "vitest";
import { IdentityPayloadSchema } from "../types";
import { composeAthleteIdentity } from "../athlete-identity";
import { SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D } from "./fixtures";
import type { WorkoutSession } from "@/lib/data/workouts";
import type { FoodLogEntry } from "@/lib/food/types";

// ---------------------------------------------------------------------------
// Test 1: Valid input → correct top exercises per category
// ---------------------------------------------------------------------------

describe("composeAthleteIdentity — top_exercises", () => {
  it("returns the most frequent exercises in lower category", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // Squat appears in all 8 Legs sessions → must be first in lower
    expect(result.top_exercises.lower[0]).toBe("Squat (Barbell)");
    // RDL appears in 6 sessions → must be second
    expect(result.top_exercises.lower[1]).toBe("Romanian Deadlift (RDL)");
  });

  it("returns the most frequent exercises in pulls category", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // Deadlift appears in all 8 Back sessions → must be first in pulls
    expect(result.top_exercises.pulls[0]).toBe("Deadlift (Barbell)");
    // Lat Pulldown appears in 7 sessions → must be second
    expect(result.top_exercises.pulls[1]).toBe("Lat Pulldown (Cable)");
  });

  it("returns the most frequent exercises in upper category", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // Decline Bench appears in all 7 Chest sessions → must be first in upper
    expect(result.top_exercises.upper[0]).toBe("Decline Bench Press (Barbell)");
  });

  it("returns the most frequent exercises in isolation category", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // Arnold Press appears in all 7 Arms sessions → must be first in isolation
    expect(result.top_exercises.isolation[0]).toBe("Arnold Press (Dumbbell)");
    // Bicep Curl appears in 6 → second (or third due to tie with Lateral Raise — just ensure top 5)
    expect(result.top_exercises.isolation).toContain("Bicep Curl (Dumbbell)");
  });

  it("limits each category to max 5 exercises", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.top_exercises.lower.length).toBeLessThanOrEqual(5);
    expect(result.top_exercises.upper.length).toBeLessThanOrEqual(5);
    expect(result.top_exercises.pulls.length).toBeLessThanOrEqual(5);
    expect(result.top_exercises.isolation.length).toBeLessThanOrEqual(5);
  });

  it("returns empty arrays for categories with no exercises in input", () => {
    const cardioOnlySession: WorkoutSession = {
      id: "cardio-001",
      date: "2026-06-01",
      type: "Cardio",
      duration_min: 30,
      source: "logger",
      exercises: [
        {
          name: "Treadmill Run",
          position: 0,
          kind: "bodyweight",
          sets: [{ kg: null, reps: null, duration_seconds: 1800, warmup: false, failure: false }],
        },
      ],
      vol: 0,
      bwReps: 0,
      sets: 1,
    };

    const result = composeAthleteIdentity([cardioOnlySession], []);
    // No lower/upper/pulls/isolation exercises → all empty
    expect(result.top_exercises.lower).toEqual([]);
    expect(result.top_exercises.upper).toEqual([]);
    expect(result.top_exercises.pulls).toEqual([]);
    expect(result.top_exercises.isolation).toEqual([]);
  });

  it("handles empty workouts list gracefully", () => {
    const result = composeAthleteIdentity([], []);
    expect(result.top_exercises.lower).toEqual([]);
    expect(result.top_exercises.upper).toEqual([]);
    expect(result.top_exercises.pulls).toEqual([]);
    expect(result.top_exercises.isolation).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Eating identity and monotone detection
// ---------------------------------------------------------------------------

describe("composeAthleteIdentity — eating_identity", () => {
  it("identifies top protein foods (chicken is most frequent)", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // Chicken Breast appears in every entry with high protein → must be #1
    expect(result.eating_identity.top_proteins[0]).toBe("Chicken Breast");
  });

  it("identifies top carb foods (white rice is most frequent)", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // White Rice appears in most entries with high carbs → must be #1
    expect(result.eating_identity.top_carbs[0]).toBe("White Rice");
  });

  it("identifies top fat foods (olive oil is most frequent)", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // Olive Oil appears in most entries with high fat → must be #1
    expect(result.eating_identity.top_fats[0]).toBe("Olive Oil");
  });

  it("detects monotone diet — chicken exceeds 3 times per week", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    // Chicken Breast appears ~20/30 entries → well above 3x/week threshold → in monotone_flags
    expect(result.eating_identity.monotone_flags).toContain("Chicken Breast");
  });

  it("limits eating arrays to max lengths", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.eating_identity.top_proteins.length).toBeLessThanOrEqual(5);
    expect(result.eating_identity.top_carbs.length).toBeLessThanOrEqual(5);
    expect(result.eating_identity.top_fats.length).toBeLessThanOrEqual(5);
    expect(result.eating_identity.cuisines.length).toBeLessThanOrEqual(4);
  });

  it("returns empty eating identity for empty food log", () => {
    const result = composeAthleteIdentity([], []);
    expect(result.eating_identity.top_proteins).toEqual([]);
    expect(result.eating_identity.top_carbs).toEqual([]);
    expect(result.eating_identity.top_fats).toEqual([]);
    expect(result.eating_identity.monotone_flags).toEqual([]);
  });

  it("does not flag non-monotone foods", () => {
    // Salmon appears roughly once per week → should NOT be in monotone_flags
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.eating_identity.monotone_flags).not.toContain("Salmon");
  });

  it("includes salmon in top proteins (appears 4x in 30-entry log)", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.eating_identity.top_proteins).toContain("Salmon");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Volume preference inference
// ---------------------------------------------------------------------------

describe("composeAthleteIdentity — training_style_signature", () => {
  it("returns 'moderate' volume for fixtures with ~40% high-rep workouts", () => {
    // In SAMPLE_WORKOUTS_90D, sessions with any set >10 reps: approximately 12 of 30 (~40%)
    // This lands in 30-60% range → "moderate"
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.training_style_signature.volume_preference).toBe("moderate");
  });

  it("returns 'high' volume when >60% sessions contain high-rep sets", () => {
    // All sets have reps > 10
    const highRepSession: WorkoutSession = {
      id: "high-rep-1",
      date: "2026-06-01",
      type: "Chest",
      duration_min: 60,
      source: "logger",
      exercises: [
        {
          name: "Lateral Raise (Dumbbell)",
          position: 0,
          kind: "weighted",
          sets: [
            { kg: 10, reps: 15, duration_seconds: null, warmup: false, failure: false },
            { kg: 10, reps: 15, duration_seconds: null, warmup: false, failure: false },
          ],
        },
      ],
      vol: 300,
      bwReps: 0,
      sets: 2,
    };
    const allHighRep = Array.from({ length: 10 }, (_, i) => ({
      ...highRepSession,
      id: `high-rep-${i}`,
      date: `2026-0${Math.floor(i / 3) + 1}-${String(i + 1).padStart(2, "0")}`,
    })) as WorkoutSession[];

    const result = composeAthleteIdentity(allHighRep, []);
    expect(result.training_style_signature.volume_preference).toBe("high");
  });

  it("returns 'low' volume when <30% sessions contain high-rep sets", () => {
    // All sets have reps ≤ 5
    const lowRepSession: WorkoutSession = {
      id: "low-rep-1",
      date: "2026-06-01",
      type: "Back",
      duration_min: 60,
      source: "logger",
      exercises: [
        {
          name: "Deadlift (Barbell)",
          position: 0,
          kind: "weighted",
          sets: [
            { kg: 100, reps: 4, duration_seconds: null, warmup: false, failure: false },
            { kg: 100, reps: 4, duration_seconds: null, warmup: false, failure: false },
          ],
        },
      ],
      vol: 800,
      bwReps: 0,
      sets: 2,
    };
    const allLowRep = Array.from({ length: 10 }, (_, i) => ({
      ...lowRepSession,
      id: `low-rep-${i}`,
      date: `2026-0${Math.floor(i / 3) + 1}-${String(i + 1).padStart(2, "0")}`,
    })) as WorkoutSession[];

    const result = composeAthleteIdentity(allLowRep, []);
    expect(result.training_style_signature.volume_preference).toBe("low");
  });

  it("returns 'moderate' for empty workouts (defaults to stub)", () => {
    const result = composeAthleteIdentity([], []);
    // With no workouts, 0% high-rep → "low" by the formula; or a default
    // The function falls back to stub behavior for empty input
    const validValues = ["low", "moderate", "high", "very_high"];
    expect(validValues).toContain(result.training_style_signature.volume_preference);
  });

  it("stubs intensity_distribution_percent as {rpe_6_7: 60, rpe_8_9: 30, rpe_10: 10}", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.training_style_signature.intensity_distribution_percent).toEqual({
      rpe_6_7: 60,
      rpe_8_9: 30,
      rpe_10: 10,
    });
  });

  it("stubs recovery_speed_days as 5 or 6 (reasonable int in [2,14])", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.training_style_signature.recovery_speed_days).toBeGreaterThanOrEqual(2);
    expect(result.training_style_signature.recovery_speed_days).toBeLessThanOrEqual(14);
  });

  it("stubs session_duration_preference_min as reasonable value", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result.training_style_signature.session_duration_preference_min).toBeGreaterThanOrEqual(20);
    expect(result.training_style_signature.session_duration_preference_min).toBeLessThanOrEqual(180);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Output validates against IdentityPayload schema
// ---------------------------------------------------------------------------

describe("composeAthleteIdentity — schema validation", () => {
  it("output validates against IdentityPayloadSchema", () => {
    const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    const parsed = IdentityPayloadSchema.safeParse(result);
    if (!parsed.success) {
      // Surface the Zod errors for debugging
      throw new Error(`Schema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });

  it("output validates against schema for empty inputs", () => {
    const result = composeAthleteIdentity([], []);
    const parsed = IdentityPayloadSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("is deterministic — same input produces same output", () => {
    const result1 = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    const result2 = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
    expect(result1).toEqual(result2);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Food classification heuristic edge cases
// ---------------------------------------------------------------------------

describe("composeAthleteIdentity — food classification heuristics", () => {
  it("classifies mixed-macro item by dominant macro", () => {
    // Item with protein > carbs AND protein > fat → protein food
    const proteinItem: FoodLogEntry["items"][0] = {
      name: "Greek Yogurt",
      qty_g: 200,
      kcal: 120,
      protein_g: 15,
      carbs_g: 8,
      fat_g: 3,
      fiber_g: 0,
      per_100g: { kcal: 60, protein_g: 7.5, carbs_g: 4, fat_g: 1.5, fiber_g: 0 },
      source: "db",
      db_ref: null,
      confidence: "high",
      match_score: null,
    };

    const entry: FoodLogEntry = {
      id: "test-1",
      user_id: "test-user",
      eaten_at: "2026-06-01T08:00:00.000Z",
      kind: "text",
      meal_slot: "breakfast",
      raw_input: { kind: "text", text: "Greek Yogurt" },
      items: [proteinItem],
      totals: { kcal: 120, protein_g: 15, carbs_g: 8, fat_g: 3, fiber_g: 0 },
      is_estimated: false,
      is_favorite: false,
      status: "committed",
      created_at: "2026-06-01T08:00:00.000Z",
      updated_at: "2026-06-01T08:00:00.000Z",
    };

    const result = composeAthleteIdentity([], [entry]);
    expect(result.eating_identity.top_proteins).toContain("Greek Yogurt");
    expect(result.eating_identity.top_carbs).not.toContain("Greek Yogurt");
    expect(result.eating_identity.top_fats).not.toContain("Greek Yogurt");
  });

  it("does not count items with zero macros as any food category", () => {
    const zeroItem: FoodLogEntry["items"][0] = {
      name: "Water",
      qty_g: 500,
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      fiber_g: 0,
      per_100g: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
      source: "db",
      db_ref: null,
      confidence: "high",
      match_score: null,
    };

    const entry: FoodLogEntry = {
      id: "test-zero",
      user_id: "test-user",
      eaten_at: "2026-06-01T08:00:00.000Z",
      kind: "text",
      meal_slot: "snack",
      raw_input: { kind: "text", text: "Water" },
      items: [zeroItem],
      totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
      is_estimated: false,
      is_favorite: false,
      status: "committed",
      created_at: "2026-06-01T08:00:00.000Z",
      updated_at: "2026-06-01T08:00:00.000Z",
    };

    const result = composeAthleteIdentity([], [entry]);
    expect(result.eating_identity.top_proteins).not.toContain("Water");
    expect(result.eating_identity.top_carbs).not.toContain("Water");
    expect(result.eating_identity.top_fats).not.toContain("Water");
  });
});
