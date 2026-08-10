// lib/logger/seed-rir.ts
//
// What RIR is pre-filled into a pending working set in the logger draft.
//
// Extracted from LoggerSheet so it is unit-testable (no render harness in this
// repo) and so the three seeding sites — fresh draft, session reset, and the
// exercise card's "+ Add set" — cannot drift apart again.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";

/**
 * `prescribed.rir` first, week target second, 2 last.
 *
 * The ordering is load-bearing, not cosmetic. A seeded RIR is indistinguishable
 * from a recorded one downstream: the between-sets load call reads `set.rir` as
 * an athlete observation and bands it against `prescribed.rir ?? rirTarget`.
 * Seeding the WEEK-wide target meant that whenever the engine had raised this
 * exercise's RIR — `lightenExercise` in prescribe-week.ts writes `baseRir + 1`
 * or `+ 2`, and patch-today.ts writes `(ex.rir ?? 2) + 1` on a low-readiness
 * morning — a set that went exactly to the lightened plan came through as
 * "strained": a guardrail on a perfect set, or a load-DOWN call on a day that
 * was already deliberately lightened.
 *
 * It also makes the RIR input box agree with the Target column, which has
 * always rendered `prescribed.rir`.
 *
 * Warmups and duration-based work carry no RIR at all; that exclusion stays at
 * the call sites, which know which set index is the warmup.
 */
export function seedRir(
  prescribed: Pick<PlannedExercise, "rir">,
  weekRirTarget: number | null | undefined,
): number {
  return prescribed.rir ?? weekRirTarget ?? 2;
}
