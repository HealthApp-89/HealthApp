// lib/coach/session-structure/rules.ts
//
// Pure rule functions for session structure. Each function takes the inputs
// it needs and returns a typed record — no I/O, no side effects.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { getExerciseMuscles, MUSCLE_ID } from "@/lib/coach/exercise-muscles";
import { categorize } from "@/lib/coach/exercise-categories";
import { tierOf, BIG_FOUR_SET, type FatigueTier } from "./tiers";

export type OrderingWarning = {
  rule:
    | "tier_ascending"
    | "bodyweight_finisher_on_fatigued_muscle"
    | "big_four_first";
  exercise: string;
  related_exercise?: string;
  message: string;
  suggested_action:
    | "move_to_warmup"
    | "swap_with"
    | "substitute"
    | "move_to_end";
};

/** Parse a reps spec ("8", "8-12", "12×3", "5×2") to a single numeric reps
 *  count. Returns null when the spec encodes time or duration ("Hold 60s×2").
 *
 *  Previously fed the rest table, which branched on rep count; rest no longer
 *  does. The live remaining consumer is repsForExercise -> rule-load-call. */
function parseReps(spec: string | number | undefined): number | null {
  if (spec === undefined) return null;
  if (typeof spec === "number") return spec;
  const m = spec.match(/^(\d+)/);
  if (!m) return null;
  const reps = parseInt(m[1], 10);
  return Number.isFinite(reps) ? reps : null;
}

/** Single-value rest prescription per bucket, in seconds.
 *
 *  Rest length matters because it protects volume-load: anything that costs
 *  reps on sets 2-4 costs the stimulus set 1 bought (Schoenfeld 2016; Grgic
 *  2017/2018 meta-analyses). These are the values the athlete is expected to
 *  actually take, not the floor of a range. */
export const REST_SECONDS = {
  warmup: 45,
  /** The ramp set immediately before the first working exercise. 45s here
   *  compromises the heaviest set of the day. */
  lastWarmup: 120,
  heavyCompound: 240,
  secondaryCompound: 180,
  isolationLarge: 120,
  isolationSmall: 60,
  finisher: 45,
  /** Between rounds of a superset, whatever its members are. The technique's
   *  point is density: the partner exercise IS the rest for the first, so the
   *  pair is rested as a unit rather than at the heavier member's tier value. */
  supersetRound: 60,
  /** After a superset's LAST round — changing weights and walking to the next
   *  station costs more than the round-to-round turnaround. */
  supersetSetup: 120,
} as const;

/** Added to the incoming exercise's rest to produce the between-exercise
 *  transition: station change, plate loading, set-up. */
export const TRANSITION_BUFFER_SECONDS = 60;

/** Primary muscles expensive enough that an isolation taken near failure
 *  needs compound-like recovery. */
const LARGE_MUSCLE_IDS: ReadonlySet<number> = new Set([
  MUSCLE_ID.Chest,
  MUSCLE_ID.Lats,
  MUSCLE_ID.Quads,
  MUSCLE_ID.Hams,
  MUSCLE_ID.Glutes,
  MUSCLE_ID.Traps,
]);

/** Large- vs small-muscle isolation. A leg extension to failure imposes local
 *  and systemic fatigue on a par with a light compound; a lateral raise
 *  recovers in about a minute.
 *
 *  Any large muscle in the primary set makes the exercise expensive, so mixed
 *  primaries resolve to "large". An unmapped name resolves to "small"
 *  deliberately: that yields the shortest timer, and the athlete can lengthen
 *  it from the logger's rest dialog in one tap. A wrong-but-long default costs
 *  four minutes of standing around before anyone notices. */
export function isolationSize(name: string): "large" | "small" {
  const mapping = getExerciseMuscles(name);
  if (!mapping || mapping.primary.length === 0) return "small";
  return mapping.primary.some((id) => LARGE_MUSCLE_IDS.has(id)) ? "large" : "small";
}

/** Rest in seconds for one exercise, given its fatigue tier.
 *
 *  Reps are deliberately not an input. The old range-based table branched on
 *  rep count; these values are set by how expensive the movement is, and a
 *  5-rep and a 10-rep squat both need a full recovery before the next set.
 *
 *  Tier 0 returns the plain warm-up value. The last-warm-up bump to
 *  REST_SECONDS.lastWarmup depends on the NEXT exercise and so belongs to
 *  annotateSession, not here — keeping this a pure (ex, tier) lookup is what
 *  makes it directly testable. */
export function restSecondsFor(ex: PlannedExercise, tier: FatigueTier): number {
  // An athlete-set value on the plan beats the tier table everywhere the plan
  // is read, so the brief, the strength card and the logger cannot disagree.
  if (ex.rest_seconds_override != null) return ex.rest_seconds_override;
  switch (tier) {
    case 0: return REST_SECONDS.warmup;
    case 1: return REST_SECONDS.heavyCompound;
    case 2: return REST_SECONDS.secondaryCompound;
    case 3:
      return isolationSize(ex.name) === "large"
        ? REST_SECONDS.isolationLarge
        : REST_SECONDS.isolationSmall;
    case 4: return REST_SECONDS.finisher;
  }
}

