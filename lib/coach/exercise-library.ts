// lib/coach/exercise-library.ts
//
// Strength exercise catalog for Coach Carter. Sub-project 1 of 2: ships the
// data shape, ~57 seed entries, and a pure `findSubstitutes` scoring function.
// Sub-project 2 will add swap-write tools and a stall detector that consume
// this library.
//
// Why a const file instead of a DB table: single-user app, no per-user
// customization in v1, and Carter's tool calls don't need SQL — they filter
// in memory. Promotable to a Postgres table if a "user adds custom exercise"
// feature ever lands.
//
// Source of truth for *which* exercises the athlete trains week-to-week is
// still `lib/coach/sessionPlans.ts`; the library is additive — it's the menu,
// not the meal plan.

import type { TargetedMuscleGroup } from "@/lib/data/types";
import type { ExerciseCategory } from "@/lib/coach/exercise-categories";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExerciseRole = "main" | "accessory";

/** Stability tier: how much the athlete must stabilize the load themselves.
 *  Lower stability = more isolated muscle work, less systemic fatigue cost.
 *  high = athlete-stabilized compound (back squat, OHP, deadlift)
 *  medium = compound with external stabilization (leg press, DB bench)
 *  low = isolated, machine-stabilized (leg extension, chest fly, cable) */
export type StabilityTier = "high" | "medium" | "low";

/** Where in the ROM the exercise peaks tension.
 *  lengthened = loads the muscle in the stretched position (RDL, DB fly)
 *  shortened  = peaks at contraction (leg ext, cable pulldown)
 *  midrange   = peaks mid-ROM (barbell bench)
 *  neutral    = no clear bias */
export type ROMBias = "lengthened" | "midrange" | "shortened" | "neutral";

export type Equipment =
  | "barbell" | "dumbbell" | "machine" | "cable"
  | "bodyweight" | "kettlebell" | "smith";

export type JointStress = "shoulder" | "lumbar" | "knee" | "elbow" | "wrist" | "hip";

/** Microloadability. Drives Carter's progression suggestions.
 *  fine     = microloadable (cables, plate-loaded machines with 1.25 kg)
 *  moderate = std plates (2.5 kg increments on barbell)
 *  coarse   = big jumps only (gym DBs, stack machines at 5 kg) */
export type Loadability = "fine" | "moderate" | "coarse";

export type SkillDemand = "low" | "medium" | "high";

export type LibraryExercise = {
  /** Stable slug. Lowercase, underscore-separated. Used by get_substitutes. */
  id: string;
  /** Display name. Matches sessionPlans.ts format where overlap. */
  name: string;
  pattern: ExerciseCategory;
  primaryMuscle: TargetedMuscleGroup;
  secondaryMuscles?: readonly TargetedMuscleGroup[];
  equipment: readonly Equipment[];
  stability: StabilityTier;
  romBias: ROMBias;
  skill: SkillDemand;
  jointStress: readonly JointStress[];
  loadability: Loadability;
  role: ExerciseRole;
  increment?: { step: number; intermediate?: number };
  notes?: string;
};

// ── Seed data (populated in Task 2) ──────────────────────────────────────────

