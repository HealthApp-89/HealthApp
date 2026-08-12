/** One heart-rate reading. ts is epoch milliseconds. */
export type HrSample = { ts: number; bpm: number };

/** Where an activity's heart rate was measured. Resolved from a hand-maintained
 *  device map, never inferred from the HR signal itself. */
export type HrSource = "wrist" | "arm" | "chest" | "unknown";

/** A half-open wall-clock window [startMs, endMs). */
export type TimeWindow = { startMs: number; endMs: number };

/** The three load terms for one day, before the curve. `mechanical` is in
 *  tonnage-equivalent kilograms; the other two are TRIMP units. */
export type DayLoad = {
  baseline: number;
  activity: number;
  mechanical: number;
};
