// lib/coach/prescription/recent-workouts-discovery.ts
//
// Materializes "what the athlete actually trains" for a session_type by
// scanning recent workouts. Sits below user_session_templates and above
// SESSION_PLANS in the resolution chain — heals the "SESSION_PLANS lists
// RDL but I never do RDL" failure mode automatically.
//
// Schema notes:
//   - workouts.type (not session_type), workouts.date (not performed_on)
//   - exercises has name + position; no `key` column (library key is matched
//     by name)
//   - exercise_sets has kg/reps/warmup/set_index/duration_seconds/failure;
//     no rpe/rir columns

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { resolveExercise } from "@/lib/coach/exercise-library";
import { tierOf } from "@/lib/coach/session-structure/tiers";

const MIN_SESSIONS_REQUIRED = 4; // need at least N sessions of this type to discover
const PRESENCE_THRESHOLD = 0.5;  // exercise must appear in ≥50% of recent sessions
const SCAN_WINDOW_COUNT = 8;

type RawSet = {
  kg: number | null;
  reps: number | null;
  warmup: boolean | null;
  set_index: number | null;
  duration_seconds: number | null;
  failure: boolean | null;
};
type RawExercise = {
  name: string;
  position: number | null;
  exercise_sets: RawSet[] | null;
};
type RawWorkout = {
  id: string;
  type: string | null;
  date: string;
  exercises: RawExercise[] | null;
};

/** Returns the PlannedExercise[] that appear in ≥50% of the user's last
 *  4-8 sessions of the given session_type. Each exercise's baseKg is the
 *  max kg observed in the user's recent matching (non-warmup) sets. Returns
 *  null when fewer than MIN_SESSIONS_REQUIRED of this type exist — signals
 *  the caller to fall through to SESSION_PLANS. */
