// lib/coach/intelligence/__tests__/orchestrator.test.ts
//
// Tests for the intelligence orchestrator's pure assembly path.
//
// Strategy: test assembleIntelligence() directly with fixture data (no Supabase
// mock needed). This exercises all 7 composers end-to-end and validates that
// the assembled payload conforms to AthleteIntelligencePayloadSchema.
//
// buildAthleteIntelligence() (I/O path) is NOT tested here — it requires a
// Supabase integration test. The pure assembly covers all meaningful logic.

import { describe, it, expect } from "vitest";
import { assembleIntelligence, type IntelligenceData } from "../index";
import { AthleteIntelligencePayloadSchema } from "../types";
import { SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Daily log fixtures for Layer 2 composers
// ─────────────────────────────────────────────────────────────────────────────

/** Build 56 daily log rows starting from daysAgo(n) */
function daysAgo(n: number, base = "2026-06-26"): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Build a minimal daily log row */
function makeDailyLog(
  date: string,
  opts: {
    hrv?: number | null;
    resting_hr?: number | null;
    recovery?: number | null;
    sleep_score?: number | null;
    strain?: number | null;
    weight_kg?: number | null;
    body_fat_pct?: number | null;
    fat_free_mass_kg?: number | null;
    calories_eaten?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    endurance_load?: number | null;
  } = {},
): IntelligenceData["dailyLogs"][number] {
  return {
    date,
    hrv: opts.hrv ?? 55,
    resting_hr: opts.resting_hr ?? 52,
    recovery: opts.recovery ?? 75,
    sleep_hours: 7.5,
    sleep_score: opts.sleep_score ?? 80,
    deep_sleep_hours: 1.5,
    strain: opts.strain ?? 10,
    steps: 8000,
    weight_kg: opts.weight_kg ?? 103,
    body_fat_pct: opts.body_fat_pct ?? 26,
    fat_free_mass_kg: opts.fat_free_mass_kg ?? 76,
    calories_eaten: opts.calories_eaten ?? 2400,
    protein_g: opts.protein_g ?? 190,
    carbs_g: opts.carbs_g ?? 220,
    fat_g: opts.fat_g ?? 80,
    endurance_load: opts.endurance_load ?? 0,
  };
}

/** 56 daily log rows covering the full intelligence window */
const SAMPLE_DAILY_LOGS_56D: IntelligenceData["dailyLogs"] = Array.from(
  { length: 56 },
  (_, i) => makeDailyLog(daysAgo(i), {
    weight_kg: 103 - i * 0.01, // very slow decline
    body_fat_pct: 26 - i * 0.005,
    fat_free_mass_kg: 76,
    protein_g: 190,
    calories_eaten: 2400,
    endurance_load: i < 7 ? 30 : 0, // some Z2 load in recent week
  }),
);

/** Sample baselines (healthy athlete, no alerts) */
const SAMPLE_BASELINES = {
  computed_at: "2026-06-20T10:00:00Z",
  hrv: { mean: 57, sd: 8, days: 28, status: "stable" as const },
  rhr: { mean: 52, sd: 3, days: 28, status: "stable" as const },
  recovery: { mean: 75, sd: 10, days: 28, status: "stable" as const },
  sleep_performance: { mean: 80, sd: 5, days: 28, status: "stable" as const },
  resp_rate: { mean: 15, sd: 1, days: 28, status: "stable" as const },
};

/** Minimal intake payload */
const SAMPLE_INTAKE = {
  schema_version: 1 as const,
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
    current_e1rm: { squat: 140, bench: 100, deadlift: 160, ohp: 60 },
    best_ever_pr: { squat: 145, bench: 105, deadlift: 170, ohp: 65 },
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
      mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: false,
    },
    earliest_session_time: "17:00",
    latest_session_time: "21:00",
    travel_frequency: "monthly" as const,
  },
  nutrition: {
    current_phase: "recomp" as const,
    current_kcal: 2500,
    current_macros: { protein_g: 200, carb_g: 250, fat_g: 80 },
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
    primary_type: "strength" as const,
    primary_metric: "Deadlift E1RM",
    target_value: 200,
    target_unit: "kg",
    target_date: "2026-12-31",
    why_narrative: "Build strength",
  },
};

