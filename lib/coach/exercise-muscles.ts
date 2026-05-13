// Static muscle-group mapping for strength sessions.
// Muscle IDs mirror the wger project (https://github.com/wger-project/wger).
// We add id 17 (posterior deltoid) which wger doesn't ship separately.

import type { WorkoutExercise } from "@/lib/data/workouts";

export const MUSCLE_ID = {
  Biceps: 1,
  FrontDelts: 2,
  Serratus: 3,
  Chest: 4,
  Triceps: 5,
  Abs: 6,
  Calves: 7,
  Glutes: 8,
  Traps: 9,
  Quads: 10,
  Hams: 11,
  Lats: 12,
  Brachialis: 13,
  Obliques: 14,
  Soleus: 15,
  RearDelts: 17,
} as const;

export type MuscleId = (typeof MUSCLE_ID)[keyof typeof MUSCLE_ID];

export const MUSCLE_NAMES: Record<MuscleId, string> = {
  1: "Biceps",
  2: "Front delts",
  3: "Serratus",
  4: "Chest",
  5: "Triceps",
  6: "Abs",
  7: "Calves",
  8: "Glutes",
  9: "Traps",
  10: "Quads",
  11: "Hams",
  12: "Lats",
  13: "Brachialis",
  14: "Obliques",
  15: "Soleus",
  17: "Rear delts",
};

/** Which body view (front or back) each muscle renders on. */
export const MUSCLE_VIEW: Record<MuscleId, "front" | "back"> = {
  1: "front",
  2: "front",
  3: "front",
  4: "front",
  5: "back",
  6: "front",
  7: "back",
  8: "back",
  9: "back",
  10: "front",
  11: "back",
  12: "back",
  13: "front",
  14: "front",
  15: "back",
  17: "back",
};

export type MuscleMapping = {
  primary: MuscleId[];
  secondary: MuscleId[];
};

const M = MUSCLE_ID;

/**
 * Strong exercise name (normalized: lowercase, parens stripped, single spaces)
 * mapped to its primary + secondary muscles. Extend as new exercises appear in
 * the user's Strong exports.
 */
