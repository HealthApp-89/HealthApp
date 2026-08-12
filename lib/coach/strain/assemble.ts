import { activityTrimp, activityWindow, toHrSamples, type ActivityInput } from "./activity-load";
import { baselineTrimp } from "./baseline-load";
import { composeStrain } from "./compose";
import { dedupeActivities, type WorkoutWindow } from "./match-sessions";
import { mechanicalLoad, type MechanicalExercise } from "./mechanical-load";
import type { DayLoad, HrSample, TimeWindow } from "./types";

export type AssembleWorkout = WorkoutWindow & { exercises: MechanicalExercise[] };

export type AssembleInput = {
  allDaySamples: HrSample[];
  activities: ActivityInput[];
  workouts: AssembleWorkout[];
  hrRest: number;
  hrMax: number;
  rirTarget: number | null;
};

export type AssembleResult = {
  load: DayLoad;
  strain: number;
  keptActivityIds: string[];
  superseded: Array<{ external_id: string; superseded_by: string }>;
};

/** Build one day's three load terms and the resulting strain.
 *
 *  Pure — every input is passed in, so the whole model is testable without a
 *  database and the recompute writer stays a thin shell around it.
 *
 *  Matching plays no part here, deliberately: every kept activity is real
 *  cardio and every logged workout is real mechanical work, whether or not the
 *  two describe the same session. The double-count risk is wall-clock overlap
 *  between two HR sources, which the window exclusion below handles directly.
 *  `matchActivityToWorkout` stays available for diagnostics — which workouts a
 *  device actually witnessed — but nothing in the arithmetic needs it. */
export function assembleDay(input: AssembleInput): AssembleResult {
  const { kept, superseded } = dedupeActivities(input.activities);

  // Only activities whose HR is actually being scored may have their window
  // removed from the baseline. Cutting a window we cannot score would delete
  // that hour from the day entirely.
  const excluded: TimeWindow[] = [];
  let activity = 0;
  for (const a of kept) {
    if (toHrSamples(a.hr_samples).length < 2) continue;
    activity += activityTrimp(a, input.hrRest, input.hrMax);
    excluded.push(activityWindow(a));
  }

  const baseline = baselineTrimp(input.allDaySamples, excluded, input.hrRest, input.hrMax);

  let mechanical = 0;
  for (const w of input.workouts) {
    mechanical += mechanicalLoad(w.exercises, input.rirTarget);
  }

  const load: DayLoad = { baseline, activity, mechanical };
  return {
    load,
    strain: composeStrain(load),
    keptActivityIds: kept.map((a) => a.external_id),
    superseded,
  };
}
