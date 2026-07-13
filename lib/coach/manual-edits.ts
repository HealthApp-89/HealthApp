// lib/coach/manual-edits.ts
// Athlete-owned week-scope edit layer (migration 0051). Merges ABOVE
// session_prescriptions in both resolution chains, so engine repatches keep
// flowing to untouched exercises while manually edited entries hold.
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ManualSessionEdits, WeekdayLong } from "@/lib/data/types";

type DayEdits = NonNullable<ManualSessionEdits[WeekdayLong]>;

export function applyManualSessionEdits(
  exercises: PlannedExercise[],
  edits: DayEdits | null | undefined,
): { exercises: PlannedExercise[]; touched: boolean } {
  if (!edits || (!edits.order && !edits.exercises)) return { exercises, touched: false };
  let out = exercises.map((e) => ({ ...e }));
  let touched = false;

  const byName = new Map(out.map((e) => [e.name, e]));
  if (edits.exercises) {
    for (const [name, d] of Object.entries(edits.exercises)) {
      const ex = byName.get(name);
      if (!ex) continue;
      if (d.sets != null) { ex.sets = d.sets; touched = true; }
      if (d.kg != null) { ex.baseKg = d.kg; touched = true; }
      if (d.reps != null) { ex.baseReps = d.reps; touched = true; }
    }
  }
  if (edits.order && edits.order.length > 0) {
    const wanted = edits.order.filter((n) => byName.has(n));
    if (wanted.length === out.length) {
      out = wanted.map((n) => byName.get(n)!);
      touched = true;
    }
  }
  return { exercises: out, touched };
}
