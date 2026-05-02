import {
  WITHINGS_MEAS_TYPE,
  toReal,
  type WithingsActivity,
  type WithingsMeasureGroup,
} from "./withings";

export type DayRow = {
  user_id: string;
  date: string;
  weight_kg?: number | null;
  body_fat_pct?: number | null;
  fat_mass_kg?: number | null;
  fat_free_mass_kg?: number | null;
  muscle_mass_kg?: number | null;
  bone_mass_kg?: number | null;
  hydration_kg?: number | null;
  exercise_min?: number | null;
  source: string;
  updated_at: string;
};

/** Merge Withings measurement groups + activity rollups into per-day rows.
 *  - Body comp: pick the LATEST reading per day per type (scale weighs once,
 *    but a user might step on twice — last wins).
 *  - Activity: only `exercise_min` is taken from Withings. Steps, distance,
 *    active/total calories are owned by Apple Health (sourced from Garmin),
 *    which is more accurate. Withings sync MUST NOT overwrite those columns.
 *  Returns a Map keyed by YYYY-MM-DD. */
export function mergeWithingsToRows(
  userId: string,
  measureGroups: WithingsMeasureGroup[],
  activities: WithingsActivity[],
): Map<string, DayRow> {
  const byDate = new Map<string, DayRow>();
  const ensure = (date: string): DayRow => {
    let row = byDate.get(date);
    if (!row) {
      row = { user_id: userId, date, source: "withings", updated_at: new Date().toISOString() };
      byDate.set(date, row);
    }
    return row;
  };

  // Group by date, pick latest measurement per type
  const sorted = [...measureGroups].sort((a, b) => a.date - b.date);
  for (const grp of sorted) {
    const date = new Date(grp.date * 1000).toISOString().slice(0, 10);
    const row = ensure(date);
    for (const m of grp.measures) {
      const v = toReal(m.value, m.unit);
      switch (m.type) {
        case WITHINGS_MEAS_TYPE.WEIGHT:
          row.weight_kg = +v.toFixed(2);
          break;
        case WITHINGS_MEAS_TYPE.FAT_RATIO:
          row.body_fat_pct = +v.toFixed(2);
          break;
        case WITHINGS_MEAS_TYPE.FAT_MASS:
          row.fat_mass_kg = +v.toFixed(2);
          break;
        case WITHINGS_MEAS_TYPE.FAT_FREE_MASS:
          row.fat_free_mass_kg = +v.toFixed(2);
          break;
        case WITHINGS_MEAS_TYPE.MUSCLE_MASS:
          row.muscle_mass_kg = +v.toFixed(2);
          break;
        case WITHINGS_MEAS_TYPE.BONE_MASS:
          row.bone_mass_kg = +v.toFixed(2);
          break;
        case WITHINGS_MEAS_TYPE.HYDRATION:
          row.hydration_kg = +v.toFixed(2);
          break;
      }
    }
  }

  // Activity: only exercise minutes. Steps / distance / calories belong to
  // Apple Health (Garmin) — see source-priority note above.
  for (const a of activities) {
    if (!a.date) continue;
    const exerciseSec = (a.moderate ?? 0) + (a.intense ?? 0);
    if (exerciseSec > 0) {
      const row = ensure(a.date);
      row.exercise_min = Math.round(exerciseSec / 60);
    }
  }

  return byDate;
}
