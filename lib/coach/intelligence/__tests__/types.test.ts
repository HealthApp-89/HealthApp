// lib/coach/intelligence/__tests__/types.test.ts
//
// Zod schema validation tests for the intelligence layer payload types.
// Run via: npx vitest lib/coach/intelligence/__tests__/types.test.ts

import { describe, it, expect } from "vitest";
import {
  IdentityPayloadSchema,
  ConstraintPayloadSchema,
  HistoryPayloadSchema,
  AthleteIntelligencePayloadSchema,
  TopExercisesPayloadSchema,
  EatingIdentityPayloadSchema,
  TrainingStyleSignatureSchema,
  InjuryRecordSchema,
  DeloadRecordSchema,
  ExerciseSwapRecordSchema,
  NutritionInterventionSchema,
} from "../types";

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

const validTrainingStyle = {
  volume_preference: "moderate",
  intensity_distribution_percent: { rpe_6_7: 40, rpe_8_9: 50, rpe_10: 10 },
  recovery_speed_days: 3,
  session_duration_preference_min: 60,
};

const validTopExercises = {
  lower: ["Squat", "RDL"],
  upper: ["Bench Press", "Arnold Press"],
  pulls: ["Pull-up", "Cable Row"],
  isolation: ["Curl", "Lateral Raise"],
};

const validEatingIdentity = {
  top_proteins: ["Chicken", "Eggs"],
  top_carbs: ["Rice", "Oats"],
  top_fats: ["Olive Oil", "Almonds"],
  cuisines: ["Lebanese", "Mediterranean"],
  monotone_flags: ["breakfast"],
};

const validIdentity = {
  top_exercises: validTopExercises,
  eating_identity: validEatingIdentity,
  training_style_signature: validTrainingStyle,
};

const validConstraint = {
  active_injuries: [
    { area: "lower_back", status: "recovering", weeks_ago_onset: 3 },
  ],
  exercise_exclusions: ["Good Morning"],
  equipment_access: "full_gym",
  schedule_constraints: ["no_early_mornings"],
};

