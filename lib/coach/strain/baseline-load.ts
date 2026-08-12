import { banisterOverIntervals } from "./trimp";
import type { HrSample, TimeWindow } from "./types";

/** Load from ordinary living: the all-day HR stream with every scored
 *  activity's window cut out.
 *
 *  The exclusion is what makes the three terms additive without double-counting
 *  — the all-day stream and an activity stream cover the same wall-clock during
 *  a session, and summing both unmodified would count that hour twice.
 *
 *  Windows are only passed here for activities whose own HR is being scored in
 *  the activity term. An activity that arrived without a stream is deliberately
 *  left in the baseline, where its coarse 2-minute samples are better than
 *  nothing. */
export function baselineTrimp(
  allDay: HrSample[],
  excluded: TimeWindow[],
  hrRest: number,
  hrMax: number,
): number {
  return banisterOverIntervals(allDay, hrRest, hrMax, excluded);
}
