//
// Pure defaults engine for the one-tap morning check-in (spec 2026-07-10).
// "Same as usual" writes the athlete's personal baseline, computed from the
// last 28 days of EXPLICITLY answered checkins. One-tap ('all_good') rows are
// excluded so defaults never feed the median that feeds the defaults.

import type { FatigueLevel } from "@/lib/data/types";

export type MorningDefaults = { readiness: number; fatigue: FatigueLevel };

export type DefaultsInputRow = {
  readiness: number | null;
  fatigue: FatigueLevel | null;
  intake_source: string | null;
};

export const DEFAULTS_FALLBACK: MorningDefaults = { readiness: 7, fatigue: "some" };

const MIN_EXPLICIT_ROWS = 7;

/** Tie-break order for the fatigue mode. 'some' first: it is the observed
 *  baseline for this athlete class and the middle of the scale — a 'none'
 *  default would systematically overstate freshness on one-tap days. */
const FATIGUE_TIE_ORDER: FatigueLevel[] = ["some", "none", "heavy"];

export function computeMorningDefaults(rows: DefaultsInputRow[]): MorningDefaults {
  const explicit = rows.filter(
    (r) => r.intake_source !== "all_good" && r.readiness != null,
  );
  if (explicit.length < MIN_EXPLICIT_ROWS) return DEFAULTS_FALLBACK;

  const sorted = explicit.map((r) => r.readiness as number).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const readiness =
    sorted.length % 2 === 1
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

  const counts = new Map<FatigueLevel, number>();
  for (const r of explicit) {
    if (r.fatigue) counts.set(r.fatigue, (counts.get(r.fatigue) ?? 0) + 1);
  }
  let fatigue: FatigueLevel = DEFAULTS_FALLBACK.fatigue;
  let best = -1;
  for (const level of FATIGUE_TIE_ORDER) {
    const c = counts.get(level) ?? 0;
    if (c > best) {
      best = c;
      fatigue = level;
    }
  }

  return { readiness, fatigue };
}