/** Full fixture data for assembleIntelligence */
const FULL_FIXTURE_DATA: IntelligenceData = {
  workouts: SAMPLE_WORKOUTS_90D,
  dailyLogs: SAMPLE_DAILY_LOGS_56D,
  foodLogEntries: SAMPLE_FOOD_LOG_90D,
  baselines: SAMPLE_BASELINES,
  intake: SAMPLE_INTAKE,
  targets: {
    kcal: 2500,
    protein_g: 200,
    phase: "recomp",
  },
  // Empty for tests — real data comes from coach_interventions fetch in buildAthleteIntelligence
  interventionRows: [],
  today: "2026-06-26",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleIntelligence", () => {
  it("returns a payload that validates against AthleteIntelligencePayloadSchema", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    const result = AthleteIntelligencePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("payload contains all 7 top-level keys", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    expect(payload).toHaveProperty("identity");
    expect(payload).toHaveProperty("constraints");
    expect(payload).toHaveProperty("history");
    expect(payload).toHaveProperty("recovery_readiness");
    expect(payload).toHaveProperty("nutrition_performance");
    expect(payload).toHaveProperty("interference");
    expect(payload).toHaveProperty("body_comp_direction");
    expect(payload).toHaveProperty("generated_on");
  });

  it("generated_on is a valid ISO 8601 datetime anchored to today", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    expect(payload.generated_on).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(payload.generated_on).toContain("2026-06-26");
  });

  it("identity contains top_exercises and eating_identity", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    expect(payload.identity.top_exercises).toBeDefined();
    expect(payload.identity.eating_identity).toBeDefined();
    expect(payload.identity.training_style_signature).toBeDefined();
  });

  it("constraints are derived from intake (commercial_gym, no injuries)", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    // intake has barbell+rack+cables+machines → commercial_gym
    expect(payload.constraints.equipment_access).toBe("commercial_gym");
    // intake has no active_injuries → empty array
    expect(payload.constraints.active_injuries).toHaveLength(0);
  });

  it("recovery_readiness has a valid status", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    expect(["recovering_well", "stalled", "warning_overreach"]).toContain(
      payload.recovery_readiness.status,
    );
    expect(payload.recovery_readiness.confidence).toBeGreaterThan(0);
    expect(payload.recovery_readiness.confidence).toBeLessThanOrEqual(1);
  });

  it("nutrition_performance has protein_status and deficit_severity", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    expect(["adequate", "marginally_short", "critically_low"]).toContain(
      payload.nutrition_performance.protein_status,
    );
    expect([
      "appropriate",
      "aggressive_sustainable",
      "unsustainable",
      "not_in_deficit",
    ]).toContain(payload.nutrition_performance.deficit_severity);
  });

  it("interference has a valid interference_level", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    expect(["none", "mild", "high"]).toContain(
      payload.interference.interference_level,
    );
  });

  it("body_comp_direction has a valid direction and confidence ∈ [0,1]", () => {
    const payload = assembleIntelligence(FULL_FIXTURE_DATA);
    expect([
      "gaining_muscle",
      "losing_fat",
      "recomp",
      "losing_muscle",
      "neutral",
      "unknown",
    ]).toContain(payload.body_comp_direction.direction);
    expect(payload.body_comp_direction.confidence).toBeGreaterThanOrEqual(0);
    expect(payload.body_comp_direction.confidence).toBeLessThanOrEqual(1);
  });

  it("works with null intake (no athlete profile)", () => {
    const data: IntelligenceData = { ...FULL_FIXTURE_DATA, intake: null };
    const payload = assembleIntelligence(data);
    const result = AthleteIntelligencePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    // No intake → empty constraints
    expect(payload.constraints.active_injuries).toHaveLength(0);
    expect(payload.constraints.equipment_access).toBe("commercial_gym"); // default
  });

  it("works with null baselines (new user)", () => {
    const data: IntelligenceData = { ...FULL_FIXTURE_DATA, baselines: null };
    const payload = assembleIntelligence(data);
    const result = AthleteIntelligencePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    // Without baselines, recovery readiness degrades gracefully (low confidence)
    expect(payload.recovery_readiness.confidence).toBeLessThanOrEqual(0.5);
  });

  it("works with empty daily logs (no wearable data)", () => {
    const data: IntelligenceData = { ...FULL_FIXTURE_DATA, dailyLogs: [] };
    const payload = assembleIntelligence(data);
    const result = AthleteIntelligencePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    // With no logs, recovery gives safe-default narrative
    expect(payload.recovery_readiness.status).toBe("stalled");
  });

  it("works with empty workouts and food logs", () => {
    const data: IntelligenceData = {
      ...FULL_FIXTURE_DATA,
      workouts: [],
      foodLogEntries: [],
    };
    const payload = assembleIntelligence(data);
    const result = AthleteIntelligencePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    // Identity with no workouts/food → empty top_exercises, no monotone flags
    expect(payload.identity.top_exercises.lower).toHaveLength(0);
    expect(payload.identity.eating_identity.monotone_flags).toHaveLength(0);
  });
});
