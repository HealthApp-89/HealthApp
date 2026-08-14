import { STRAIN_CALIBRATION } from "./constants";
import type { DayLoad } from "./types";

/** Sum the three load terms and map them onto the 0–21 scale.
 *
 *  One saturating curve over the summed load — not three curves summed — so
 *  that a day built from many small contributions and a day built from one
 *  large one score alike.
 *
 *  The three terms enter at DIFFERENT weights, which is the part worth
 *  knowing. `activity` sets the scale (coefficient k); `mechanical` is
 *  converted into TRIMP-equivalents by `w`; and `baseline` — ordinary living,
 *  which is most of the wall clock on every day including hard ones — is
 *  discounted by `baselineWeight` to roughly a sixth. A TRIMP earned pacing
 *  around a supermarket is not a TRIMP earned at 170 bpm on a padel court, and
 *  weighting them equally is what made hard cardio days score low. See
 *  constants.ts for the evidence behind the number. */
export function composeStrain(load: DayLoad): number {
  const { A, k, w, baselineWeight } = STRAIN_CALIBRATION;
  const total =
    baselineWeight * Math.max(0, load.baseline) +
    Math.max(0, load.activity) +
    w * Math.max(0, load.mechanical);
  if (total <= 0) return 0;
  return Math.min(21, A * Math.log(1 + k * total));
}
