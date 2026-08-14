import type { HrSource } from "./types";

/** Fitted strain constants.
 *
 *  Refitted 2026-08-14 by scripts/fit-strain-constants.mjs against
 *  scripts/fixtures/strain-calibration-2026.json — 61 labelled April–May 2026
 *  days carrying WHOOP's own strength-adjusted values, the only labelled data
 *  that will ever exist for this athlete. RMSE 1.280 (previously shipped: 1.508).
 *
 *  Form: strain = min(21, A·ln(1 + k·(baselineWeight·baseline + activity + w·mechanical))).
 *
 *  `baselineWeight` is what the 2026-08-14 refit added, and it is the whole
 *  point of that refit. The previous form summed the baseline and activity
 *  terms at parity, which forced one coefficient to serve both ~23 hours of
 *  ambient living and one deliberate hour of sport. Because 31 of the 61
 *  labelled days are quiet ones, least squares resolved that conflict in
 *  favour of the quiet days and the hard-cardio end was sacrificed: residuals
 *  on HR-only days ran +0.71 below WHOOP 6 and −2.68 above WHOOP 9. That slope
 *  survived a full re-search of (A, k, w) — best achievable RMSE under the old
 *  form was 1.477, barely better than the 1.508 shipped, and the slope did not
 *  move. So it was the FORM, not the tuning. Giving ambient living its own
 *  (much smaller) coefficient flattens the slope to +0.31 / −1.56 and fixes
 *  the fixture's worst residual outright: 2026-04-15, a hard road ride WHOOP
 *  called 14.32, went from 10.36 to 14.10.
 *
 *  Symptom that started it: a 66-minute padel session scored 7.6.
 *
 *  Chosen by leave-one-out cross-validation, not in-sample RMSE. Only 5 of the
 *  61 days are HR-only days above WHOOP 6, so in-sample error barely notices
 *  them and happily buys a richer form that generalises worse. Adding a
 *  superlinear HR exponent on top of this one scores BETTER in-sample (1.236)
 *  and WORSE under LOO (1.429 vs 1.382) — and pins to the 21 ceiling at merely
 *  twice the hardest labelled day, which is reckless for a model whose labels
 *  can never be extended. Compare forms with a true per-fold refit, not a
 *  shared grid: a coarser grid regularises, so grid-based LOO flatters
 *  whichever form got the coarser search.
 *
 *  The known cost: an unlogged session — real work the watch recorded only in
 *  the all-day stream, because no activity was ever started — now scores lower
 *  than it used to, since it lands entirely in the downweighted term. The
 *  fixture's 2026-05-13 is exactly that day and is the new worst residual
 *  (−4.56). Accepted deliberately: one mislabelled day is a better price than
 *  a slope across every cardio day.
 *
 *  Terms are scored against `resting_hr_baseline` (a 90-day rolling median)
 *  rather than each day's own resting HR — per-day RHR made the whole scale
 *  drift upward as the athlete's fitness improved. The fixture rows carry both
 *  fields; the fit and calibration audit read `resting_hr_baseline ?? resting_hr`.
 *
 *  `w` converts tonnage-equivalent kilograms into TRIMP units.
 *  `mechanicalNorm` rescales the muscle/intensity/RIR-weighted sum back onto
 *  the raw-tonnage scale the fit was performed on, so those factors
 *  redistribute load between exercises without moving the aggregate. It is a
 *  property of the fixture's tonnage, not of the curve, so the refit left it
 *  untouched.
 *
 *  Do not hand-tune. scripts/audit-strain-calibration.mjs asserts these
 *  reproduce the fixture within RMSE 1.45 AND that the per-band residuals stay
 *  flat, so a future change cannot trade the cardio arm away again unnoticed. */
export const STRAIN_CALIBRATION = {
  A: 6.0868,
  k: 0.0506139,
  baselineWeight: 0.182116,
  w: 0.011847,
  mechanicalNorm: 0.936033,
} as const;

/** Longest interval a single pair of HR samples may contribute, in minutes.
 *  Guards against off-wrist gaps being scored at the last-seen heart rate. */
export const MAX_INTERVAL_MIN = 10;

/** Hand-maintained device → sensor map. Garmin does not report sensor type on
 *  the activity record, so this is edited when hardware changes rather than
 *  inferred from HR characteristics — an inferred value would be a guess
 *  presented as a measurement.
 *
 *  3491966227 — Fenix 8. Currently wrist optical; becomes 'chest' when the
 *  HRM strap is paired for cardio. A CIRQA arm band gets its own entry ('arm')
 *  when its deviceId is first seen in ingest. */
export const DEVICE_HR_SOURCE: Record<string, HrSource> = {
  "3491966227": "wrist",
};

/** Preference order for cross-device dedup: a better sensor wins. */
export const HR_SOURCE_RANK: Record<HrSource, number> = {
  chest: 0,
  arm: 1,
  wrist: 2,
  unknown: 3,
};
