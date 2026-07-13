// lib/coach/intelligence/athlete-identity.ts
//
// Composer function that analyzes 90-day workout and food-log history to
// produce an IdentityPayload: top exercises per category, eating identity
// (habitual protein/carb/fat sources + monotone detection), and a training
// style signature.
//
// Pure function — no Supabase calls, no side effects.
// Deterministic: identical input → identical output.

import type { WorkoutSession } from "@/lib/data/workouts";
import type { FoodLogEntry } from "@/lib/food/types";
import type { IdentityPayload, ExerciseCategory } from "./types";
import { IdentityPayloadSchema } from "./types";

// ---------------------------------------------------------------------------
// Exercise → category lookup
// ---------------------------------------------------------------------------
//
// Category definitions (aligned with ExerciseCategoryValues in types.ts):
//   lower      — squat-pattern, hinge-pattern, knee-dominant, hip-dominant,
//                calf, glute isolation, leg machine work
//   upper      — horizontal + vertical pressing (barbell & dumbbell),
//                chest, shoulder press patterns
//   pulls      — horizontal & vertical pulling, deadlift variants,
//                rows, pull-down, pull-overs
//   isolation  — single-joint arm work, lateral delts, rotator cuff,
//                rear delt, cable accessories
//   cardio     — treadmill, cycling, rowing machine, HIIT circuits,
//                jump rope, swimming
//   mobility   — foam rolling, stretching holds, CARs, dead hang,
//                breathing protocols, dead bug

// Keywords that map to each category, applied case-insensitively via substring
// matching. More-specific strings are checked first so "deadlift" beats "lift".
// When an exercise name contains a keyword from multiple categories the FIRST
// match wins — order matters.

type CategoryRule = { keywords: string[]; category: ExerciseCategory };

const CATEGORY_RULES: CategoryRule[] = [
  // Lower: squat and hinge patterns, knee/hip-dominant machine work.
  // NOTE: "romanian deadlift" and "rdl" are checked BEFORE the generic "deadlift"
  // pull rule so that RDL stays in lower, not pulls.
  {
    category: "lower",
    keywords: [
      "squat",
      "romanian deadlift",
      "rdl",
      "leg press",
      "leg extension",
      "leg curl",
      "hip thrust",
      "hip abductor",
      "calf raise",
      "glute bridge",
      "lunges",
      "lunge",
      "step up",
      "hack squat",
      "bulgarian",
      "split squat",
    ],
  },
  // Pulls: deadlift (barbell), back rows, pulldowns, pull-overs.
  // Arnold Press is NOT a pull and must not appear here.
  {
    category: "pulls",
    keywords: [
      "deadlift",
      "lat pulldown",
      "pulldown",
      "seated row",
      "cable row",
      "machine row",
      "barbell row",
      "dumbbell row",
      "t-bar row",
      "pullover",
      "pull-up",
      "pullup",
      "chin-up",
      "chinup",
      "shrug",
      "back extension",
      "rack pull",
      "face pull",
    ],
  },
  // Isolation: single-joint accessories, isolation machines, shoulder
  // accessories, Arnold Press (compound DB movement treated as isolation
  // shoulder accessory in this user's programme — not a primary press).
  // Intentionally checked BEFORE upper so "arnold press", "incline bench press",
  // "chest fly" are captured here first.
  {
    category: "isolation",
    keywords: [
      "arnold press",
      "bicep curl",
      "hammer curl",
      "preacher curl",
      "reverse curl",
      "front raise",
      "lateral raise",
      "rear delt",
      "incline bench press",
      "incline press",
      "incline dumbbell",
      "chest fly",
      "fly",
      "triceps",
      "skullcrusher",
      "cable curl",
      "cable external rotation",
      "cable internal rotation",
      "external rotation",
      "internal rotation",
      "wrist curl",
    ],
  },
  // Upper: primary pressing patterns — barbell bench, overhead press, push press.
  // Does NOT include incline DB press (already captured by isolation above) or
  // Arnold Press.
  {
    category: "upper",
    keywords: [
      "bench press",
      "overhead press",
      "ohp",
      "push press",
      "floor press",
      "dip",
      "push up",
      "chest press",
      "shoulder press",
      "military press",
    ],
  },
  {
    category: "cardio",
    keywords: [
      "treadmill",
      "cycling",
      "bike",
      "rowing machine",
      "hiit",
      "jump rope",
      "swimming",
      "elliptical",
      "stairmaster",
      "sprint",
      "run",
    ],
  },
  {
    category: "mobility",
    keywords: [
      "foam roll",
      "stretch",
      "dead bug",
      "shoulder car",
      "hip car",
      "car ",
      "dead hang",
      "breathing",
      "plank",
      "pallof",
      "band pull apart",
    ],
  },
];

