/** Format a rest prescription for display. Whole minutes render as minutes;
 *  anything else stays in seconds.
 *
 *  Replaces the two duplicate `fmtRestRange` copies that lived in
 *  BriefSessionList and TodayPlanCard back when rest was a {min, max} range. */
export function fmtRest(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  return `${seconds}s`;
}
