// lib/coach/adherence.ts
//
// Computes planned-vs-actual session adherence for a Mon-Sun window plus
// per-muscle-group volume deltas vs the prior 28-day average. Pure SELECT
// against existing tables — no schema dependency beyond training_weeks +
// workouts + exercise_sets.
//
// Matching is lenient string-overlap, not strict equality, because the user's
// workouts.type values are free-form (history shows "Lower Body", "Legs And
// Arms", "Chest Triceps", etc., not always matching plan strings exactly).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EnduranceActivity, Weekday } from "@/lib/data/types";
import { categorize, type ExerciseCategory } from "@/lib/coach/exercise-categories";
import { workingVolume, type SetRow } from "@/lib/coach/derived";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import type {
  EnduranceProfile,
  EnduranceSessionPlan,
} from "@/lib/coach/endurance/types";
import { defaultZ2Cap } from "@/lib/coach/endurance/hr-zones";

const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Mon-first Weekday → numeric 0=Sun..6=Sat (matches Date#getDay() and
 *  EnduranceSessionPlan key shape). */
const WEEKDAY_TO_NUM: Record<Weekday, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 0,
};

/** UTC weekday from YYYY-MM-DD. Returns one of WEEKDAYS. Mirrors the Mon-first
 *  ordering used everywhere else in the app. */
function weekdayOf(ymd: string): Weekday {
  const d = new Date(ymd + "T00:00:00Z");
  // getUTCDay: 0=Sun..6=Sat. Map to Mon-first index.
  const idx = (d.getUTCDay() + 6) % 7;
  return WEEKDAYS[idx];
}

/** Strip punctuation, lowercase, split on whitespace. */
function tokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Lenient match: planned matches actual if any token of `planned` appears as
 *  a substring of any token of `actual` (or vice-versa for plurals). Mobility
 *  / REST require exact-token match (no fuzzy). */
function matches(planned: string | null, actual: string | null): boolean {
  if (!planned || !actual) return false;
  const p = tokens(planned);
  const a = tokens(actual);
  if (p.includes("rest") || a.includes("rest")) {
    return p.includes("rest") && a.includes("rest");
  }
  if (p.includes("mobility") || a.includes("mobility")) {
    return p.includes("mobility") && a.includes("mobility");
  }
  for (const pt of p) {
    for (const at of a) {
      if (at.includes(pt) || pt.includes(at)) return true;
    }
  }
  return false;
}

/** Per-day adherence verdict.
 *  - 'rest': planned was REST AND no workout AND no swap (honored rest).
 *  - 'as_planned': workout type matches the originally-committed session.
 *  - 'swapped': mid-week edit was honored. Two sub-cases:
 *    a. swapped_to matches the actual workout (e.g., Chest → Mobility, did mobility)
 *    b. swapped_to is REST AND no workout (e.g., Chest → REST as a deliberate skip)
 *  - 'missed': nothing else — the athlete committed to something and didn't deliver. */
export type AdherenceDayStatus = "as_planned" | "swapped" | "missed" | "rest";

/** Per-day endurance verdict, parallel to AdherenceDayStatus but anchored to
 *  the week's `endurance_session_plan` + `endurance_activities` rows.
 *  - 'not_prescribed': no plan for the day or explicit `rest` entry.
 *  - 'as_planned': matching activity by sport + ±15min duration tolerance,
 *    with avg_hr (when available) not exceeding the Z2 cap derived from
 *    `endurance_profile.threshold_hr`.
 *  - 'over_intensity': sport+duration matches but avg_hr > hr_cap.
 *  - 'under_volume': any non-trivial endurance activity (>=10min) was logged
 *    on the day but it doesn't match the prescribed sport/duration shape —
 *    partial credit, not a missed day.
 *  - 'missed': prescribed day, nothing logged. */
export type EnduranceStatus =
  | "as_planned"
  | "over_intensity"
  | "under_volume"
  | "missed"
  | "not_prescribed";

