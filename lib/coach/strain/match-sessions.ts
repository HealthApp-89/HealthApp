import { HR_SOURCE_RANK } from "./constants";
import { activityWindow, resolveHrSource, toHrSamples, type ActivityInput } from "./activity-load";

/** How far apart an activity's start and a logged workout's start may be and
 *  still describe the same session.
 *
 *  The athlete starts the watch activity by hand, then opens the logger — or
 *  the reverse — so the two timestamps differ by seconds to minutes. Matching
 *  on equality would fail every single day; 30 minutes absorbs the ordering gap
 *  and a late stop in the locker room without reaching a different session. */
export const MATCH_TOLERANCE_MS = 30 * 60_000;

/** A logged workout's wall-clock span. */
export type WorkoutWindow = {
  workout_id: string;
  startMs: number;
  endMs: number;
};

/** The workout this activity records, or null if it stands alone.
 *
 *  Requires BOTH an interval overlap and starts within tolerance. Overlap alone
 *  would let a long all-day auto-detected record swallow an unrelated session;
 *  start proximity alone would match a session that merely began near a
 *  different one. */
export function matchActivityToWorkout(
  activity: ActivityInput,
  workouts: WorkoutWindow[],
): string | null {
  const win = activityWindow(activity);
  let best: { id: string; delta: number } | null = null;
  for (const w of workouts) {
    const overlaps = win.startMs < w.endMs && win.endMs > w.startMs;
    if (!overlaps) continue;
    const delta = Math.abs(w.startMs - win.startMs);
    if (delta > MATCH_TOLERANCE_MS) continue;
    if (!best || delta < best.delta) best = { id: w.workout_id, delta };
  }
  return best?.id ?? null;
}

/** Rank an activity as a recording of its session: better sensor first, then
 *  denser stream, then external_id for a stable tie-break. Lower wins. */
function quality(a: ActivityInput): [number, number, string] {
  return [HR_SOURCE_RANK[resolveHrSource(a.device_id)], -toHrSamples(a.hr_samples).length, a.external_id];
}

function betterThan(a: ActivityInput, b: ActivityInput): boolean {
  const [qa, da, ia] = quality(a);
  const [qb, db, ib] = quality(b);
  if (qa !== qb) return qa < qb;
  if (da !== db) return da < db;
  return ia < ib;
}

/** Collapse the same session recorded by two devices.
 *
 *  A 24/7 band will record rides alongside the watch, producing two rows for
 *  one session with different external_ids — a unique key on
 *  (user_id, external_id) cannot express that, so the rule is window-based.
 *
 *  Overlapping records from the SAME device are left alone: one device cannot
 *  double-record a session, so those are two genuine activities. */
export function dedupeActivities(activities: ActivityInput[]): {
  kept: ActivityInput[];
  superseded: Array<{ external_id: string; superseded_by: string }>;
} {
  const kept: ActivityInput[] = [];
  const superseded: Array<{ external_id: string; superseded_by: string }> = [];

  // Stable order so the result never depends on how the ingest happened to
  // batch its rows.
  const ordered = [...activities].sort((a, b) => a.external_id.localeCompare(b.external_id));

  for (const candidate of ordered) {
    const cw = activityWindow(candidate);
    const rivalIndex = kept.findIndex((k) => {
      if (k.device_id === candidate.device_id) return false;
      const kw = activityWindow(k);
      return cw.startMs < kw.endMs && cw.endMs > kw.startMs;
    });

    if (rivalIndex === -1) {
      kept.push(candidate);
      continue;
    }

    const rival = kept[rivalIndex];
    if (betterThan(candidate, rival)) {
      kept[rivalIndex] = candidate;
      superseded.push({ external_id: rival.external_id, superseded_by: candidate.external_id });
    } else {
      superseded.push({ external_id: candidate.external_id, superseded_by: rival.external_id });
    }
  }

  return { kept, superseded };
}