/**
 * Classify a single exercise name into one of the ExerciseCategory values.
 * Returns null if no rule matches (exercise is uncategorised and will be skipped).
 */
function classifyExercise(name: string): ExerciseCategory | null {
  const lower = name.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) return rule.category;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top exercises
// ---------------------------------------------------------------------------

/** Count how many sessions (not sets) each exercise appeared in, grouped by
 *  category.  Returns top 5 per category sorted by count descending. */
function computeTopExercises(workouts: WorkoutSession[]): IdentityPayload["top_exercises"] {
  const counts: Record<ExerciseCategory, Map<string, number>> = {
    lower: new Map(),
    upper: new Map(),
    pulls: new Map(),
    isolation: new Map(),
    cardio: new Map(),
    mobility: new Map(),
  };

  for (const session of workouts) {
    // Use a set so each exercise is counted once per session (not once per set).
    const seenInSession = new Set<string>();
    for (const exercise of session.exercises) {
      if (seenInSession.has(exercise.name)) continue;
      const category = classifyExercise(exercise.name);
      if (!category) continue;
      seenInSession.add(exercise.name);
      counts[category].set(exercise.name, (counts[category].get(exercise.name) ?? 0) + 1);
    }
  }

  function topFive(map: Map<string, number>): string[] {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) // count desc, name asc for tie-break
      .slice(0, 5)
      .map(([name]) => name);
  }

  return {
    lower: topFive(counts.lower),
    upper: topFive(counts.upper),
    pulls: topFive(counts.pulls),
    isolation: topFive(counts.isolation),
  };
}

// ---------------------------------------------------------------------------
// Eating identity
// ---------------------------------------------------------------------------

/** Determine macro category for a single food item.
 *  Rules (from brief):
 *    protein > carbs AND protein > fat  → protein
 *    carbs > protein                    → carb
 *    fat > protein AND fat > carbs      → fat
 *
 *  Items where all macros are 0 are skipped (uncategorised). */
type MacroCategory = "protein" | "carb" | "fat";

function classifyFoodItem(
  protein_g: number,
  carbs_g: number,
  fat_g: number,
): MacroCategory | null {
  if (protein_g === 0 && carbs_g === 0 && fat_g === 0) return null;
  if (protein_g > carbs_g && protein_g > fat_g) return "protein";
  if (carbs_g > protein_g) return "carb";
  if (fat_g > protein_g && fat_g > carbs_g) return "fat";
  return null; // tie — skip
}

/** 12-week window used for monotone detection (84 days). The inputs are
 *  already expected to be 90-day slices, but we cap to 84 days as the
 *  reference period for the >3x/week threshold. */
const MONOTONE_WINDOW_DAYS = 84; // 12 weeks
const MONOTONE_THRESHOLD_PER_WEEK = 3; // appears > this many times/week

