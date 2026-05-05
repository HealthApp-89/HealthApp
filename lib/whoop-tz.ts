// lib/whoop-tz.ts
//
// Helper for travel-mode L1: build a function that maps a UTC moment to the
// timezone_offset of the WHOOP cycle that contains it. WHOOP returns a per-
// record timezone_offset on cycles and workouts (but NOT on sleep/recovery
// records); sleep and recovery inherit their tz from the containing cycle.
//
// Sleep/recovery whose moment doesn't fall inside any cycle in the input set
// (e.g., the cycle is outside the sync window) returns null so callers can
// fall back to USER_TIMEZONE.

import type { WhoopCycle } from "@/lib/whoop";

/** Build a function that, given a UTC moment, returns the timezone_offset
 *  of the cycle that contains it (e.g. "+04:00", "-05:00"), or null if no
 *  cycle in the input set covers it. */
export function buildCycleTzLookup(
  cycles: WhoopCycle[],
): (when: Date) => string | null {
  // Sort by start descending so the most recent open cycle wins for in-progress
  // sleeps without leaking onto historical sleeps. Critical during a 2-year
  // backfill where stale open cycles (data gaps, dropped end records) could
  // otherwise match arbitrary historical moments via an unbounded "now+24h"
  // fallback.
  const sorted = [...cycles].sort((a, b) => b.start.localeCompare(a.start));
  return (when: Date) => {
    const t = when.toISOString();
    for (const c of sorted) {
      // Open cycles (no `end`) get a 36-hour cap from their start — physical
      // upper bound for one wake-to-wake interval. Beyond that, fall through.
      const cycleEnd =
        c.end ??
        new Date(new Date(c.start).getTime() + 36 * 3_600_000).toISOString();
      if (c.start <= t && t <= cycleEnd) return c.timezone_offset;
    }
    return null;
  };
}
