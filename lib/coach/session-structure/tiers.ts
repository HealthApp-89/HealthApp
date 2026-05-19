// lib/coach/session-structure/tiers.ts
//
// Fatigue-tier classification. Orthogonal to EXERCISE_CATEGORY (push/pull/
// squat/hinge/single-leg/core/accessory) — that one answers "what movement
// pattern", this one answers "how taxing / where should this sit in the
// session?". Lookup is by NORMALIZED exercise name (see normalize() from
// exercise-categories.ts). Unknown names fall back to a category-based
// heuristic.
//
// Tiers:
//   0 — warmup / mobility ramp-up
//   1 — heavy compound, CNS-taxing (BIG_FOUR, plus weighted dip/pull-up)
//   2 — secondary compound (DB bench, leg press, RDL, row, pulldown, pullover)
//   3 — isolation (curls, pushdowns, lateral raise, fly, leg ext/curl, calf,
//       shrug, abductor)
//   4 — bodyweight to-failure / finisher (push-up [non-warmup], BW dip,
//       back extension, abs)

import { normalize, categorize } from "@/lib/coach/exercise-categories";
import { BIG_FOUR_SET } from "@/lib/coach/big-four";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type FatigueTier = 0 | 1 | 2 | 3 | 4;

/** Explicit fatigue tier overrides keyed on normalize(name).
 *  Catches everything in SESSION_PLANS plus common variants the user could
 *  log via Strong. Anything not in this map falls back to TIER_BY_CATEGORY. */
const FATIGUE_TIER: Record<string, FatigueTier> = {
  // ── TIER 1 — heavy compound ─────────────────────────────────────────────
  "squat": 1,
  "back squat": 1,
  "barbell squat": 1,
  "front squat": 1,
  "deadlift": 1,
  "conventional deadlift": 1,
  "sumo deadlift": 1,
  "bench press": 1,
  "decline bench press": 1,
  "incline bench press": 2,
  "overhead press": 1,
  "weighted pull-up": 1,
  "weighted chin-up": 1,
  "weighted dip": 1,

  // ── TIER 2 — secondary compound ─────────────────────────────────────────
  "dumbbell bench press": 2,
  "incline dumbbell press": 2,
  "dumbbell shoulder press": 2,
  "arnold press": 2,
  "machine shoulder press": 2,
  "shoulder press": 2,
  "close-grip bench press": 2,
  "romanian deadlift": 2,
  "stiff-leg deadlift": 2,
  "barbell row": 2,
  "bent over row": 2,
  "pendlay row": 2,
  "dumbbell row": 2,
  "seated cable row": 2,
  "seated row": 2,
  "t-bar row": 2,
  "machine row": 2,
  "lat pulldown": 2,
  "neutral grip pulldown": 2,
  "pullover": 2,
  "leg press": 2,
  "seated leg press": 2,
  "hack squat": 2,
  "machine squat": 2,
  "hip thrust": 2,
  "barbell hip thrust": 2,
  "good morning": 2,

  // ── TIER 3 — isolation ──────────────────────────────────────────────────
  "chest fly": 3,
  "cable fly": 3,
  "pec deck": 3,
  "lateral raise": 3,
  "front raise": 3,
  "cable lateral raise": 3,
  "rear delt fly": 3,
  "reverse fly": 3,
  "face pull": 3,
  "tricep extension": 3,
  "triceps extension": 3,
  "tricep pushdown": 3,
  "triceps pushdown": 3,
  "skull crusher": 3,
  "bicep curl": 3,
  "barbell curl": 3,
  "dumbbell curl": 3,
  "hammer curl": 3,
  "preacher curl": 3,
  "cable curl": 3,
  "leg extension": 3,
  "leg curl": 3,
  "lying leg curl": 3,
  "seated leg curl": 3,
  "calf raise": 3,
  "standing calf raise": 3,
  "seated calf raise": 3,
  "donkey calf raise": 3,
  "shrug": 3,
  "hip abductor": 3,
  "wrist curl": 3,
  "reverse wrist curl": 3,

  // ── TIER 4 — bodyweight to-failure / finisher ───────────────────────────
  "push-up": 4,
  "push up": 4,
  "dip": 4,
  "bench dip": 4,
  "chest dip": 4,
  "pull-up": 4,
  "chin-up": 4,
  "back extension": 4,
  "hyperextension": 4,
  "plank": 4,
  "side plank": 4,
  "ab wheel rollout": 4,
  "hanging leg raise": 4,
  "cable crunch": 4,
  "russian twist": 4,
  "dead bug": 4,
  "pallof press": 4,
  "hollow body hold": 4,
  "sit-up": 4,
  "v-up": 4,
  "glute bridge": 4,
};

/** Fallback tier when an exercise isn't in FATIGUE_TIER. Hinge/squat/push/pull
 *  are assumed compound (tier 2) — anything genuinely heavy or genuinely
 *  isolated should be in the explicit map. */
const TIER_BY_CATEGORY: Record<string, FatigueTier> = {
  push: 2,
  pull: 2,
  squat: 2,
  hinge: 2,
  "single-leg": 2,
  core: 3,
  accessory: 3,
  uncategorized: 3,
};

/** Classify an exercise into one of five fatigue tiers.
 *
 *  @param name      Exercise display name ("Push Up", "Decline Bench Press (Barbell)", ...)
 *  @param isWarmup  When true (PlannedExercise.warmup === true), always returns 0
 *                   regardless of the name. Allows the static plan to override
 *                   the heuristic for push-ups-as-warmup-ramp.
 */
export function getFatigueTier(name: string, isWarmup: boolean): FatigueTier {
  if (isWarmup) return 0;
  const key = normalize(name);
  const explicit = FATIGUE_TIER[key];
  if (explicit !== undefined) return explicit;
  return TIER_BY_CATEGORY[categorize(name)] ?? 3;
}

/** Convenience: tier on a PlannedExercise, honoring the warmup flag. */
export function tierOf(ex: PlannedExercise): FatigueTier {
  return getFatigueTier(ex.name, ex.warmup === true);
}

/** Re-export for downstream modules so they don't reach back into big-four.ts. */
export { BIG_FOUR_SET };