function computeEatingIdentity(
  foodLogEntries: FoodLogEntry[],
): IdentityPayload["eating_identity"] {
  const proteinCounts = new Map<string, number>();
  const carbCounts = new Map<string, number>();
  const fatCounts = new Map<string, number>();

  // Item-level occurrence counter for monotone detection (across all entries in window)
  const itemOccurrences = new Map<string, number>();

  for (const entry of foodLogEntries) {
    for (const item of entry.items) {
      const category = classifyFoodItem(item.protein_g, item.carbs_g, item.fat_g);
      if (!category) continue;

      // Frequency counts
      if (category === "protein") {
        proteinCounts.set(item.name, (proteinCounts.get(item.name) ?? 0) + 1);
      } else if (category === "carb") {
        carbCounts.set(item.name, (carbCounts.get(item.name) ?? 0) + 1);
      } else {
        fatCounts.set(item.name, (fatCounts.get(item.name) ?? 0) + 1);
      }

      // Monotone detection: count occurrences of every item regardless of category
      itemOccurrences.set(item.name, (itemOccurrences.get(item.name) ?? 0) + 1);
    }
  }

  function topFive(map: Map<string, number>): string[] {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name]) => name);
  }

  // Monotone: >3 occurrences per week over a 12-week window.
  // threshold = MONOTONE_THRESHOLD_PER_WEEK × (MONOTONE_WINDOW_DAYS / 7)
  const monotoneAbsoluteThreshold = MONOTONE_THRESHOLD_PER_WEEK * (MONOTONE_WINDOW_DAYS / 7);
  const monotoneFlags: string[] = [];
  for (const [name, count] of itemOccurrences.entries()) {
    if (count > monotoneAbsoluteThreshold) {
      monotoneFlags.push(name);
    }
  }
  // Sort monotone flags alphabetically for determinism
  monotoneFlags.sort();

  return {
    top_proteins: topFive(proteinCounts),
    top_carbs: topFive(carbCounts),
    top_fats: topFive(fatCounts),
    cuisines: [], // Phase 2 — not yet derived; empty until computed
    monotone_flags: monotoneFlags,
  };
}

// ---------------------------------------------------------------------------
// Training style signature
// ---------------------------------------------------------------------------

/** Compute volume preference based on % of sessions containing any set with
 *  reps > 10 (among non-warmup working sets).
 *
 *  >60%  → "high"
 *  30-60% → "moderate"
 *  <30%  → "low"
 *
 *  Empty input returns "low" (0% high-rep sessions). */
function computeVolumePreference(
  workouts: WorkoutSession[],
): IdentityPayload["training_style_signature"]["volume_preference"] {
  if (workouts.length === 0) return "low";

  let highRepCount = 0;
  for (const session of workouts) {
    let hasHighRep = false;
    outer: for (const exercise of session.exercises) {
      for (const set of exercise.sets) {
        if (!set.warmup && set.reps !== null && set.reps > 10) {
          hasHighRep = true;
          break outer;
        }
      }
    }
    if (hasHighRep) highRepCount++;
  }

  const pct = highRepCount / workouts.length;
  if (pct > 0.6) return "high";
  if (pct >= 0.3) return "moderate";
  return "low";
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Compose an IdentityPayload from 90-day workout and food-log history.
 *
 * @param workouts       WorkoutSession rows for the analysis window (≤ 90d).
 * @param foodLogEntries FoodLogEntry rows for the analysis window (≤ 90d).
 * @returns IdentityPayload validated against IdentityPayloadSchema.
 */
export function composeAthleteIdentity(
  workouts: WorkoutSession[],
  foodLogEntries: FoodLogEntry[],
): IdentityPayload {
  const top_exercises = computeTopExercises(workouts);
  const eating_identity = computeEatingIdentity(foodLogEntries);
  const volume_preference = computeVolumePreference(workouts);

  const payload: IdentityPayload = {
    top_exercises,
    eating_identity,
    training_style_signature: {
      volume_preference,
      // Phase 2 — not yet derived; null until computed
      intensity_distribution_percent: null,
      // Phase 2 — not yet derived; null until computed
      recovery_speed_days: null,
      // Phase 2 — not yet derived; null until computed
      session_duration_preference_min: null,
    },
  };

  // Validate before returning — will throw if schema is violated, which
  // surfaces bugs early rather than silently passing bad data downstream.
  const parsed = IdentityPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `composeAthleteIdentity: output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return parsed.data;
}
