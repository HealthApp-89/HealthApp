// Pure mapper: validated Garmin per-day input → daily_logs partial row.
// Training Readiness → recovery; strain is passed in (derived in Task 2).
// Only present fields are emitted, so a missing metric never clobbers another
// source's column. Int columns are rounded. Spec §4.

import type { DailyLog } from "@/lib/data/types";

/** The per-day shape the ingest route forwards after Zod validation. All
 *  metric fields optional; absence means "Garmin had no value that day". */
export type GarminDayInput = {
  date: string;
  hrv?: number;
  resting_hr?: number;
  training_readiness?: number;
  sleep_hours?: number;
  sleep_score?: number;
  deep_sleep_hours?: number;
  rem_sleep_hours?: number;
  sleep_start_at?: string;
  sleep_end_at?: string;
  respiratory_rate?: number;
  steps?: number;
  distance_km?: number;
  calories?: number;
  active_calories?: number;
  spo2?: number;
  skin_temp_variation?: number;
};

type MappedRow = Partial<DailyLog> & {
  user_id: string;
  date: string;
  source: "garmin";
};

const INT_FIELDS = new Set(["steps", "calories", "active_calories"]);

export function mapToDailyLogs(
  input: GarminDayInput,
  strain: number | null,
): Omit<MappedRow, "user_id"> {
  // user_id is attached by the route; keep this mapper pure over the payload.
  const row: Record<string, unknown> = {
    date: input.date,
    source: "garmin",
  };

  // Direct raw → column mappings. Skin temp is intentionally NOT mapped
  // (Garmin reports variation, not absolute °C — spec open question, left null).
  const direct: Array<[keyof GarminDayInput, keyof DailyLog]> = [
    ["hrv", "hrv"],
    ["resting_hr", "resting_hr"],
    ["training_readiness", "recovery"],
    ["sleep_hours", "sleep_hours"],
    ["sleep_score", "sleep_score"],
    ["deep_sleep_hours", "deep_sleep_hours"],
    ["rem_sleep_hours", "rem_sleep_hours"],
    ["sleep_start_at", "sleep_start_at"],
    ["sleep_end_at", "sleep_end_at"],
    ["respiratory_rate", "respiratory_rate"],
    ["steps", "steps"],
    ["distance_km", "distance_km"],
    ["calories", "calories"],
    ["active_calories", "active_calories"],
    ["spo2", "spo2"],
  ];

  for (const [src, col] of direct) {
    const v = input[src];
    if (v === undefined || v === null) continue;
    row[col] = INT_FIELDS.has(col as string) && typeof v === "number"
      ? Math.round(v)
      : v;
  }

  if (strain !== null && strain !== undefined) row.strain = strain;

  return row as Omit<MappedRow, "user_id">;
}
