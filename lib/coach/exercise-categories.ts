// lib/coach/exercise-categories.ts
//
// Seven-bucket movement-pattern lookup. Coarser than per-muscle resolution
// (chest/quads/etc.), finer than workout.type. Lets the coach answer "am I
// doing enough push work this week?" / "any pattern I'm neglecting?" without
// the maintenance tarpit of secondary-mover weighting.
//
// Buckets:
//   push        — chest, shoulders, triceps; lateral raises; tricep isolation
//   pull        — back, lats, rear delts, biceps, face pulls
//   squat       — bilateral knee-dominant (back/front/leg-press/hack)
//   hinge       — hip-dominant (deadlift, RDL, good morning, hip thrust, swing)
//   single-leg  — unilateral lower (lunge, split squat, step-up, pistol)
//   core        — abs, obliques, anti-extension/anti-rotation
//   accessory   — calves, forearms, neck, grip, anything that doesn't fit
//   uncategorized — fallback; a missing-data flag, NOT a category. The schema
//                   explainer instructs the model to exclude these from rollups
//                   rather than infer.
//
// Lookup is on the NORMALISED key (lowercase, parens stripped, whitespace
// collapsed). Responses always carry the ORIGINAL exercise_name — otherwise
// barbell-bench-press and dumbbell-bench-press would collide in summaries
// and we'd lose progression tracking per implement.

export type ExerciseCategory =
  | "push" | "pull" | "squat" | "hinge"
  | "single-leg" | "core" | "accessory" | "uncategorized";

export const EXERCISE_CATEGORY: Record<string, ExerciseCategory> = {
  // ── PUSH ─────────────────────────────────────────────────────────────────
  "bench press": "push",
  "incline bench press": "push",
  "decline bench press": "push",
  "dumbbell bench press": "push",
  "incline dumbbell press": "push",
  "overhead press": "push",
  "seated overhead press": "push",
  "dumbbell shoulder press": "push",
  "arnold press": "push",
  "lateral raise": "push",
  "front raise": "push",
  "cable lateral raise": "push",
  "machine shoulder press": "push",
  "push-up": "push",
  "dip": "push",
  "tricep extension": "push",
  "tricep pushdown": "push",
  "skull crusher": "push",
  "close-grip bench press": "push",
  "chest fly": "push",
  "cable fly": "push",
  "pec deck": "push",

  // ── PULL ─────────────────────────────────────────────────────────────────
  "barbell row": "pull",
  "pendlay row": "pull",
  "dumbbell row": "pull",
  "seated cable row": "pull",
  "t-bar row": "pull",
  "machine row": "pull",
  "pull-up": "pull",
  "chin-up": "pull",
  "lat pulldown": "pull",
  "neutral grip pulldown": "pull",
  "face pull": "pull",
  "rear delt fly": "pull",
  "reverse fly": "pull",
  "bicep curl": "pull",
  "barbell curl": "pull",
  "dumbbell curl": "pull",
  "hammer curl": "pull",
  "preacher curl": "pull",
  "cable curl": "pull",
  "shrug": "pull",

  // ── SQUAT ────────────────────────────────────────────────────────────────
  "back squat": "squat",
  "barbell squat": "squat",
  "front squat": "squat",
  "high-bar squat": "squat",
  "low-bar squat": "squat",
  "goblet squat": "squat",
  "leg press": "squat",
  "hack squat": "squat",
  "machine squat": "squat",
  "leg extension": "squat",

  // ── HINGE ────────────────────────────────────────────────────────────────
  "deadlift": "hinge",
  "conventional deadlift": "hinge",
  "sumo deadlift": "hinge",
  "romanian deadlift": "hinge",
  "stiff-leg deadlift": "hinge",
  "good morning": "hinge",
  "hip thrust": "hinge",
  "barbell hip thrust": "hinge",
  "glute bridge": "hinge",
  "kettlebell swing": "hinge",
  "back extension": "hinge",
  "hyperextension": "hinge",
  "leg curl": "hinge",
  "lying leg curl": "hinge",
  "seated leg curl": "hinge",

  // ── SINGLE-LEG ───────────────────────────────────────────────────────────
  "lunge": "single-leg",
  "walking lunge": "single-leg",
  "reverse lunge": "single-leg",
  "split squat": "single-leg",
  "bulgarian split squat": "single-leg",
  "step-up": "single-leg",
  "single-leg press": "single-leg",
  "pistol squat": "single-leg",
  "single-leg deadlift": "single-leg",

  // ── CORE ─────────────────────────────────────────────────────────────────
  "plank": "core",
  "side plank": "core",
  "ab wheel rollout": "core",
  "hanging leg raise": "core",
  "cable crunch": "core",
  "russian twist": "core",
  "dead bug": "core",
  "pallof press": "core",
  "hollow body hold": "core",
  "sit-up": "core",
  "v-up": "core",

  // ── ACCESSORY ────────────────────────────────────────────────────────────
  "calf raise": "accessory",
  "standing calf raise": "accessory",
  "seated calf raise": "accessory",
  "donkey calf raise": "accessory",
  "wrist curl": "accessory",
  "reverse wrist curl": "accessory",
  "farmer's carry": "accessory",
  "farmers walk": "accessory",
  "neck flexion": "accessory",
  "neck extension": "accessory",

  // NOTE: This seed mapping covers the canonical names. If the SQL query in
  // Task 10 step 1 returns names not present here, add them with one of the
  // 7 buckets and re-commit. Variants with equipment in parens are stripped
  // by normalize() so the same key works for "Bench Press" and
  // "Bench Press (Barbell)".
};

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function categorize(name: string): ExerciseCategory {
  return EXERCISE_CATEGORY[normalize(name)] ?? "uncategorized";
}
