// lib/coach/intelligence/__tests__/constraints.test.ts
//
// Test suite for composeConstraints: validates that active injuries,
// exercise exclusions, equipment access, and schedule constraints are
// extracted correctly from athlete profile documents.

import { expect, test } from "vitest";
import { composeConstraints } from "../constraints-summary";
import { SAMPLE_PROFILE } from "./fixtures";

test("composeConstraints extracts active injuries with correct status", () => {
  const result = composeConstraints(SAMPLE_PROFILE);

  expect(result.active_injuries).toHaveLength(1);
  expect(result.active_injuries[0].area).toBe("shoulder");
  // weeks_since_onset = 3, which is < 4, so status should be "acute"
  expect(result.active_injuries[0].status).toBe("acute");
  expect(result.active_injuries[0].weeks_ago_onset).toBe(3);
});

test("composeConstraints marks injury as chronic when weeks_ago_onset >= 4", () => {
  const profile = {
    ...SAMPLE_PROFILE,
    athlete_profile_documents: [
      {
        ...SAMPLE_PROFILE.athlete_profile_documents[0],
        current_injuries: [
          {
            area: "knee",
            severity: "moderate",
            weeks_since_onset: 8, // >= 4, so "chronic"
            exercises_to_avoid: ["Squat", "Leg Press"],
          },
        ],
      },
    ],
  };

  const result = composeConstraints(profile);

  expect(result.active_injuries[0].status).toBe("chronic");
  expect(result.active_injuries[0].weeks_ago_onset).toBe(8);
});

test("composeConstraints extracts exercise exclusions from all injuries", () => {
  const result = composeConstraints(SAMPLE_PROFILE);

  expect(result.exercise_exclusions).toContain("OHP");
  expect(result.exercise_exclusions).toContain("Weighted Chins");
  expect(result.exercise_exclusions).toContain("Heavy Bench Press");
});

test("composeConstraints flattens exercise exclusions into a Set", () => {
  const profile = {
    ...SAMPLE_PROFILE,
    athlete_profile_documents: [
      {
        ...SAMPLE_PROFILE.athlete_profile_documents[0],
        current_injuries: [
          {
            area: "shoulder",
            severity: "mild",
            weeks_since_onset: 2,
            exercises_to_avoid: ["OHP", "Bench Press"],
          },
          {
            area: "elbow",
            severity: "mild",
            weeks_since_onset: 1,
            exercises_to_avoid: ["Bench Press", "Triceps Dip"],
          },
        ],
      },
    ],
  };

  const result = composeConstraints(profile);

  // Should have deduplicated "Bench Press"
  expect(new Set(result.exercise_exclusions).size).toBe(
    result.exercise_exclusions.length
  );
  expect(result.exercise_exclusions).toContain("OHP");
  expect(result.exercise_exclusions).toContain("Bench Press");
  expect(result.exercise_exclusions).toContain("Triceps Dip");
});

test("composeConstraints maps gym_type to equipment_access", () => {
  const result = composeConstraints(SAMPLE_PROFILE);

  // gym_type = "commercial" should map to "full_gym"
  expect(result.equipment_access).toBe("full_gym");
});

test("composeConstraints maps home gym correctly", () => {
  const profile = {
    ...SAMPLE_PROFILE,
    athlete_profile_documents: [
      {
        ...SAMPLE_PROFILE.athlete_profile_documents[0],
        gym_type: "home",
      },
    ],
  };

  const result = composeConstraints(profile);

  expect(result.equipment_access).toBe("home_full");
});

test("composeConstraints defaults to hotel for unknown gym_type", () => {
  const profile = {
    ...SAMPLE_PROFILE,
    athlete_profile_documents: [
      {
        ...SAMPLE_PROFILE.athlete_profile_documents[0],
        gym_type: "unknown",
      },
    ],
  };

  const result = composeConstraints(profile);

  expect(result.equipment_access).toBe("hotel");
});

test("composeConstraints extracts schedule constraints from keywords", () => {
  const result = composeConstraints(SAMPLE_PROFILE);

  expect(result.schedule_constraints).toContain("Max 3 sessions/week");
  expect(result.schedule_constraints).toContain("Training evenings only");
});

test("composeConstraints detects travel frequency constraint", () => {
  const result = composeConstraints(SAMPLE_PROFILE);

  expect(result.schedule_constraints).toContain("Travel every 3rd week");
});

test("composeConstraints handles null profile gracefully", () => {
  const result = composeConstraints(null);

  expect(result.active_injuries).toEqual([]);
  expect(result.exercise_exclusions).toEqual([]);
  expect(result.equipment_access).toBe("full_gym");
  expect(result.schedule_constraints).toEqual([]);
});

test("composeConstraints handles missing athlete_profile_documents", () => {
  const profile = {
    user_id: "test-user",
    athlete_profile_documents: undefined,
  };

  const result = composeConstraints(profile);

  expect(result.active_injuries).toEqual([]);
  expect(result.exercise_exclusions).toEqual([]);
  expect(result.equipment_access).toBe("full_gym");
  expect(result.schedule_constraints).toEqual([]);
});

test("composeConstraints handles empty athlete_profile_documents", () => {
  const profile = {
    user_id: "test-user",
    athlete_profile_documents: [],
  };

  const result = composeConstraints(profile);

  expect(result.active_injuries).toEqual([]);
  expect(result.exercise_exclusions).toEqual([]);
  expect(result.equipment_access).toBe("full_gym");
  expect(result.schedule_constraints).toEqual([]);
});

test("composeConstraints handles missing current_injuries", () => {
  const profile = {
    ...SAMPLE_PROFILE,
    athlete_profile_documents: [
      {
        ...SAMPLE_PROFILE.athlete_profile_documents[0],
        current_injuries: undefined,
      },
    ],
  };

  const result = composeConstraints(profile);

  expect(result.active_injuries).toEqual([]);
  expect(result.exercise_exclusions).toEqual([]);
});

test("composeConstraints handles missing lifestyle_constraints", () => {
  const profile = {
    ...SAMPLE_PROFILE,
    athlete_profile_documents: [
      {
        ...SAMPLE_PROFILE.athlete_profile_documents[0],
        lifestyle_constraints: undefined,
      },
    ],
  };

  const result = composeConstraints(profile);

  expect(result.schedule_constraints).toEqual([]);
});

test("composeConstraints validates return type against ConstraintPayloadSchema", () => {
  const result = composeConstraints(SAMPLE_PROFILE);

  // Verify structure matches ConstraintPayload
  expect(result).toHaveProperty("active_injuries");
  expect(result).toHaveProperty("exercise_exclusions");
  expect(result).toHaveProperty("equipment_access");
  expect(result).toHaveProperty("schedule_constraints");

  expect(Array.isArray(result.active_injuries)).toBe(true);
  expect(Array.isArray(result.exercise_exclusions)).toBe(true);
  expect(typeof result.equipment_access).toBe("string");
  expect(Array.isArray(result.schedule_constraints)).toBe(true);

  // Validate equipment_access is one of the allowed values
  expect(["full_gym", "home_basic", "home_full", "bodyweight_only", "hotel"]).toContain(
    result.equipment_access
  );
});