/** RPE/RIR target string per fatigue tier. */
export function rpePrescription(tier: FatigueTier): string {
  switch (tier) {
    case 0: return "warm-up — ramp only, RPE 5–6";
    case 1: return "RPE 7–8 across sets, top set 8–9";
    case 2: return "RPE 7–9 (1–3 RIR)";
    case 3: return "RPE 8–10, last set near failure";
    case 4: return "AMRAP / RPE 10";
  }
}

/** Returns reps as a numeric where possible from a PlannedExercise. Reads
 *  baseReps first (typed numeric), then parses `reps` (string like "12×3"). */
export function repsForExercise(ex: PlannedExercise): number | null {
  if (typeof ex.baseReps === "number") return ex.baseReps;
  return parseReps(ex.reps);
}

/** Check `note` for the pre-exhaust opt-out tag.
 *  Returns true when the exercise's note contains "pre-exhaust" (case-insensitive),
 *  which suppresses tier_ascending warnings for the immediately-following
 *  same-pattern exercise. */
function isPreExhaustTagged(ex: PlannedExercise): boolean {
  if (!ex.note) return false;
  return /pre[-\s]?exhaust/i.test(ex.note);
}

/** Detect ordering rule violations across a session.
 *
 *  Three rules:
 *  1. **tier_ascending** — within the session, post-warmup tiers must be
 *     non-decreasing. A higher-tier exercise (e.g. tier 1 OHP) appearing
 *     after a lower-tier one (e.g. tier 3 Chest Fly) is a violation.
 *  2. **bodyweight_finisher_on_fatigued_muscle** — a tier-4 movement whose
 *     primary muscle (via EXERCISE_MUSCLES) overlaps with any earlier
 *     tier-2/3 exercise's primary muscle is a violation.
 *  3. **big_four_first** — a BIG_FOUR member must appear before any
 *     non-BIG_FOUR exercise sharing its EXERCISE_CATEGORY bucket. */
export function findOrderingWarnings(exercises: PlannedExercise[]): OrderingWarning[] {
  const warnings: OrderingWarning[] = [];
  const tiers = exercises.map(tierOf);
  const cats = exercises.map((e) => categorize(e.name));
  const primaries = exercises.map((e) => {
    const m = getExerciseMuscles(e.name);
    return m?.primary ?? [];
  });

  // Rule 1: tier ascending. Track the highest non-warmup tier seen so far and
  // the exercise that established it. A later exercise with a lower tier is a
  // violation — and `related_exercise` points to that earlier high-tier
  // exercise (not just the immediately-prior one), so the displayed message
  // matches the user's intuition on non-adjacent violations.
  let highTierSeen: FatigueTier = 0;
  let highTierExercise = "";
  for (let i = 0; i < exercises.length; i++) {
    if (tiers[i] === 0) continue; // warm-up doesn't establish a floor
    if (tiers[i] < highTierSeen) {
      warnings.push({
        rule: "tier_ascending",
        exercise: exercises[i].name,
        related_exercise: highTierExercise,
        message: `${exercises[i].name} (tier ${tiers[i]}) is sequenced after ${highTierExercise} (tier ${highTierSeen}). Heavier compounds should come first when the body is fresh.`,
        suggested_action: "swap_with",
      });
      continue;
    }
    // Pre-exhaust tag still raises the floor for subsequent comparisons —
    // but allows the next exercise to drop without firing. We model that
    // by NOT updating highTierSeen when the current exercise is pre-exhaust-tagged.
    if (isPreExhaustTagged(exercises[i])) continue;
    if (tiers[i] > highTierSeen) {
      highTierSeen = tiers[i];
      highTierExercise = exercises[i].name;
    }
  }

  // Rule 2: tier-4 finisher with primary muscle overlap on an earlier tier 2/3.
  for (let i = 0; i < exercises.length; i++) {
    if (tiers[i] !== 4) continue;
    const myPrimary = primaries[i];
    if (myPrimary.length === 0) continue;
    for (let j = 0; j < i; j++) {
      if (tiers[j] !== 2 && tiers[j] !== 3) continue;
      const earlierPrimary = primaries[j];
      const overlaps = myPrimary.some((p) => earlierPrimary.includes(p));
      if (overlaps) {
        warnings.push({
          rule: "bodyweight_finisher_on_fatigued_muscle",
          exercise: exercises[i].name,
          related_exercise: exercises[j].name,
          message: `${exercises[i].name} loads a muscle already fatigued by ${exercises[j].name}. Move to warm-up or substitute a non-overlapping movement.`,
          suggested_action: "move_to_warmup",
        });
        break; // one warning per finisher is enough
      }
    }
  }

  // Rule 3: BIG_FOUR member must precede non-BIG_FOUR same-category exercises.
  for (let i = 0; i < exercises.length; i++) {
    if (!BIG_FOUR_SET.has(exercises[i].name)) continue;
    const myCat = cats[i];
    for (let j = 0; j < i; j++) {
      if (tiers[j] === 0) continue; // warmup ramp doesn't trigger
      if (cats[j] !== myCat) continue;
      if (BIG_FOUR_SET.has(exercises[j].name)) continue;
      warnings.push({
        rule: "big_four_first",
        exercise: exercises[i].name,
        related_exercise: exercises[j].name,
        message: `${exercises[i].name} (BIG_FOUR ${myCat}) belongs before ${exercises[j].name} — heavier and more CNS-taxing.`,
        suggested_action: "swap_with",
      });
      break;
    }
  }

  return warnings;
}