const validHistory = {
  recent_deloads: [
    {
      date: "2026-05-01",
      type: "planned",
      hrv_recovery_days: 5,
      success: true,
    },
  ],
  exercise_swaps_8w: [
    {
      from: "Barbell Squat",
      to: "Leg Press",
      reason: "knee_discomfort",
      result: "kept",
      date: "2026-05-15",
    },
  ],
  nutrition_interventions: [
    {
      intervention: "increased_protein_to_180g",
      duration_weeks: 4,
      effect_measured: "muscle_retention",
      effect_value: 0.5,
      adopted: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// IdentityPayload
// ---------------------------------------------------------------------------

describe("IdentityPayloadSchema", () => {
  it("accepts a valid IdentityPayload", () => {
    const result = IdentityPayloadSchema.safeParse(validIdentity);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid volume_preference enum value", () => {
    const invalid = {
      ...validIdentity,
      training_style_signature: {
        ...validTrainingStyle,
        volume_preference: "extreme", // not in enum
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects intensity_distribution_percent that does not sum to 100", () => {
    const invalid = {
      ...validIdentity,
      training_style_signature: {
        ...validTrainingStyle,
        intensity_distribution_percent: { rpe_6_7: 50, rpe_8_9: 50, rpe_10: 10 }, // sums to 110
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects recovery_speed_days below minimum (2)", () => {
    const invalid = {
      ...validIdentity,
      training_style_signature: {
        ...validTrainingStyle,
        recovery_speed_days: 1, // below min of 2
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects recovery_speed_days above maximum (14)", () => {
    const invalid = {
      ...validIdentity,
      training_style_signature: {
        ...validTrainingStyle,
        recovery_speed_days: 15, // above max of 14
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects session_duration_preference_min below minimum (20)", () => {
    const invalid = {
      ...validIdentity,
      training_style_signature: {
        ...validTrainingStyle,
        session_duration_preference_min: 10, // below min of 20
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects top_proteins array exceeding max length of 5", () => {
    const invalid = {
      ...validIdentity,
      eating_identity: {
        ...validEatingIdentity,
        top_proteins: ["A", "B", "C", "D", "E", "F"], // 6 items, max is 5
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects cuisines array exceeding max length of 4", () => {
    const invalid = {
      ...validIdentity,
      eating_identity: {
        ...validEatingIdentity,
        cuisines: ["A", "B", "C", "D", "E"], // 5 items, max is 4
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects top_exercises slot exceeding max length of 5", () => {
    const invalid = {
      ...validIdentity,
      top_exercises: {
        ...validTopExercises,
        lower: ["A", "B", "C", "D", "E", "F"], // 6 items, max is 5
      },
    };
    const result = IdentityPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field (top_exercises)", () => {
    const { top_exercises: _omitted, ...rest } = validIdentity;
    const result = IdentityPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConstraintPayload
// ---------------------------------------------------------------------------

describe("ConstraintPayloadSchema", () => {
  it("accepts a valid ConstraintPayload with active injuries", () => {
    const result = ConstraintPayloadSchema.safeParse(validConstraint);
    expect(result.success).toBe(true);
  });

  it("accepts a ConstraintPayload with no active injuries", () => {
    const result = ConstraintPayloadSchema.safeParse({
      ...validConstraint,
      active_injuries: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid equipment_access enum value", () => {
    const invalid = {
      ...validConstraint,
      equipment_access: "outdoor", // not in enum
    };
    const result = ConstraintPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects an InjuryRecord with an invalid status enum", () => {
    const invalid = {
      ...validConstraint,
      active_injuries: [
        { area: "knee", status: "healed", weeks_ago_onset: 2 }, // 'healed' not in enum
      ],
    };
    const result = ConstraintPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects an InjuryRecord with negative weeks_ago_onset", () => {
    const invalid = {
      ...validConstraint,
      active_injuries: [
        { area: "knee", status: "acute", weeks_ago_onset: -1 },
      ],
    };
    const result = ConstraintPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects missing equipment_access field", () => {
    const { equipment_access: _omitted, ...rest } = validConstraint;
    const result = ConstraintPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HistoryPayload
// ---------------------------------------------------------------------------

describe("HistoryPayloadSchema", () => {
  it("accepts a valid HistoryPayload", () => {
    const result = HistoryPayloadSchema.safeParse(validHistory);
    expect(result.success).toBe(true);
  });

  it("accepts a HistoryPayload with empty arrays", () => {
    const result = HistoryPayloadSchema.safeParse({
      recent_deloads: [],
      exercise_swaps_8w: [],
      nutrition_interventions: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects recent_deloads exceeding max length of 5", () => {
    const deload = {
      date: "2026-01-01",
      type: "planned",
      hrv_recovery_days: 4,
      success: true,
    };
    const result = HistoryPayloadSchema.safeParse({
      ...validHistory,
      recent_deloads: [deload, deload, deload, deload, deload, deload], // 6 items, max is 5
    });
    expect(result.success).toBe(false);
  });

  it("rejects exercise_swaps_8w exceeding max length of 10", () => {
    const swap = {
      from: "A",
      to: "B",
      reason: "injury",
      result: "kept",
      date: "2026-05-01",
    };
    const result = HistoryPayloadSchema.safeParse({
      ...validHistory,
      exercise_swaps_8w: Array(11).fill(swap), // 11 items, max is 10
    });
    expect(result.success).toBe(false);
  });

  it("rejects nutrition_interventions exceeding max length of 6", () => {
    const intervention = {
      intervention: "test",
      duration_weeks: 2,
      effect_measured: "weight",
      effect_value: 1.0,
      adopted: true,
    };
    const result = HistoryPayloadSchema.safeParse({
      ...validHistory,
      nutrition_interventions: Array(7).fill(intervention), // 7 items, max is 6
    });
    expect(result.success).toBe(false);
  });

  it("rejects a DeloadRecord with an invalid type enum", () => {
    const result = HistoryPayloadSchema.safeParse({
      ...validHistory,
      recent_deloads: [
        {
          date: "2026-05-01",
          type: "emergency", // not in enum
          hrv_recovery_days: 5,
          success: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a DeloadRecord with an invalid date format", () => {
    const result = HistoryPayloadSchema.safeParse({
      ...validHistory,
      recent_deloads: [
        {
          date: "May 1 2026", // not YYYY-MM-DD
          type: "planned",
          hrv_recovery_days: 5,
          success: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a NutritionIntervention with duration_weeks < 1", () => {
    const result = HistoryPayloadSchema.safeParse({
      ...validHistory,
      nutrition_interventions: [
        {
          intervention: "test",
          duration_weeks: 0, // must be int >= 1
          effect_measured: "weight",
          effect_value: 1.0,
          adopted: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an ExerciseSwapRecord with an invalid result enum", () => {
    const result = HistoryPayloadSchema.safeParse({
      ...validHistory,
      exercise_swaps_8w: [
        {
          from: "Squat",
          to: "Leg Press",
          reason: "knee",
          result: "abandoned", // not in enum
          date: "2026-05-15",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AthleteIntelligencePayload
// ---------------------------------------------------------------------------

describe("AthleteIntelligencePayloadSchema", () => {
  const validPayload = {
    identity: validIdentity,
    constraints: validConstraint,
    history: validHistory,
    generated_on: "2026-06-26T08:00:00.000Z",
  };

  it("accepts a valid AthleteIntelligencePayload", () => {
    const result = AthleteIntelligencePayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects a non-ISO-datetime generated_on", () => {
    const result = AthleteIntelligencePayloadSchema.safeParse({
      ...validPayload,
      generated_on: "2026-06-26", // date only, not datetime
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing generated_on", () => {
    const { generated_on: _omitted, ...rest } = validPayload;
    const result = AthleteIntelligencePayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing identity section", () => {
    const { identity: _omitted, ...rest } = validPayload;
    const result = AthleteIntelligencePayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing constraints section", () => {
    const { constraints: _omitted, ...rest } = validPayload;
    const result = AthleteIntelligencePayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
