import { getExerciseMuscles, MUSCLE_ID } from "@/lib/coach/exercise-muscles";
import { STRAIN_CALIBRATION } from "./constants";

/** One logged set, reduced to what the mechanical term reads. */
export type MechanicalSet = {
  kg: number | null;
  reps: number | null;
  warmup: boolean;
  rir: number | null;
};

/** One logged exercise plus the athlete's current e1RM for it, when known. */
export type MechanicalExercise = {
  name: string;
  sets: MechanicalSet[];
  e1rm: number | null;
};

/** Muscles whose involvement makes a set systemically expensive. Mirrors the
 *  large/small split used for rest prescription in lib/coach/session-structure. */
const LARGE_MUSCLE_IDS: ReadonlySet<number> = new Set([
  MUSCLE_ID.Chest,
  MUSCLE_ID.Lats,
  MUSCLE_ID.Quads,
  MUSCLE_ID.Hams,
  MUSCLE_ID.Glutes,
  MUSCLE_ID.Traps,
]);

/** Every factor — and, critically, their PRODUCT — lives inside this band. They
 *  exist to REDISTRIBUTE load between exercises and sets, not to rescale the
 *  day: the fitted `w` was derived from raw tonnage, so anything that moved the
 *  aggregate would silently invalidate it.
 *
 *  Clamping each factor separately is not enough. Three independently-clamped
 *  factors multiply out to [0.85³, 1.15³] = [0.61, 1.52] — a ±52% swing, not the
 *  ±15% this band is supposed to express. A heavy deadlift set taken past its
 *  RIR target hits 1.15 × 1.06 × 1.15 = 1.40 on its own. So `combinedFactor`
 *  below clamps the product, and that is the bound the tests assert. */
const FACTOR_MIN = 0.85;
const FACTOR_MAX = 1.15;

const clampFactor = (v: number) => Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, v));

/** Σ kg × reps over non-warmup sets. This is the quantity the calibration fit
 *  was performed on and the scale everything below preserves. */
export function rawTonnage(exercises: MechanicalExercise[]): number {
  let total = 0;
  for (const e of exercises) {
    for (const s of e.sets) {
      if (s.warmup) continue;
      total += (s.kg ?? 0) * (s.reps ?? 0);
    }
  }
  return total;
}

/** A deadlift set costs more than a curl set of identical tonnage. Unmapped
 *  names resolve to neutral rather than to either extreme. */
export function muscleFactor(name: string): number {
  const mapping = getExerciseMuscles(name);
  if (!mapping) return 1;
  return mapping.primary.some((id) => LARGE_MUSCLE_IDS.has(id)) ? FACTOR_MAX : FACTOR_MIN;
}

/** Load as a fraction of the exercise's current e1RM, ramped across 50–90%.
 *  Neutral when no e1RM history exists — most accessories, and every exercise
 *  on an athlete's first session. */
export function intensityFactor(kg: number, e1rm: number | null): number {
  if (!e1rm || e1rm <= 0) return 1;
  const ratio = kg / e1rm;
  const ramp = (ratio - 0.5) / 0.4; // 0 at 50%, 1 at 90%
  return clampFactor(FACTOR_MIN + (FACTOR_MAX - FACTOR_MIN) * Math.min(1, Math.max(0, ramp)));
}

/** Proximity to failure relative to what the block prescribed.
 *
 *  Bounded and centred rather than fitted, deliberately: per-set RIR arrived in
 *  migration 0045 (July 2026) and the April–May calibration sessions carry none,
 *  so there is no labelled data to fit a coefficient against. A session at
 *  target scores exactly as it would have without RIR, which is what keeps the
 *  calibration honest. */
export function rirFactor(rir: number | null, rirTarget: number | null): number {
  if (rir === null || rirTarget === null) return 1;
  return clampFactor(1 + ((FACTOR_MAX - 1) * (rirTarget - rir)) / 2);
}

/** The single multiplier applied to one set's tonnage. Clamped as a PRODUCT,
 *  not per factor — see the FACTOR_MIN/FACTOR_MAX note above for why. */
export function combinedFactor(
  name: string,
  kg: number,
  e1rm: number | null,
  rir: number | null,
  rirTarget: number | null,
): number {
  return clampFactor(muscleFactor(name) * intensityFactor(kg, e1rm) * rirFactor(rir, rirTarget));
}

/** Tonnage-equivalent kilograms for a session: raw tonnage redistributed by
 *  muscle mass, relative intensity and proximity to failure, then rescaled by
 *  the frozen `mechanicalNorm` so the aggregate lands back on the raw-tonnage
 *  scale the model was fitted against. */
export function mechanicalLoad(
  exercises: MechanicalExercise[],
  rirTarget: number | null,
): number {
  let total = 0;
  for (const e of exercises) {
    for (const s of e.sets) {
      if (s.warmup) continue;
      const tonnage = (s.kg ?? 0) * (s.reps ?? 0);
      if (tonnage === 0) continue;
      total += tonnage * combinedFactor(e.name, s.kg ?? 0, e.e1rm, s.rir, rirTarget);
    }
  }
  return total * STRAIN_CALIBRATION.mechanicalNorm;
}