/** One row per day in the AdherenceResult.days array. AI consumers use this to
 *  produce prose like "you planned Chest, swapped to Mobility, did the walk"
 *  rather than just "Tuesday: planned Chest, actual nothing". */
export type AdherenceDay = {
  day: Weekday;
  /** From original_session_plan if the week has been edited; else from
   *  session_plan. Anchored to the Sunday commitment regardless of swaps. */
  planned: string;
  /** Current session_plan[day] when it differs from planned (a swap happened).
   *  Null when planned === current. */
  swapped_to: string | null;
  /** workouts[date].type for this day, or null if no workout was logged. */
  actual: string | null;
  status: AdherenceDayStatus;
  /** Endurance-pillar verdict. Optional: omitted on weeks with no
   *  endurance_session_plan to keep pre-endurance consumers unchanged. */
  endurance_status?: EnduranceStatus;
};

export type AdherenceResult = {
  week_start: string;
  planned: Partial<Record<Weekday, string>>;
  actual: Partial<Record<Weekday, string>>;
  /** Per-day enriched view. AI consumers of compute_adherence use this to
   *  produce prose distinguishing swapped from missed. */
  days: AdherenceDay[];
  sessions_planned: number;
  sessions_done: number;
  sessions_on_plan: number;
  adherence_pct: number;     // sessions_on_plan / sessions_planned * 100
  done_pct: number;          // sessions_done / sessions_planned * 100
  /** Proportional delta vs the prior-28d weekly average per muscle category.
   *  -0.12 = -12%, +0.08 = +8%. A category is OMITTED entirely when the
   *  baseline is too thin to compute a reliable delta:
   *    - fewer than 6 working sets in the category across the 28-day window
   *    - the category appeared in fewer than 2 distinct weeks
   *  Coaches must NOT cite "drift" or "volume change" for an omitted category
   *  — the absence IS the signal that we don't have enough data to tell.
   *  This kills the 2026-05-31 Carter "squat -14% drift" false positive that
   *  fired on 3 weeks of in-block data. */
  muscle_volume_vs_4w_avg: Partial<Record<ExerciseCategory, number>>;
};

/** Pure endurance-adherence verdict for a single day.
 *
 *  Matching rule: any activity on the day with the prescribed sport whose
 *  duration is within ±15 min of the prescribed duration is the "matching"
 *  activity. With a match: avg_hr > hr_cap → 'over_intensity', else
 *  'as_planned'. Without a match but ≥10min of any endurance work →
 *  'under_volume'. Otherwise: 'missed'. Null/rest plan → 'not_prescribed'. */
export function computeEnduranceStatus(args: {
  prescribed: EnduranceSessionPlan | null;
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  activitiesOnDay: ReadonlyArray<
    Pick<EnduranceActivity, "duration_s" | "avg_hr" | "sport">
  >;
  hrCap: number | null;
}): EnduranceStatus {
  const entry = args.prescribed ? args.prescribed[args.weekday] : null;
  if (!entry || entry.type === "rest") return "not_prescribed";

  const targetSeconds = entry.duration_min * 60;
  const tolerance = 15 * 60;
  const match = args.activitiesOnDay.find(
    (a) =>
      a.sport === entry.sport &&
      Math.abs(a.duration_s - targetSeconds) <= tolerance,
  );
  if (!match) {
    const anyActivity = args.activitiesOnDay.find((a) => a.duration_s >= 600);
    if (anyActivity) return "under_volume";
    return "missed";
  }
  // Prefer per-entry hr_cap when present; fall back to the profile-derived
  // Z2 cap. The HR check is only meaningful when both numbers exist.
  const effectiveCap = entry.hr_cap ?? args.hrCap;
  if (effectiveCap && match.avg_hr && match.avg_hr > effectiveCap) {
    return "over_intensity";
  }
  return "as_planned";
}

