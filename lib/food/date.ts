// lib/food/date.ts
//
// Date helpers shared by the food-log API routes.
//
// Day-bucketing uses UTC (see lib/food/aggregate.ts header comment for the
// known limitation around late-evening local-time edits crossing the UTC
// midnight boundary).

/** Extract YYYY-MM-DD from an ISO timestamp (UTC bucket). */
export function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

/** True if the ISO timestamp's UTC date equals today's UTC date. */
export function isToday(iso: string): boolean {
  return utcDate(iso) === utcDate(new Date().toISOString());
}
