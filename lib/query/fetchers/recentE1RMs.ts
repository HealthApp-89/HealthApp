// lib/query/fetchers/recentE1RMs.ts
//
// Computes top working-set e1RM per primary lift over the last 8 weeks of
// workouts. Used to pre-fill the /onboarding wizard's Training step with
// "current e1RM" values the user can review and confirm.
//
// e1RM formula: Epley — kg × (1 + reps / 30). Null when reps > 12 or for
// duration-based sets. Matches the convention used by lib/coach/tools.ts
// query_workouts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type RecentE1RMs = {
  squat: number | null;
  bench: number | null;
  deadlift: number | null;
  ohp: number | null;
  /** Sessions per week derived from last 4 weeks of workouts.count / 4. */
  sessions_per_week_estimate: number | null;
};

// OHP regex tightened to exclude bare "press" — avoids Leg Press false-positives.
// Lifters typically log overhead work as "Overhead Press", "OHP", "Military Press",
// or "Strict Press"; the bare word "press" is not worth matching.
const PRIMARY_LIFT_KEYWORDS: Record<keyof Omit<RecentE1RMs, "sessions_per_week_estimate">, RegExp> = {
  squat: /\b(back\s+squat|squat)\b/i,
  bench: /\b(bench\s+press|bench)\b/i,
  deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
  ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
};

const WORKOUTS_COLS =
  "id, date, exercises (name, sets:exercise_sets (kg, reps, warmup, duration_seconds))";

function epley(kg: number, reps: number): number | null {
  if (reps <= 0 || reps > 12) return null;
  return Math.round(kg * (1 + reps / 30));
}

function eightWeeksAgo(today: string): string {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 56);
  return t.toISOString().slice(0, 10);
}

function fourWeeksAgo(today: string): string {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 28);
  return t.toISOString().slice(0, 10);
}

type WorkoutRow = {
  id: string;
  date: string;
  exercises: Array<{
    name: string;
    sets: Array<{ kg: number | null; reps: number | null; warmup: boolean; duration_seconds: number | null }>;
  }>;
};

function computeFrom(rows: WorkoutRow[], today: string): RecentE1RMs {
  const eight = eightWeeksAgo(today);
  const four = fourWeeksAgo(today);

  const within8w = rows.filter((r) => r.date >= eight);
  const within4w = rows.filter((r) => r.date >= four);

  const out: RecentE1RMs = {
    squat: null, bench: null, deadlift: null, ohp: null,
    sessions_per_week_estimate: null,
  };

  for (const lift of ["squat", "bench", "deadlift", "ohp"] as const) {
    const re = PRIMARY_LIFT_KEYWORDS[lift];
    let best: number | null = null;
    for (const w of within8w) {
      for (const ex of w.exercises ?? []) {
        if (!re.test(ex.name)) continue;
        for (const s of ex.sets ?? []) {
          if (s.warmup) continue;
          if (s.kg === null || s.reps === null) continue;
          const e = epley(s.kg, s.reps);
          if (e !== null && (best === null || e > best)) best = e;
        }
      }
    }
    out[lift] = best;
  }

  if (within4w.length > 0) {
    out.sessions_per_week_estimate = Math.round((within4w.length / 4) * 10) / 10;
  }

  return out;
}

const recentE1RMs = createFetcher(
  async (supabase: SupabaseClient, userId: string, todayYYYYMMDD: string): Promise<RecentE1RMs> => {
    const since = eightWeeksAgo(todayYYYYMMDD);
    const { data, error } = await supabase
      .from("workouts")
      .select(WORKOUTS_COLS)
      .eq("user_id", userId)
      .gte("date", since)
      .order("date", { ascending: false });
    if (error) throw error;
    return computeFrom((data ?? []) as WorkoutRow[], todayYYYYMMDD);
  },
);

export const fetchRecentE1RMsServer = recentE1RMs.server;
export const fetchRecentE1RMsBrowser = recentE1RMs.browser;
