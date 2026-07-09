// lib/time/dates.ts
//
// Pure ISO-date (YYYY-MM-DD) arithmetic on PASSED-IN dates. Nothing here may
// read the wall clock — "today" always arrives as an argument, per the
// timezone single-source rule (see scripts/audit-timezone-usage.mjs).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Monday (ISO date) of the week containing `iso`. Pure date arithmetic on a
 *  caller-supplied date — the caller owns the timezone question. */
export function mondayOfIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** ISO date `days` before `today` (a YYYY-MM-DD string). UTC-safe. */
export function isoDaysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (negative when toIso is earlier).
 *  Returns null when either input fails to parse. */
export function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / MS_PER_DAY);
}
