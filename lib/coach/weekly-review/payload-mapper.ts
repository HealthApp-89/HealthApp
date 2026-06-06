// lib/coach/weekly-review/payload-mapper.ts
//
// Converts the canonical SessionPrescriptions shape (per-weekday PlannedExercise[])
// into the WeeklyReviewPayload.prescription shape (per-lift summary array).
//
// Selection rule: for each lift we want to report, pick the first non-warmup
// entry across all weekdays whose name matches the lift's canonical name set.
// "First" by weekday order (Monday → Sunday) — matches how athletes encounter
// the prescription in the week.

import type { SessionPrescriptions, WeeklyReviewPayload } from "@/lib/data/types";
import type { BlockPhase } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import { deriveRationaleTag } from "@/lib/coach/weekly-review/rationale-tags";

type LiftRecap = WeeklyReviewPayload["recap"]["per_lift"][number];
type LiftPlan = WeeklyReviewPayload["prescription"]["per_lift"][number];

export function buildPerLiftFromEngine(opts: {
  prescription: SessionPrescriptions;
  perLiftRecap: LiftRecap[];
  blockPhase: BlockPhase;
}): LiftPlan[] {
  const { prescription, perLiftRecap, blockPhase } = opts;
  const out: LiftPlan[] = [];

  for (const recap of perLiftRecap) {
    const engineEntry = findFirstByName(prescription, recap.lift);
    if (!engineEntry) continue; // lift not prescribed next week (rotation gap)

    const prescribedKg = engineEntry.baseKg ?? 0;
    const prescribedReps = engineEntry.baseReps ?? recap.top_set.reps;
    const prescribedSets = engineEntry.sets ?? recap.top_set.sets;
    const lastKg = recap.top_set.weight_kg;

    const tag = deriveRationaleTag({
      blockPhase,
      prescribedKg,
      prescribedReps,
      prescribedSets,
      lastWeekKg: lastKg,
      lastWeekReps: recap.top_set.reps,
      lastWeekSets: recap.top_set.sets,
    });

    out.push({
      lift: recap.lift,
      sets: prescribedSets,
      reps: prescribedReps,
      weight_kg: prescribedKg,
      delta_pct_from_last_week: lastKg > 0 ? (prescribedKg - lastKg) / lastKg : null,
      pr_rebase_applied: isNewPR(recap),
      rationale_tag: tag,
    });
  }

  return out;
}

function findFirstByName(
  prescription: SessionPrescriptions,
  liftName: string,
): PlannedExercise | null {
  for (const weekday of WEEKDAY_LONG_ORDER) {
    const exercises = prescription[weekday];
    if (!exercises) continue;
    const match = exercises.find(
      (e) => !e.warmup && e.name.toLowerCase() === liftName.toLowerCase(),
    );
    if (match) return match;
  }
  return null;
}

function isNewPR(recap: LiftRecap): boolean {
  if (recap.e1rm_kg == null || recap.e1rm_history_3wk.length === 0) return false;
  const prior = recap.e1rm_history_3wk.slice(0, -1);
  if (prior.length === 0) return false;
  return recap.e1rm_kg > Math.max(...prior);
}
