// lib/coach/prescription/block-week.ts
//
// Single source of truth for turning a training-block start date plus an
// as-of date into a 1-indexed block-week number. Extracted 2026-08-11 out
// of block-phase-rule.ts's currentBlockWeek so target-hit-evaluator.ts
// could compute the same number for the qualifying-session date instead of
// "now" without becoming a second copy of the same date arithmetic — this
// repo's postmortems name that exact failure mode ("four fixes, one
// disease: a second copy of an engine rule that drifted").

/** 1-indexed block-week number for `dateIso` relative to `startDate`,
 *  clamped to a minimum of 1 (a date on or before start_date reads as
 *  week 1). Both dates are plain YYYY-MM-DD strings, anchored at UTC
 *  midnight so the arithmetic is calendar-day-based, not wall-clock. */
export function blockWeekOf(startDate: string, dateIso: string): number {
  const start = new Date(startDate + "T00:00:00Z");
  const date = new Date(dateIso + "T00:00:00Z");
  const days = Math.floor((date.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.floor(days / 7) + 1);
}
