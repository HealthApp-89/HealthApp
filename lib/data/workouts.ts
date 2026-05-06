import { createSupabaseServerClient } from "@/lib/supabase/server";
import { est1rm } from "@/lib/ui/score";

export type WorkoutSet = {
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  warmup: boolean;
  failure: boolean;
};

export type WorkoutExercise = {
  name: string;
  position: number;
  /** History-wide classification. "weighted" if any working set in this user's
   *  history has kg > 0; "bodyweight" otherwise. Computed in loadWorkouts. */
  kind: "weighted" | "bodyweight";
  sets: WorkoutSet[];
};

export type WorkoutSession = {
  id: string;
  date: string;
  type: string | null;
  duration_min: number | null;
  exercises: WorkoutExercise[];
  /** Total working volume in kg (kg × reps over weighted working sets). */
  vol: number;
  /** Total reps across bodyweight working sets (warmups excluded). */
  bwReps: number;
  /** Working set count (excludes warmup). */
  sets: number;
};

export type PR =
  | {
      kind: "weighted";
      name: string;
      kg: number;
      reps: number;
      est1rm: number;
      date: string;
    }
  | {
      kind: "bodyweight";
      name: string;
      totalReps: number;
      bestSetReps: number;
      date: string;
    };

export type ExerciseTrendPoint =
  | { kind: "weighted"; date: string; kg: number; reps: number; est1rm: number }
  | { kind: "bodyweight"; date: string; totalReps: number; bestSetReps: number };

/** Load every workout for the user, joined with exercises + sets. Newest first.
 *  Two passes over the result so each exercise gets a history-wide `kind`:
 *  exercises with at least one working weighted set anywhere in history are
 *  "weighted", otherwise "bodyweight". */
export async function loadWorkouts(userId: string): Promise<WorkoutSession[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workouts")
    .select(
      `id, date, type, duration_min,
       exercises(name, position,
         exercise_sets(kg, reps, duration_seconds, warmup, failure, set_index))`,
    )
    .eq("user_id", userId)
    .order("date", { ascending: false });

  if (error) throw error;

  type RawExercise = {
    name: string;
    position: number | null;
    exercise_sets: {
      kg: number | null;
      reps: number | null;
      duration_seconds: number | null;
      warmup: boolean;
      failure: boolean;
      set_index: number;
    }[];
  };

  const rawSessions = (data ?? []) as {
    id: string;
    date: string;
    type: string | null;
    duration_min: number | null;
    exercises: RawExercise[] | null;
  }[];

  // Pass 1: collect names of exercises that have at least one *working* set with
  // kg > 0 anywhere in the user's history. Warmups don't count — a single warmup
  // weighted row shouldn't flip an exercise to "weighted".
  const weightedNames = new Set<string>();
  for (const w of rawSessions) {
    for (const e of w.exercises ?? []) {
      for (const s of e.exercise_sets ?? []) {
        if (!s.warmup && (s.kg ?? 0) > 0) {
          weightedNames.add(e.name);
          break;
        }
      }
    }
  }

  // Pass 2: build sessions with classified exercises and split volumes.
  const sessions: WorkoutSession[] = [];
  for (const w of rawSessions) {
    const exercises: WorkoutExercise[] = (w.exercises ?? [])
      .map((e) => ({
        name: e.name,
        position: e.position ?? 0,
        kind: weightedNames.has(e.name)
          ? ("weighted" as const)
          : ("bodyweight" as const),
        sets: (e.exercise_sets ?? [])
          .slice()
          .sort((a, b) => a.set_index - b.set_index)
          .map((s) => ({
            kg: s.kg,
            reps: s.reps,
            duration_seconds: s.duration_seconds,
            warmup: s.warmup,
            failure: s.failure,
          })),
      }))
      .sort((a, b) => a.position - b.position);

    let vol = 0;
    let bwReps = 0;
    let setsCount = 0;
    for (const e of exercises) {
      for (const s of e.sets) {
        if (s.warmup) continue;
        setsCount += 1;
        if (s.kg && s.reps) vol += s.kg * s.reps;
        else if (!s.kg && s.reps) bwReps += s.reps;
      }
    }
    sessions.push({
      id: w.id,
      date: w.date,
      type: w.type,
      duration_min: w.duration_min,
      exercises,
      vol,
      bwReps,
      sets: setsCount,
    });
  }
  return sessions;
}

