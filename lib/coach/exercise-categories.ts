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
  "shoulder press": "push",
  "push-up": "push",
  "push up": "push",
  "scapular push-ups": "push",
  "dip": "push",
  "bench dip": "push",
  "chest dip": "push",
  "tricep extension": "push",
  "triceps extension": "push",
  "tricep pushdown": "push",
  "triceps pushdown": "push",
  "skull crusher": "push",
  "close-grip bench press": "push",
  "chest fly": "push",
  "cable fly": "push",
  "pec deck": "push",

  // ── PULL ─────────────────────────────────────────────────────────────────
  "barbell row": "pull",
  "bent over row": "pull",
  "pendlay row": "pull",
  "dumbbell row": "pull",
  "seated cable row": "pull",
  "seated row": "pull",
  "t-bar row": "pull",
  "machine row": "pull",
  "pullover": "pull",
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
  "squat": "squat",
  "back squat": "squat",
  "barbell squat": "squat",
  "front squat": "squat",
  "high-bar squat": "squat",
  "low-bar squat": "squat",
  "goblet squat": "squat",
  "leg press": "squat",
  "seated leg press": "squat",
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
  "leg press single leg": "single-leg",
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
  "hip abductor": "accessory",
  "cable external rotation": "accessory",
  "cable internal rotation": "accessory",

  // NOTE on intentional omissions: mobility / warmup / breathwork moves the
  // user logs (90/90 hip mobility, ankle mobility, cat-cow, child's pose,
  // diaphragmatic breathing, hip flexor stretches, neck CARs, open books,
  // pelvic tilts, shoulder CARs, shoulder rolls, supine knee drops,
  // supported deep squat hold, thread the needle, upper trap stretch,
  // wall slides, hip hinge drill) are intentionally LEFT uncategorized.
  // Per SCHEMA_EXPLAINER, "uncategorized" is a missing-data flag: the model
  // excludes these from movement-pattern rollups, which is the right
  // behavior — these aren't strength training and shouldn't pollute volume
  // or push:pull balance answers.
  //
  // To extend: run `node scripts/audit-exercise-categories.mjs` and add any
  // newly logged strength moves above. Equipment variants with parens
  // ("Bench Press (Barbell)") are stripped by normalize() — no separate
  // entry needed.
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