export const EXERCISE_MUSCLES: Record<string, MuscleMapping> = {
  // ----- Chest -----
  "bench press":            { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "incline bench press":    { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "incline dumbbell press": { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "dumbbell bench press":   { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "decline bench press":    { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "cable fly":              { primary: [M.Chest], secondary: [M.FrontDelts] },
  "dumbbell fly":           { primary: [M.Chest], secondary: [M.FrontDelts] },
  "pec deck":               { primary: [M.Chest], secondary: [M.FrontDelts] },
  "dip":                    { primary: [M.Chest, M.Triceps], secondary: [M.FrontDelts] },
  "push up":                { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },

  // ----- Back -----
  "pull up":                { primary: [M.Lats], secondary: [M.Biceps, M.Traps] },
  "chin up":                { primary: [M.Lats, M.Biceps], secondary: [M.Traps] },
  "lat pulldown":           { primary: [M.Lats], secondary: [M.Biceps] },
  "barbell row":            { primary: [M.Lats], secondary: [M.Traps, M.RearDelts, M.Biceps] },
  "dumbbell row":           { primary: [M.Lats], secondary: [M.Traps, M.RearDelts, M.Biceps] },
  "seated cable row":       { primary: [M.Lats], secondary: [M.Traps, M.Biceps] },
  "t bar row":              { primary: [M.Lats], secondary: [M.Traps, M.Biceps] },
  "face pull":              { primary: [M.RearDelts], secondary: [M.Traps] },

  // ----- Shoulders -----
  "overhead press":         { primary: [M.FrontDelts], secondary: [M.Triceps, M.Traps] },
  "seated dumbbell press":  { primary: [M.FrontDelts], secondary: [M.Triceps] },
  "arnold press":           { primary: [M.FrontDelts], secondary: [M.Triceps] },
  "lateral raise":          { primary: [M.FrontDelts], secondary: [M.Traps] },
  "rear delt fly":          { primary: [M.RearDelts], secondary: [M.Traps] },
  "rear delt raise":        { primary: [M.RearDelts], secondary: [M.Traps] },
  "shrug":                  { primary: [M.Traps], secondary: [] },
  "upright row":            { primary: [M.Traps], secondary: [M.FrontDelts] },

  // ----- Arms -----
  "barbell curl":           { primary: [M.Biceps], secondary: [M.Brachialis] },
  "dumbbell curl":          { primary: [M.Biceps], secondary: [M.Brachialis] },
  "hammer curl":            { primary: [M.Biceps, M.Brachialis], secondary: [] },
  "preacher curl":          { primary: [M.Biceps], secondary: [M.Brachialis] },
  "cable curl":             { primary: [M.Biceps], secondary: [M.Brachialis] },
  "tricep pushdown":        { primary: [M.Triceps], secondary: [] },
  "overhead tricep extension": { primary: [M.Triceps], secondary: [] },
  "skull crusher":          { primary: [M.Triceps], secondary: [] },
  "close grip bench press": { primary: [M.Triceps], secondary: [M.Chest, M.FrontDelts] },
  "rope pushdown":          { primary: [M.Triceps], secondary: [] },

  // ----- Legs -----
  "squat":                  { primary: [M.Quads], secondary: [M.Glutes] },
  "front squat":            { primary: [M.Quads], secondary: [M.Glutes] },
  "leg press":              { primary: [M.Quads], secondary: [M.Glutes, M.Hams] },
  "romanian deadlift":      { primary: [M.Hams], secondary: [M.Glutes] },
  "deadlift":               { primary: [M.Hams, M.Glutes], secondary: [M.Lats, M.Traps] },
  "hip thrust":             { primary: [M.Glutes], secondary: [M.Hams] },
  "leg extension":          { primary: [M.Quads], secondary: [] },
  "leg curl":               { primary: [M.Hams], secondary: [] },
  "calf raise":             { primary: [M.Calves], secondary: [M.Soleus] },
  "seated calf raise":      { primary: [M.Soleus], secondary: [M.Calves] },
  "lunge":                  { primary: [M.Quads, M.Glutes], secondary: [M.Hams] },
  "bulgarian split squat":  { primary: [M.Quads, M.Glutes], secondary: [M.Hams] },

  // ----- Core -----
  "plank":                  { primary: [M.Abs], secondary: [M.Obliques] },
  "crunch":                 { primary: [M.Abs], secondary: [] },
  "hanging leg raise":      { primary: [M.Abs], secondary: [] },
  "russian twist":          { primary: [M.Obliques], secondary: [M.Abs] },
  "ab wheel":               { primary: [M.Abs], secondary: [] },
  "cable crunch":           { primary: [M.Abs], secondary: [] },
};

/**
 * Per-session-type fallback used when no exercises matched the lookup.
 * Keys are values seen in workouts.type (set by Strong's "Workout Name" field).
 */
export const TYPE_FALLBACK: Record<string, MuscleMapping> = {
  Chest:       { primary: [M.Chest],                      secondary: [M.FrontDelts, M.Triceps] },
  Back:        { primary: [M.Lats],                       secondary: [M.Traps, M.RearDelts, M.Biceps] },
  Shoulders:   { primary: [M.FrontDelts, M.RearDelts],    secondary: [M.Traps] },
  Arms:        { primary: [M.Biceps, M.Triceps],          secondary: [M.Brachialis] },
  Legs:        { primary: [M.Quads, M.Glutes, M.Hams],    secondary: [M.Calves, M.Abs] },
  "Full Body": { primary: [M.Chest, M.Lats, M.Quads],     secondary: [M.FrontDelts, M.Glutes, M.Abs] },
};

const BODYWEIGHT_PROXY_KG = 70;
const PRIMARY_THRESHOLD = 0.15;

/** Normalize for lookup: lowercase, strip equipment parens, collapse whitespace. */
export function normalizeExerciseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "") // drop "(Barbell)", "(Dumbbell)", etc.
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AggregatedMuscles = {
  primary: MuscleId[];
  secondary: MuscleId[];
};

/** Working volume of an exercise, summed over non-warmup sets. Bodyweight sets use a 70 kg proxy. */
function workingVolume(ex: WorkoutExercise): number {
  let v = 0;
  for (const s of ex.sets) {
    if (s.warmup) continue;
    const kg = s.kg ?? BODYWEIGHT_PROXY_KG;
    const reps = s.reps ?? 0;
    v += kg * reps;
  }
  return v;
}

/**
 * Roll up per-exercise muscle hits into session-level primary/secondary.
 *
 * Algorithm:
 *   - For each mapped exercise, compute its working volume and its share of total mapped volume.
 *   - Sum each muscle's primary-share contribution across exercises.
 *   - A muscle is session-primary if its primary share >= 15% of total mapped volume.
 *   - A muscle is session-secondary if it appears anywhere (primary or secondary in any exercise)
 *     and isn't already session-primary.
 *   - If no exercises mapped (or all warmup-only), fall back to TYPE_FALLBACK[fallbackType].
 */
export function aggregateSessionMuscles(
  exercises: WorkoutExercise[],
  fallbackType: string | null,
): AggregatedMuscles {
  type Row = { volume: number; mapping: MuscleMapping };
  const rows: Row[] = [];
  let totalVolume = 0;

  for (const ex of exercises) {
    const key = normalizeExerciseName(ex.name);
    const mapping = EXERCISE_MUSCLES[key];
    if (!mapping) continue;
    const v = workingVolume(ex);
    if (v <= 0) continue;
    rows.push({ volume: v, mapping });
    totalVolume += v;
  }

  if (totalVolume === 0) {
    const fb = fallbackType ? TYPE_FALLBACK[fallbackType] : null;
    return fb
      ? { primary: [...fb.primary], secondary: [...fb.secondary] }
      : { primary: [], secondary: [] };
  }

  const primaryScore = new Map<MuscleId, number>();
  const appearsAnywhere = new Set<MuscleId>();

  for (const { volume, mapping } of rows) {
    const share = volume / totalVolume;
    for (const m of mapping.primary) {
      primaryScore.set(m, (primaryScore.get(m) ?? 0) + share);
      appearsAnywhere.add(m);
    }
    for (const m of mapping.secondary) {
      appearsAnywhere.add(m);
    }
  }

  const primary: MuscleId[] = [];
  for (const [m, score] of primaryScore) {
    if (score >= PRIMARY_THRESHOLD) primary.push(m);
  }
  const primarySet = new Set(primary);
  const secondary = [...appearsAnywhere].filter((m) => !primarySet.has(m));

  return { primary, secondary };
}

/**
 * Return the static muscle mapping for an exercise, or null if the exercise
 * name isn't in EXERCISE_MUSCLES. Used by the session card to highlight only
 * one exercise's muscles when the user clicks it.
 */
export function getExerciseMuscles(name: string): MuscleMapping | null {
  return EXERCISE_MUSCLES[normalizeExerciseName(name)] ?? null;
}