export const EXERCISE_LIBRARY: readonly LibraryExercise[] = [
  // ── PUSH — Chest ────────────────────────────────────────────────────────────
  {
    id: "decline_bench",
    name: "Decline Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Chest day primary.",
  },
  {
    id: "flat_bench",
    name: "Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "flat_bench_db",
    name: "Bench Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "incline_bench",
    name: "Incline Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "incline_db",
    name: "Incline Bench Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
    increment: { step: 2 },
  },
  {
    id: "decline_db",
    name: "Decline Bench Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "machine_chest_press",
    name: "Chest Press (Machine)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "chest_fly",
    name: "Chest Fly",
    pattern: "push",
    primaryMuscle: "Chest",
    equipment: ["cable", "dumbbell"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2.3 },
    notes: "Athlete's current Chest day isolation. Cable or DB acceptable.",
  },
  {
    id: "pec_deck",
    name: "Pec Deck (Machine)",
    pattern: "push",
    primaryMuscle: "Chest",
    equipment: ["machine"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "push_up",
    name: "Push Up",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder", "wrist"],
    loadability: "coarse",
    role: "accessory",
    notes: "Athlete's current Chest day warmup.",
  },
  {
    id: "dip",
    name: "Dip",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },

  // ── PUSH — Shoulder ────────────────────────────────────────────────────────
  {
    id: "overhead_press",
    name: "Overhead Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow", "lumbar"],
    loadability: "moderate",
    role: "main",
    increment: { step: 5 },
    notes: "Athlete's current Chest day secondary press. Primary muscle 'Traps' here is the volume-landmarks proxy for delts.",
  },
  {
    id: "seated_db_press",
    name: "Seated Shoulder Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "arnold_press",
    name: "Arnold Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "machine_shoulder_press",
    name: "Shoulder Press (Machine)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "lateral_raise",
    name: "Lateral Raise (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    equipment: ["dumbbell"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
    increment: { step: 2 },
    notes: "Athlete's current Chest day delt isolation.",
  },
  {
    id: "cable_lateral_raise",
    name: "Lateral Raise (Cable)",
    pattern: "push",
    primaryMuscle: "Traps",
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },

  // ── PUSH — Triceps ─────────────────────────────────────────────────────────
  {
    id: "triceps_pushdown",
    name: "Triceps Pushdown (Cable)",
    pattern: "push",
    primaryMuscle: "Triceps",
    equipment: ["cable"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 2.5 },
    notes: "Athlete's current Chest day triceps isolation.",
  },
  {
    id: "overhead_cable_extension",
    name: "Overhead Triceps Extension (Cable)",
    pattern: "push",
    primaryMuscle: "Triceps",
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["elbow", "shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "skull_crusher",
    name: "Skull Crusher (EZ Bar)",
    pattern: "push",
    primaryMuscle: "Triceps",
    equipment: ["barbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "close_grip_bench",
    name: "Close-Grip Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Triceps",
    secondaryMuscles: ["Chest"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "accessory",
  },

  // ── PULL — Lats ────────────────────────────────────────────────────────────
  {
    id: "lat_pulldown",
    name: "Lat Pulldown (Cable)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Back day lat isolation.",
  },
  {
    id: "neutral_pulldown",
    name: "Lat Pulldown — Neutral Grip (Cable)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "pull_up",
    name: "Pull-Up",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "chin_up",
    name: "Chin-Up",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "seated_row_machine",
    name: "Seated Row (Machine)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Back day mid-back work.",
  },
  {
    id: "seated_cable_row",
    name: "Seated Row (Cable)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["cable"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder", "elbow", "lumbar"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "dumbbell_row",
    name: "Single-Arm Row (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow", "lumbar"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "tbar_row",
    name: "T-Bar Row",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "lumbar"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "pullover_db",
    name: "Pullover (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Chest"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
    increment: { step: 2 },
    notes: "Athlete's current Back day lat-stretch finisher.",
  },

  // ── PULL — Rear delts ──────────────────────────────────────────────────────
  {
    id: "face_pull",
    name: "Face Pull (Cable)",
    pattern: "pull",
    primaryMuscle: "RearDelts",
    equipment: ["cable"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "rear_delt_fly",
    name: "Rear Delt Fly (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "RearDelts",
    equipment: ["dumbbell"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "reverse_pec_deck",
    name: "Reverse Pec Deck (Machine)",
    pattern: "pull",
    primaryMuscle: "RearDelts",
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },

  // ── PULL — Traps ───────────────────────────────────────────────────────────
  {
    id: "shrug_bb",
    name: "Shrug (Barbell)",
    pattern: "pull",
    primaryMuscle: "Traps",
    equipment: ["barbell"],
    stability: "high",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "moderate",
    role: "accessory",
    increment: { step: 2.5 },
    notes: "Athlete's current Back day trap isolation.",
  },
  {
    id: "shrug_db",
    name: "Shrug (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Traps",
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "cable_shrug",
    name: "Shrug (Cable)",
    pattern: "pull",
    primaryMuscle: "Traps",
    equipment: ["cable"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },

  // ── PULL — Biceps ──────────────────────────────────────────────────────────
  {
    id: "barbell_curl",
    name: "Barbell Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["barbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow", "wrist"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "db_curl",
    name: "Dumbbell Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow", "wrist"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "hammer_curl",
    name: "Hammer Curl (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "preacher_curl",
    name: "Preacher Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["barbell", "dumbbell"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "cable_curl",
    name: "Cable Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["cable"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "fine",
    role: "accessory",
  },

  // ── SQUAT — Quads ──────────────────────────────────────────────────────────
  {
    id: "back_squat",
    name: "Squat (Barbell)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes", "Hams"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "high",
    jointStress: ["knee", "hip", "lumbar"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Legs day primary.",
  },
  {
    id: "front_squat",
    name: "Front Squat (Barbell)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "high",
    jointStress: ["knee", "hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "leg_press",
    name: "Leg Press",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee", "hip"],
    loadability: "moderate",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Legs day quad volume.",
  },
  {
    id: "hack_squat",
    name: "Hack Squat (Machine)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "leg_extension",
    name: "Leg Extension (Machine)",
    pattern: "squat",
    primaryMuscle: "Quads",
    equipment: ["machine"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["knee"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2.5 },
    notes: "Athlete's current Legs day quad isolation.",
  },
  {
    id: "goblet_squat",
    name: "Goblet Squat (Dumbbell)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee", "hip"],
    loadability: "coarse",
    role: "accessory",
  },

  // ── HINGE — Hams / Glutes ──────────────────────────────────────────────────
  {
    id: "deadlift",
    name: "Deadlift (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes", "Lats", "Traps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "lengthened",
    skill: "high",
    jointStress: ["lumbar", "hip", "knee"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Back day posterior-chain primary.",
  },
  {
    id: "romanian_deadlift",
    name: "Romanian Deadlift (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["lumbar", "hip"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Legs day hinge.",
  },
  {
    id: "stiff_leg_dl",
    name: "Stiff-Leg Deadlift (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["lumbar", "hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "hip_thrust",
    name: "Hip Thrust (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Glutes",
    secondaryMuscles: ["Hams"],
    equipment: ["barbell"],
    stability: "medium",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "glute_bridge",
    name: "Glute Bridge (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Glutes",
    secondaryMuscles: ["Hams"],
    equipment: ["barbell", "bodyweight"],
    stability: "medium",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "seated_leg_curl",
    name: "Seated Leg Curl (Machine)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    equipment: ["machine"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["knee"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2.3 },
    notes: "Athlete's current Legs day hamstring isolation.",
  },
  {
    id: "lying_leg_curl",
    name: "Lying Leg Curl (Machine)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "back_extension",
    name: "Back Extension",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["lumbar", "hip"],
    loadability: "coarse",
    role: "accessory",
    notes: "Athlete's current Back day posterior-chain finisher.",
  },

  // ── ACCESSORY — Calves / Hip abduction ─────────────────────────────────────
  {
    id: "seated_calf",
    name: "Seated Calf Raise",
    pattern: "accessory",
    primaryMuscle: "Calves",
    equipment: ["machine"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: [],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Legs day calf work.",
  },
  {
    id: "standing_calf",
    name: "Standing Calf Raise",
    pattern: "accessory",
    primaryMuscle: "Calves",
    equipment: ["machine"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: [],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "hip_abductor",
    name: "Hip Abductor (Machine)",
    pattern: "accessory",
    primaryMuscle: "Glutes",
    equipment: ["machine"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2 },
    notes: "Athlete's current Legs day hip work.",
  },

  // ── ACCESSORY — Glutes (additional coverage) ───────────────────────────────
  {
    id: "cable_kickback",
    name: "Glute Kickback (Cable)",
    pattern: "accessory",
    primaryMuscle: "Glutes",
    secondaryMuscles: ["Hams"],
    equipment: ["cable"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "standing_hip_abduction",
    name: "Standing Hip Abduction (Cable)",
    pattern: "accessory",
    primaryMuscle: "Glutes",
    equipment: ["cable"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "fine",
    role: "accessory",
  },

  // ── ACCESSORY — Calves (additional coverage) ───────────────────────────────
  {
    id: "leg_press_calf_raise",
    name: "Calf Press on Leg Press (Machine)",
    pattern: "accessory",
    primaryMuscle: "Calves",
    equipment: ["machine"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: [],
    loadability: "moderate",
    role: "accessory",
  },
];

// ── Lookup helpers ───────────────────────────────────────────────────────────

/** Resolve a library entry by id OR display name (case-insensitive). Returns
 *  null when no match. Used by get_substitutes so the chat tool accepts either
 *  the slug ("decline_bench") or the display name ("Decline Bench Press (Barbell)"). */
export function resolveExercise(idOrName: string): LibraryExercise | null {
  const needle = idOrName.trim().toLowerCase();
  for (const ex of EXERCISE_LIBRARY) {
    if (ex.id.toLowerCase() === needle) return ex;
    if (ex.name.toLowerCase() === needle) return ex;
  }
  return null;
}

// ── findSubstitutes ──────────────────────────────────────────────────────────

export type SubstituteOptions = {
  count?: number;
  excludeJoint?: JointStress;
  preferStability?: StabilityTier;
  preferRomBias?: ROMBias;
};

/** Pure scoring algorithm. Returns up to `count` substitutes (default 3) for
 *  `target`, drawn from `library`. Hard filters: same pattern, same primary
 *  muscle, exclude the target itself, exclude any candidate whose jointStress
 *  contains `excludeJoint` when provided. Soft score (higher = better):
 *    +3 if role matches target
 *    +2 if stability matches preferStability (or target's stability)
 *    +2 if romBias matches preferRomBias (or target's romBias)
 *    +1 per overlapping equipment entry
 *    +1 if loadability matches target's
 *    -1 per jointStress entry the candidate has that target lacks */
export function findSubstitutes(
  target: LibraryExercise,
  library: readonly LibraryExercise[],
  options?: SubstituteOptions,
): LibraryExercise[] {
  const count = options?.count ?? 3;
  const preferStability = options?.preferStability ?? target.stability;
  const preferRomBias = options?.preferRomBias ?? target.romBias;
  const excludeJoint = options?.excludeJoint;

  type Scored = { ex: LibraryExercise; score: number };
  const scored: Scored[] = [];

  for (const ex of library) {
    if (ex.id === target.id) continue;
    if (ex.pattern !== target.pattern) continue;
    if (ex.primaryMuscle !== target.primaryMuscle) continue;
    if (excludeJoint && ex.jointStress.includes(excludeJoint)) continue;

    let score = 0;
    if (ex.role === target.role) score += 3;
    if (ex.stability === preferStability) score += 2;
    if (ex.romBias === preferRomBias) score += 2;
    for (const eq of ex.equipment) {
      if (target.equipment.includes(eq)) score += 1;
    }
    if (ex.loadability === target.loadability) score += 1;
    for (const j of ex.jointStress) {
      if (!target.jointStress.includes(j)) score -= 1;
    }

    scored.push({ ex, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.ex);
}
