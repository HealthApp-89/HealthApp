// lib/coach/big-four.ts
//
// Canonical big-four lift names. The morning brief, the weekly review
// composer, and the analytical block all need to identify these four
// lifts; defining them in one place keeps the lists in sync if a name
// ever shifts (e.g. Strong CSV export naming changes).
//
// CONTRACT: these strings must match the `exercises.name` values written
// by the workout-ingest paths (currently /api/ingest/strong and the
// HealthKit Strong stub). If Strong's CSV export ever changes lift
// naming, update this file FIRST — the analytical brief and weekly
// review's per-lift comparison silently produce zero-completion data
// when the lookup misses.

export const BIG_FOUR = [
  "Squat (Barbell)",
  "Deadlift (Barbell)",
  "Decline Bench Press (Barbell)",
  "Overhead Press (Barbell)",
] as const;

export const BIG_FOUR_SET: ReadonlySet<string> = new Set<string>(BIG_FOUR);
