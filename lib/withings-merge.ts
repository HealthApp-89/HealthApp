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
  steps?: number | null;
  active_calories?: number | null;
  calories?: number | null;
  distance_km?: number | null;
  exercise_min?: number | null;
  source: string;
  updated_at: string;
};

/** Merge Withings measurement groups + activity rollups into per-day rows.
 *  - Body comp: pick the LATEST reading per day per type (scale weighs once,
 *    but a user might step on twice — last wins).
 *  - Activity: 1:1 mapping per day.
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

  for (const a of activities) {
    if (!a.date) continue;
    const row = ensure(a.date);
    if (a.steps != null) row.steps = a.steps;
    if (a.calories != null) row.active_calories = Math.round(a.calories);
    if (a.totalcalories != null) row.calories = Math.round(a.totalcalories);
    if (a.distance != null) row.distance_km = +(a.distance / 1000).toFixed(2);
    const exerciseSec = (a.moderate ?? 0) + (a.intense ?? 0);
    if (exerciseSec > 0) row.exercise_min = Math.round(exerciseSec / 60);
  }

  return byDate;
}