/** Per-exercise PR. Weighted exercises track highest est. 1RM working set;
 *  bodyweight exercises track the session with the most total working reps.
 *  Iteration is newest-first (matching loadWorkouts ordering) and uses
 *  strictly-greater comparisons so ties resolve to the newest session. */
export function buildPRs(workouts: WorkoutSession[]): PR[] {
  const prs = new Map<string, PR>();
  for (const w of workouts) {
    // Group bodyweight exercise sessions: per-exercise totals, computed once
    // per (workout, exercise) so we can compare totalReps across sessions.
    for (const e of w.exercises) {
      if (e.kind === "weighted") {
        for (const s of e.sets) {
          if (s.warmup || !s.kg || !s.reps) continue;
          const v = est1rm(s.kg, s.reps);
          const cur = prs.get(e.name);
          if (!cur || (cur.kind === "weighted" && v > cur.est1rm)) {
            prs.set(e.name, {
              kind: "weighted",
              name: e.name,
              kg: s.kg,
              reps: s.reps,
              est1rm: v,
              date: w.date,
            });
          }
        }
      } else {
        // bodyweight
        let totalReps = 0;
        let bestSetReps = 0;
        for (const s of e.sets) {
          if (s.warmup || s.kg || !s.reps) continue;
          totalReps += s.reps;
          if (s.reps > bestSetReps) bestSetReps = s.reps;
        }
        if (totalReps === 0) continue;
        const cur = prs.get(e.name);
        if (!cur || (cur.kind === "bodyweight" && totalReps > cur.totalReps)) {
          prs.set(e.name, {
            kind: "bodyweight",
            name: e.name,
            totalReps,
            bestSetReps,
            date: w.date,
          });
        }
      }
    }
  }
  // Weighted PRs first (sorted by 1RM desc), bodyweight PRs after (by total reps desc).
  const all = [...prs.values()];
  const weighted = all
    .filter((p): p is Extract<PR, { kind: "weighted" }> => p.kind === "weighted")
    .sort((a, b) => b.est1rm - a.est1rm);
  const bodyweight = all
    .filter((p): p is Extract<PR, { kind: "bodyweight" }> => p.kind === "bodyweight")
    .sort((a, b) => b.totalReps - a.totalReps);
  return [...weighted, ...bodyweight];
}

/** One trend point per session for `name`, oldest → newest.
 *  Weighted exercises: heaviest working set's est. 1RM (sessions with no
 *    weighted working set are skipped).
 *  Bodyweight exercises: total reps across bodyweight working sets that day.
 *  An exercise's history-wide `kind` (set in loadWorkouts) decides which path. */
export function buildExerciseTrend(
  workouts: WorkoutSession[],
  name: string,
): ExerciseTrendPoint[] {
  // Find the exercise's history-wide kind from the first session that contains it.
  // If the exercise doesn't appear in any session, return [].
  let kind: "weighted" | "bodyweight" | null = null;
  for (const w of workouts) {
    const ex = w.exercises.find((e) => e.name === name);
    if (ex) {
      kind = ex.kind;
      break;
    }
  }
  if (!kind) return [];

  const points: ExerciseTrendPoint[] = [];
  const sorted = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of sorted) {
    const ex = w.exercises.find((e) => e.name === name);
    if (!ex) continue;
    if (kind === "weighted") {
      const working = ex.sets.filter((s) => !s.warmup && s.kg && s.reps);
      if (!working.length) continue;
      const best = working.reduce((a, b) => (b.kg! > a.kg! ? b : a));
      points.push({
        kind: "weighted",
        date: w.date,
        kg: best.kg!,
        reps: best.reps!,
        est1rm: est1rm(best.kg!, best.reps!),
      });
    } else {
      let totalReps = 0;
      let bestSetReps = 0;
      for (const s of ex.sets) {
        if (s.warmup || s.kg || !s.reps) continue;
        totalReps += s.reps;
        if (s.reps > bestSetReps) bestSetReps = s.reps;
      }
      if (totalReps === 0) continue;
      points.push({ kind: "bodyweight", date: w.date, totalReps, bestSetReps });
    }
  }
  return points;
}
