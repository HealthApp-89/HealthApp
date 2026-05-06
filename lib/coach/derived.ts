// lib/coach/derived.ts
//
// Pure helpers for the coach tool layer. No DB access, no Supabase client —
// inputs are typed values, outputs are typed values. Keep this side-effect-
// free so it's trivial to reason about and to unit-test (when we add a test
// harness).
//
// Why a separate `epley` from lib/ui/score.ts:est1rm: the existing helper
// returns 0 for missing/zero inputs and rounds to int. The tool layer needs
// `null` semantics (so the model sees "missing" not "zero") and unrounded
// floats (so cumulative comparisons don't drift).

export type SetRow = {
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  warmup: boolean;
  failure: boolean;
};

/** Epley one-rep-max estimate. Returns null when reps is out of the
 *  reliable range (<=0 or >12) or kg/reps is missing. */
export function epley(kg: number | null, reps: number | null): number | null {
  if (kg === null || reps === null) return null;
  if (reps <= 0 || reps > 12) return null;
  if (kg <= 0) return null;
  if (reps === 1) return kg;
  return Math.round(kg * (1 + reps / 30) * 10) / 10; // 1-decimal precision
}

/** Sum of (kg × reps) over the working sets only. Warmups excluded.
 *  Duration-based sets (kg or reps null) contribute zero. */
export function workingVolume(sets: SetRow[]): number {
  let v = 0;
  for (const s of sets) {
    if (s.warmup) continue;
    if (s.kg === null || s.reps === null) continue;
    v += s.kg * s.reps;
  }
  return Math.round(v);
}

/** Working sets count (warmups excluded). */
export function workingSetCount(sets: SetRow[]): number {
  let n = 0;
  for (const s of sets) if (!s.warmup) n++;
  return n;
}

/** Sets flagged failure: true (working sets only). */
export function hardSetCount(sets: SetRow[]): number {
  let n = 0;
  for (const s of sets) if (!s.warmup && s.failure) n++;
  return n;
}

/** Pick the "top set" for an exercise within a workout: highest e1RM among
 *  working sets; tie-broken by higher kg. For duration-based exercises with
 *  no e1RM, fall back to the longest duration_seconds. Returns null if no
 *  working sets at all. */
export function topSet(sets: SetRow[]):
  | { kg: number | null; reps: number | null; duration_seconds: number | null; e1RM: number | null }
  | null {
  const working = sets.filter((s) => !s.warmup);
  if (working.length === 0) return null;

  // Path 1: weighted sets with e1RM.
  const withE1rm = working
    .map((s) => ({ s, e: epley(s.kg, s.reps) }))
    .filter((x) => x.e !== null) as { s: SetRow; e: number }[];
  if (withE1rm.length > 0) {
    withE1rm.sort((a, b) => {
      if (b.e !== a.e) return b.e - a.e;
      return (b.s.kg ?? 0) - (a.s.kg ?? 0);
    });
    const best = withE1rm[0];
    return {
      kg: best.s.kg,
      reps: best.s.reps,
      duration_seconds: best.s.duration_seconds,
      e1RM: best.e,
    };
  }

  // Path 2: weighted but reps>12 (e1RM null) — pick highest kg, then highest reps.
  const weighted = working.filter((s) => s.kg !== null && s.reps !== null);
  if (weighted.length > 0) {
    weighted.sort((a, b) => {
      const dk = (b.kg ?? 0) - (a.kg ?? 0);
      if (dk !== 0) return dk;
      return (b.reps ?? 0) - (a.reps ?? 0);
    });
    const best = weighted[0];
    return {
      kg: best.kg,
      reps: best.reps,
      duration_seconds: best.duration_seconds,
      e1RM: null,
    };
  }

  // Path 3: duration-based — longest duration wins.
  const duration = working.filter((s) => s.duration_seconds !== null);
  if (duration.length > 0) {
    duration.sort((a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0));
    const best = duration[0];
    return {
      kg: best.kg,
      reps: best.reps,
      duration_seconds: best.duration_seconds,
      e1RM: null,
    };
  }

  return null;
}

/** ISO-week start (Monday, UTC). YYYY-MM-DD in / YYYY-MM-DD out. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  // getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat. Monday → 0 offset, Sunday → 6.
  const dow = d.getUTCDay();
  const offset = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Calendar month start. YYYY-MM-DD in / YYYY-MM-DD (the 01) out. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}