/** Compute adherence for a single Mon-Sun window. */
export async function computeAdherence(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string, // YYYY-MM-DD, must be a Monday
): Promise<AdherenceResult> {
  // Range bounds (Mon..Sun inclusive)
  const start = new Date(weekStart + "T00:00:00Z");
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const endStr = end.toISOString().slice(0, 10);

  // 1. Plan
  const { data: weekRow, error: weekErr } = await supabase
    .from("training_weeks")
    .select("session_plan, original_session_plan, endurance_session_plan")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (weekErr) throw weekErr;
  const originalPlan = (weekRow?.original_session_plan ?? null) as Partial<Record<Weekday, string>> | null;
  const currentPlan = (weekRow?.session_plan ?? {}) as Partial<Record<Weekday, string>>;
  /** Anchor `planned` to the original committed plan when it exists. Mid-week
   *  swaps populate original_session_plan via the /swap endpoint, so this read
   *  ensures adherence math doesn't retroactively flatter the recap. */
  const planned = (originalPlan ?? currentPlan) as Partial<Record<Weekday, string>>;
  const endurancePlan =
    (weekRow?.endurance_session_plan ?? null) as EnduranceSessionPlan | null;

  // 1b. Endurance profile (for HR cap) + endurance activities in the window.
  //     Both are optional — if no profile or no activities exist, the per-day
  //     endurance_status simply falls through to 'missed'/'not_prescribed'.
  const [{ data: profileRow, error: profErr }, { data: enduranceRows, error: actErr }] = await Promise.all([
    supabase
      .from("athlete_profile_documents")
      .select("endurance_profile")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("endurance_activities")
      .select("local_date, duration_s, avg_hr, sport")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .gte("local_date", weekStart)
      .lte("local_date", endStr),
  ]);
  if (profErr) throw profErr;
  if (actErr) throw actErr;
  const enduranceProfile = (profileRow?.endurance_profile ?? null) as EnduranceProfile | null;
  const hrCap =
    enduranceProfile?.threshold_hr != null
      ? defaultZ2Cap(enduranceProfile.threshold_hr)
      : null;

  // Group activities by local_date for O(1) per-day lookup.
  type ActivityRow = Pick<EnduranceActivity, "duration_s" | "avg_hr" | "sport">;
  const activitiesByDate = new Map<string, ActivityRow[]>();
  for (const row of (enduranceRows ?? []) as Array<{
    local_date: string;
    duration_s: number;
    avg_hr: number | null;
    sport: EnduranceActivity["sport"];
  }>) {
    const list = activitiesByDate.get(row.local_date) ?? [];
    list.push({ duration_s: row.duration_s, avg_hr: row.avg_hr, sport: row.sport });
    activitiesByDate.set(row.local_date, list);
  }

  // 2. Actual workouts in window with sets for volume math
  const { data: workouts, error: woErr } = await supabase
    .from("workouts")
    .select("date, type, exercises(name, exercise_sets(kg, reps, warmup, set_index, duration_seconds, failure))")
    .eq("user_id", userId)
    .gte("date", weekStart)
    .lte("date", endStr);
  if (woErr) throw woErr;

  // Build actual per-day map (first workout per day wins; rare edge: 2 sessions same day)
  const actual: Partial<Record<Weekday, string>> = {};
  for (const w of workouts ?? []) {
    const wd = weekdayOf(w.date);
    if (!actual[wd]) actual[wd] = w.type ?? "Workout";
  }

  // 3. Adherence counts + per-day breakdown
  //
  // session_plan keys may be 3-letter ("Mon") OR full-name ("Monday") form.
  // The AI planning bot writes the latter; the migration spec assumes the
  // former. Read via readSessionForDay so both forms resolve. See
  // lib/coach/session-plan-reader.ts for the historical context.
  let sessions_planned = 0;
  let sessions_done = 0;
  let sessions_on_plan = 0;
  const days: AdherenceDay[] = [];
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const wd = WEEKDAYS[i];
    const dayDate = new Date(start);
    dayDate.setUTCDate(start.getUTCDate() + i);
    const dayStr = dayDate.toISOString().slice(0, 10);

    const p = readSessionForDay(planned as Record<string, string>, wd) ?? null;
    const c = readSessionForDay(currentPlan as Record<string, string>, wd) ?? null;
    const a = actual[wd] ?? null;
    const pIsRest = !!p && tokens(p).includes("rest");
    if (p && !pIsRest) sessions_planned += 1;
    if (a) sessions_done += 1;
    if (p && a && matches(p, a)) sessions_on_plan += 1;

    // Per-day status derivation
    const swapped_to = p && c && p !== c ? c : null;
    let status: AdherenceDayStatus;
    if (pIsRest && !a && !swapped_to) {
      status = "rest";
    } else if (p && a && matches(p, a)) {
      status = "as_planned";
    } else if (swapped_to && a && matches(swapped_to, a)) {
      status = "swapped";
    } else if (swapped_to && !a && tokens(swapped_to).includes("rest")) {
      // Planned non-rest, swapped to REST, no workout — honoring the swap, not missed.
      status = "swapped";
    } else {
      status = "missed";
    }

    // Endurance pass — only attach the field when an endurance plan exists for
    // the week. Otherwise the field stays absent and pre-endurance consumers
    // see no behavior change.
    let endurance_status: EnduranceStatus | undefined;
    if (endurancePlan) {
      endurance_status = computeEnduranceStatus({
        prescribed: endurancePlan,
        weekday: WEEKDAY_TO_NUM[wd],
        activitiesOnDay: activitiesByDate.get(dayStr) ?? [],
        hrCap,
      });
    }

    days.push({
      day: wd,
      planned: p ?? "",
      swapped_to,
      actual: a,
      status,
      ...(endurance_status !== undefined ? { endurance_status } : {}),
    });
  }
  const adherence_pct = sessions_planned === 0 ? 0 : Math.round((sessions_on_plan / sessions_planned) * 100);
  const done_pct      = sessions_planned === 0 ? 0 : Math.round((sessions_done / sessions_planned) * 100);

  // 4. Volume per muscle group, this week vs prior-28d average. The delta is
  //    suppressed for categories with thin baselines — see the
  //    AdherenceResult.muscle_volume_vs_4w_avg doc for the exact thresholds.
  const thisWeekVol = bucketVolume(workouts ?? []);

  const priorEnd = new Date(start);
  priorEnd.setUTCDate(start.getUTCDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setUTCDate(priorEnd.getUTCDate() - 27);
  const { data: priorWorkouts, error: pwErr } = await supabase
    .from("workouts")
    .select("date, type, exercises(name, exercise_sets(kg, reps, warmup, set_index, duration_seconds, failure))")
    .eq("user_id", userId)
    .gte("date", priorStart.toISOString().slice(0, 10))
    .lte("date", priorEnd.toISOString().slice(0, 10));
  if (pwErr) throw pwErr;
  const priorVol = bucketVolume(priorWorkouts ?? []);
  // Convert sum-over-28d to weekly average
  const priorWeeklyAvg: Record<ExerciseCategory, number> = Object.fromEntries(
    Object.entries(priorVol).map(([k, v]) => [k, v / 4]),
  ) as Record<ExerciseCategory, number>;

  // Per-category baseline reliability: count working sets and distinct weeks.
  const baselineCounts = bucketBaselineCounts(
    priorWorkouts ?? [],
    priorStart.toISOString().slice(0, 10),
  );
  const MIN_BASELINE_SETS = 6;
  const MIN_BASELINE_WEEKS = 2;

  const muscle_volume_vs_4w_avg: Partial<Record<ExerciseCategory, number>> = {};
  for (const cat of Object.keys(thisWeekVol)) {
    const c = cat as ExerciseCategory;
    const counts = baselineCounts[c];
    if (!counts || counts.sets < MIN_BASELINE_SETS || counts.weeks < MIN_BASELINE_WEEKS) {
      // Thin baseline — omit. Carter's prompt teaches "absence = not enough
      // history to claim a drift" so the false positive never reaches chat.
      continue;
    }
    const avg = priorWeeklyAvg[c] ?? 0;
    const cur = thisWeekVol[c] ?? 0;
    if (avg === 0) {
      // Defensive: counts qualified the baseline, but the volume sum is 0
      // (e.g. an all-isometric/duration-based category). Skip — the delta
      // is meaningless and the prior `1` sentinel was misleading.
      continue;
    }
    muscle_volume_vs_4w_avg[c] = (cur - avg) / avg;
  }

  return {
    week_start: weekStart,
    planned,
    actual,
    days,
    sessions_planned,
    sessions_done,
    sessions_on_plan,
    adherence_pct,
    done_pct,
    muscle_volume_vs_4w_avg,
  };
}

