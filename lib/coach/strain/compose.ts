import { STRAIN_CALIBRATION } from "./constants";
import type { DayLoad } from "./types";

/** Sum the three load terms and map them onto the 0–21 scale.
 *
 *  One saturating curve over the summed load — not three curves summed — so
 *  that a day built from many small contributions and a day built from one
 *  large one score alike. */
export function composeStrain(load: DayLoad): number {
  const { A, k, w } = STRAIN_CALIBRATION;
  const total =
    Math.max(0, load.baseline) +
    Math.max(0, load.activity) +
    w * Math.max(0, load.mechanical);
  if (total <= 0) return 0;
  return Math.min(21, A * Math.log(1 + k * total));
}
