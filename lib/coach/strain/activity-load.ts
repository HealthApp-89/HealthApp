import { DEVICE_HR_SOURCE } from "./constants";
import { banisterOverIntervals } from "./trimp";
import type { HrSample, HrSource, TimeWindow } from "./types";

/** The subset of a garmin_activities row the load math needs. */
export type ActivityInput = {
  external_id: string;
  started_at: string;
  duration_s: number;
  device_id: string | null;
  hr_samples: Array<[number, number]> | null;
  activity_type: string | null;
};

/** Raw [[ts, bpm]] pairs → sorted, validated samples. Garmin emits nulls for
 *  off-wrist moments inside an activity; they are dropped rather than
 *  interpolated, and the resulting gap is handled by the interval clamp. */
export function toHrSamples(raw: Array<[number, number]> | null): HrSample[] {
  if (!raw) return [];
  const out: HrSample[] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [ts, bpm] = pair;
    if (!Number.isFinite(ts) || !Number.isFinite(bpm)) continue;
    out.push({ ts, bpm });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** The wall-clock span this activity occupied. Used both to score it and to
 *  cut it out of the baseline term. */
export function activityWindow(a: ActivityInput): TimeWindow {
  const startMs = Date.parse(a.started_at);
  return { startMs, endMs: startMs + Math.max(0, a.duration_s) * 1000 };
}

/** Banister TRIMP over the activity's own HR stream, at whatever density the
 *  device recorded. Zero when no stream arrived — the baseline term still
 *  covers the span in that case, because match-sessions only excludes windows
 *  for activities that are actually being scored here. */
export function activityTrimp(a: ActivityInput, hrRest: number, hrMax: number): number {
  return banisterOverIntervals(toHrSamples(a.hr_samples), hrRest, hrMax);
}

/** Sensor behind an activity's HR, from the hand-maintained device map.
 *  Unknown devices resolve to 'unknown' and rank last in dedup — never guessed
 *  from the signal. */
export function resolveHrSource(deviceId: string | null): HrSource {
  if (!deviceId) return "unknown";
  return DEVICE_HR_SOURCE[deviceId] ?? "unknown";
}