/** Sum working volume per muscle category across a workout list. Warmups
 *  excluded by `workingVolume`. Uses categorize() for muscle-group mapping. */
function bucketVolume(
  workouts: Array<{
    type: string | null;
    exercises:
      | Array<{
          name: string;
          exercise_sets: Array<{ kg: number | null; reps: number | null; warmup: boolean; set_index: number; duration_seconds: number | null; failure: boolean }>;
        }>
      | null;
  }>,
): Record<ExerciseCategory, number> {
  const out: Record<ExerciseCategory, number> = {} as Record<ExerciseCategory, number>;
  for (const w of workouts) {
    for (const e of w.exercises ?? []) {
      const cat = categorize(e.name);
      if (cat === "uncategorized") continue;
      const vol = workingVolume((e.exercise_sets ?? []) as SetRow[]);
      out[cat] = (out[cat] ?? 0) + vol;
    }
  }
  return out;
}

/** Per-category coverage counts for the prior-28d window. Used to decide
 *  whether the muscle_volume_vs_4w_avg delta is reliable enough to surface.
 *  Each `sets` count is the number of non-warmup sets in the category;
 *  `weeks` is the count of distinct ISO weeks (Mon..Sun blocks) the category
 *  appeared in across the window. */
function bucketBaselineCounts(
  workouts: Array<{
    date: string;
    type: string | null;
    exercises:
      | Array<{
          name: string;
          exercise_sets: Array<{ kg: number | null; reps: number | null; warmup: boolean; set_index: number; duration_seconds: number | null; failure: boolean }>;
        }>
      | null;
  }>,
  priorStartIso: string,
): Partial<Record<ExerciseCategory, { sets: number; weeks: number }>> {
  const start = new Date(priorStartIso + "T00:00:00Z").getTime();
  // Tally sets per category and (category -> set-of-week-indices) for distinct
  // week counting. weekIdx = floor((date - priorStart) / 7d).
  const setCounts = new Map<ExerciseCategory, number>();
  const weekIdxs = new Map<ExerciseCategory, Set<number>>();
  for (const w of workouts) {
    const d = new Date(w.date + "T00:00:00Z").getTime();
    const weekIdx = Math.floor((d - start) / (7 * 24 * 60 * 60 * 1000));
    for (const e of w.exercises ?? []) {
      const cat = categorize(e.name);
      if (cat === "uncategorized") continue;
      let setsInExercise = 0;
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue;
        setsInExercise++;
      }
      if (setsInExercise === 0) continue;
      setCounts.set(cat, (setCounts.get(cat) ?? 0) + setsInExercise);
      const wks = weekIdxs.get(cat) ?? new Set<number>();
      wks.add(weekIdx);
      weekIdxs.set(cat, wks);
    }
  }
  const out: Partial<Record<ExerciseCategory, { sets: number; weeks: number }>> = {};
  for (const [cat, sets] of setCounts) {
    out[cat] = { sets, weeks: weekIdxs.get(cat)?.size ?? 0 };
  }
  return out;
}