export async function discoverEffectiveExercises(opts: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
}): Promise<PlannedExercise[] | null> {
  const { supabase, userId, sessionType } = opts;

  const { data: workoutsRaw, error: wErr } = await supabase
    .from("workouts")
    .select(
      "id, type, date, exercises(name, position, exercise_sets(kg, reps, warmup, set_index, duration_seconds, failure))",
    )
    .eq("user_id", userId)
    .eq("type", sessionType)
    .order("date", { ascending: false })
    .limit(SCAN_WINDOW_COUNT);

  if (wErr || !workoutsRaw || workoutsRaw.length < MIN_SESSIONS_REQUIRED) return null;

  const workouts = workoutsRaw as unknown as RawWorkout[];

  // Tally per-exercise presence; one count per session per exercise (a name
  // appearing twice in one session still counts once).
  type PresenceEntry = {
    count: number;
    exemplar: { name: string; kgs: number[]; reps: number[]; setsPerSession: number[] };
  };
  const presence: Map<string, PresenceEntry> = new Map();

  for (const w of workouts) {
    // Per-session working-set tally. Presence counts ONCE per session per
    // name, but sets accumulate from EVERY row bearing that name: warmup ramp
    // entries are stored as separate `exercises` rows sharing the working
    // entry's name (see augmentFirstLoadedCompoundWithWarmups), so the old
    // "skip the second row" guard discarded the working sets of any lift with
    // a warmup ramp.
    const sessionSetCounts = new Map<string, number>();
    for (const ex of w.exercises ?? []) {
      const k = ex.name.toLowerCase();
      const entry: PresenceEntry =
        presence.get(k) ?? { count: 0, exemplar: { name: ex.name, kgs: [], reps: [], setsPerSession: [] } };
      if (!sessionSetCounts.has(k)) {
        entry.count += 1;
        sessionSetCounts.set(k, 0);
      }
      for (const s of ex.exercise_sets ?? []) {
        // Exclude warmup sets from baseKg/baseReps so the discovered exemplar
        // tracks working-set loads and working-set COUNTS, not warmup ramping.
        if (s.warmup) continue;
        if (typeof s.kg === "number") entry.exemplar.kgs.push(s.kg);
        if (typeof s.reps === "number") entry.exemplar.reps.push(s.reps);
        sessionSetCounts.set(k, (sessionSetCounts.get(k) ?? 0) + 1);
      }
      presence.set(k, entry);
    }
    // An appearance contributing zero non-warmup sets is not evidence of
    // working volume — don't let it drag the median down.
    for (const [k, n] of sessionSetCounts) {
      if (n > 0) presence.get(k)!.exemplar.setsPerSession.push(n);
    }
  }

  const totalSessions = workouts.length;
  const survivors: PlannedExercise[] = [];

  // Library order preserved when overlapping with SESSION_PLANS — gives stable UI ordering.
  const libraryOrder = SESSION_PLANS[sessionType] ?? [];
  const libraryKeys = new Set(libraryOrder.map((e) => e.name.toLowerCase()));

  // First pass: every library exercise, in template order.
  //
  // A template entry below the presence threshold is KEPT at its template
  // defaults rather than dropped. Dropping it made this function a one-way
  // door: the prescription is what the athlete trains from, so an exercise
  // that fell out of the last 8 sessions vanished from the prescription, which
  // guaranteed it stayed out — it could never climb back over the threshold it
  // had just failed. Hip Thrust (Machine) was performed 3x in June 2026 and
  // then disappeared from every prescription, leaving Legs day with no hip
  // hinge at all; RDL never appeared once. Both are in SESSION_PLANS.
  //
  // So discovery now only ever ADDS or RE-NUMBERS, never REMOVES. Its original
  // job — "SESSION_PLANS lists RDL but I never do RDL" — is still served by the
  // second pass and by refreshing baseKg/baseReps/sets below. Removing an
  // exercise is a deliberate act with three explicit paths already built for
  // it (manual_session_edits, session_structure_overrides, editing the
  // template); it should not happen by attrition.
  for (const libEx of libraryOrder) {
    const k = libEx.name.toLowerCase();
    const found = presence.get(k);
    if (!found || found.count / totalSessions < PRESENCE_THRESHOLD) {
      survivors.push({ ...libEx });
      continue;
    }
    survivors.push({
      ...libEx,
      baseKg: found.exemplar.kgs.length > 0 ? Math.max(...found.exemplar.kgs) : libEx.baseKg,
      baseReps: found.exemplar.reps.length > 0 ? Math.round(median(found.exemplar.reps)) : libEx.baseReps,
      // Realized working-set count. Median (not max) for consistency with
      // baseReps and robustness to a single outlier session.
      sets: found.exemplar.setsPerSession.length > 0
        ? Math.round(median(found.exemplar.setsPerSession))
        : (libEx.sets ?? 3),
    });
  }

  // Second pass: non-library exercises (user added something off-script, or
  // rotation swapped in a variant whose name isn't in SESSION_PLANS). Insert
  // by fatigue tier — before the first survivor with a strictly higher tier —
  // so a tier-2 secondary compound like "Leg Press Single Leg" lands after
  // the tier-1 squat, not appended behind the tier-3 isolation machines.
  // Library order (already tier-ascending) is never disturbed.
  // Library ids already covered by a template entry. Now that the first pass
  // KEEPS every template exercise, a logged name that differs only in wording
  // from a template name would surface as a second entry for the same
  // movement — "Seated Calf Raise" (template) beside "Seated Calf Raise
  // (Machine)" (logged). Dedup on the resolved library id rather than the
  // string, so aliases collapse. Unresolvable names fall through and are
  // compared by name alone, which is the pre-existing behaviour.
  const libraryIds = new Set(
    libraryOrder.map((e) => resolveExercise(e.name)?.id).filter((id): id is string => id != null),
  );

  for (const [k, entry] of presence) {
    if (libraryKeys.has(k)) continue;
    const resolvedId = resolveExercise(entry.exemplar.name)?.id;
    if (resolvedId != null && libraryIds.has(resolvedId)) continue;
    if (entry.count / totalSessions < PRESENCE_THRESHOLD) continue;
    const ex: PlannedExercise = {
      name: entry.exemplar.name,
      baseKg: entry.exemplar.kgs.length > 0 ? Math.max(...entry.exemplar.kgs) : undefined,
      baseReps: entry.exemplar.reps.length > 0 ? Math.round(median(entry.exemplar.reps)) : undefined,
      sets: entry.exemplar.setsPerSession.length > 0
        ? Math.round(median(entry.exemplar.setsPerSession))
        : 3,
    };
    const tier = tierOf(ex);
    const insertAt = survivors.findIndex((s) => tierOf(s) > tier);
    if (insertAt === -1) survivors.push(ex);
    else survivors.splice(insertAt, 0, ex);
  }

  return survivors.length > 0 ? survivors : null;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}
