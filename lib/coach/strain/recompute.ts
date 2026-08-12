import type { SupabaseClient } from "@supabase/supabase-js";
import { localDayRangeUtc } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { brzycki } from "@/lib/coach/e1rm";
import { assembleDay, type AssembleResult, type AssembleWorkout } from "./assemble";
import { medianGapSeconds, toHrSamples } from "./index";
import type { ActivityInput } from "./activity-load";
import type { HrSample } from "./types";
import type { MechanicalExercise } from "./mechanical-load";

const DEFAULT_HR_MAX = 190;
const DEFAULT_HR_REST = 50;

/** Read one day's inputs and assemble its strain. WRITES NOTHING.
 *
 *  Separated from the writer below so an audit can compare stored against
 *  computed without healing the discrepancy it is looking for.
 *
 *  Returns `{ result: null, skipped }` when the day has no usable input. */
export async function computeDayStrain(args: {
  supabase: SupabaseClient;
  userId: string;
  dateIso: string;
}): Promise<{ result: AssembleResult | null; allDaySamples: HrSample[]; skipped?: string }> {
  const { supabase, userId, dateIso } = args;
  const tz = await getUserTimezone(userId);
  const { startUtc } = localDayRangeUtc(dateIso, tz);

  const [
    { data: profile },
    { data: dayLog },
    { data: activityRows },
    { data: workoutRows, error: workoutErr },
  ] = await Promise.all([
    supabase.from("profiles").select("age").eq("user_id", userId).maybeSingle(),
    supabase
      .from("daily_logs")
      .select("resting_hr")
      .eq("user_id", userId)
      .eq("date", dateIso)
      .maybeSingle(),
    supabase
      .from("garmin_activities")
      .select(
        "external_id, started_at, duration_s, device_id, activity_type, hr_samples, superseded_by",
      )
      .eq("user_id", userId)
      .eq("local_date", dateIso),
    supabase
      .from("workouts")
      .select(
        "id, started_at, date, duration_min, exercises(name, exercise_sets(kg, reps, warmup, rir, started_at, work_seconds))",
      )
      .eq("user_id", userId)
      .eq("date", dateIso),
  ]);
  if (workoutErr) throw workoutErr;

  const hrMax = profile?.age ? Math.round(208 - 0.7 * profile.age) : DEFAULT_HR_MAX;
  const hrRest = dayLog?.resting_hr ?? DEFAULT_HR_REST;

  // All-day stream lives on garmin_daily.raw.hr_samples, written by the ingest.
  const { data: garminDay, error: garminDayErr } = await supabase
    .from("garmin_daily")
    .select("raw")
    .eq("user_id", userId)
    .eq("date", dateIso)
    .maybeSingle();
  if (garminDayErr) throw garminDayErr;
  const rawAllDay = (garminDay?.raw?.hr_samples ?? null) as Array<[number, number]> | null;
  const allDaySamples: HrSample[] = toHrSamples(rawAllDay);

  const activities: ActivityInput[] = (activityRows ?? [])
    .filter((r) => !r.superseded_by)
    .map((r) => ({
      external_id: r.external_id,
      started_at: r.started_at,
      duration_s: r.duration_s,
      device_id: r.device_id,
      activity_type: r.activity_type,
      hr_samples: r.hr_samples,
    }));

  const workouts: AssembleWorkout[] = (workoutRows ?? []).map((w) => {
    const exercises: MechanicalExercise[] = (w.exercises ?? []).map((e: {
      name: string;
      exercise_sets: Array<{
        kg: number | null;
        reps: number | null;
        warmup: boolean;
        rir: number | null;
      }>;
    }) => ({
      name: e.name,
      sets: (e.exercise_sets ?? []).map((s) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
        rir: s.rir,
      })),
      // Best e1RM WITHIN the session: the alternative is a history query per
      // exercise per day, which would make a backfill over 500 days quadratic.
      // Intensity is a redistribution factor, so a same-session reference is
      // sufficient and keeps recompute a bounded number of queries.
      e1rm: bestSessionE1rm(e.exercise_sets ?? []),
    }));
    const startMs = w.started_at ? Date.parse(w.started_at) : Date.parse(startUtc);
    const endMs = startMs + (w.duration_min ?? 60) * 60_000;
    return { workout_id: w.id, startMs, endMs, exercises };
  });

  if (allDaySamples.length === 0 && activities.length === 0 && workouts.length === 0) {
    return { result: null, allDaySamples, skipped: "no_input" };
  }

  const { data: week } = await supabase
    .from("training_weeks")
    .select("rir_target")
    .eq("user_id", userId)
    .lte("week_start", dateIso)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  const result = assembleDay({
    allDaySamples,
    activities,
    workouts,
    hrRest,
    hrMax,
    rirTarget: week?.rir_target ?? null,
  });

  return { result, allDaySamples };
}

/** Recompute AND store one day's strain. The SINGLE writer of
 *  daily_logs.strain — the Garmin ingest and both logger session routes all
 *  funnel here, so there is one place where the number is decided.
 *
 *  A day with no HR and no workout is left ALONE rather than written as 0:
 *  absence of data is not absence of strain, and overwriting a historical
 *  value with 0 would be a silent data loss. */
export async function recomputeStrainForDay(args: {
  supabase: SupabaseClient;
  userId: string;
  dateIso: string;
}): Promise<{ strain: number | null; skipped?: string }> {
  const { supabase, userId, dateIso } = args;
  const { result, allDaySamples, skipped } = await computeDayStrain(args);
  if (!result) return { strain: null, skipped };

  const { error } = await supabase.from("daily_logs").upsert(
    {
      user_id: userId,
      date: dateIso,
      strain: result.strain,
      hr_sample_density: medianGapSeconds(allDaySamples),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,date" },
  );
  if (error) throw error;

  if (result.superseded.length > 0) {
    await Promise.all(
      result.superseded.map((s) =>
        supabase
          .from("garmin_activities")
          .update({ superseded_by: s.superseded_by })
          .eq("user_id", userId)
          .eq("external_id", s.external_id),
      ),
    );
  }

  return { strain: result.strain };
}

/** Highest Brzycki e1RM among a session's own non-warmup 1–12 rep sets. Null
 *  when nothing qualifies, which makes intensityFactor neutral. */
function bestSessionE1rm(
  sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }>,
): number | null {
  let best: number | null = null;
  for (const s of sets) {
    if (s.warmup || !s.kg || !s.reps) continue;
    if (s.reps < 1 || s.reps > 12) continue;
    const v = brzycki(s.kg, s.reps);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}
