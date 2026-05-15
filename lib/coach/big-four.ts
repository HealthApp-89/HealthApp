// lib/coach/big-four.ts
//
// Canonical big-four lift names. The morning brief, the weekly review
// composer, and the analytical block all need to identify these four
// lifts; defining them in one place keeps the lists in sync if a name
// ever shifts (e.g. Strong CSV export naming changes).

export const BIG_FOUR = [
  "Squat (Barbell)",
  "Deadlift (Barbell)",
  "Decline Bench Press (Barbell)",
  "Overhead Press (Barbell)",
] as const;

export const BIG_FOUR_SET: ReadonlySet<string> = new Set<string>(BIG_FOUR);
