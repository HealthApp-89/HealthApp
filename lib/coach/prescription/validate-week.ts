// lib/coach/prescription/validate-week.ts
//
// Server-side validation called by propose_week_plan before signing the
// approval token. Hard-rejects with structured error + hint for any of
// the five discipline-enforcement rules.

import type {
  TrainingBlock,
  TrainingWeek,
  SessionPrescriptions,
  PrimaryLift,
  WeekdayLong,
} from "@/lib/data/types";
import { validatePatternConflicts, focusDayForBlock } from "@/lib/coach/prescription/pattern-conflict-overlay";
import { resolveExercise } from "@/lib/coach/exercise-library";

const FOCUS_CLAMP_MULTIPLIER = 0.92;

export type ValidationError =
  | { code: "off_grid_weight";                 message: string; hint: string }
  | { code: "consolidation_load_increase";     message: string; hint: string }
  | { code: "non_focus_primary_overcooked";    message: string; hint: string }
  | { code: "pattern_conflict";                message: string; hint: string; offending: Array<{ weekday: WeekdayLong; exercise: string }> };

const PRIMARY_LIFT_BY_KEY: Record<string, PrimaryLift> = {
  squat: "squat",
  decline_bench: "bench",
  incline_db: "bench",
  bench: "bench",
  deadlift: "deadlift",
  ohp: "ohp",
};

function inferPrimaryLiftFromKey(key: string | undefined): PrimaryLift | null {
  if (!key) return null;
  return PRIMARY_LIFT_BY_KEY[key] ?? null;
}

export function validateWeekPrescription(opts: {
  prescription: SessionPrescriptions;
  block: TrainingBlock | null;
  week: TrainingWeek;
  prevWeek: TrainingWeek | null;
  /** current working kg per primary lift — comes from prescribeWeek's maintenanceLoadFor lookup */
  maintenanceBaselines: Partial<Record<PrimaryLift, number>>;
}): ValidationError | null {

  // 1. off_grid_weight — every prescribed exercise with a baseKg must sit on the equipment grid
  for (const [weekdayStr, exercises] of Object.entries(opts.prescription)) {
    const weekday = weekdayStr as WeekdayLong;
    if (!exercises) continue;
    for (const ex of exercises) {
      if (ex.baseKg == null) continue;
      const lib = resolveExercise(ex.name);
      if (!lib || !lib.increment) continue; // bodyweight / library gap — skip
      const step = lib.increment.step;
      const inter = lib.increment.intermediate;
      const onPrimary = Math.abs((ex.baseKg / step) - Math.round(ex.baseKg / step)) < 1e-6;
      const onInter =
        inter != null &&
        ex.baseKg >= inter &&
        Math.abs(((ex.baseKg - inter) / step) - Math.round((ex.baseKg - inter) / step)) < 1e-6;
      if (!(onPrimary || onInter)) {
        return {
          code: "off_grid_weight",
          message: `${ex.name} (${weekday}): ${ex.baseKg} kg is not on the equipment grid (step ${step} kg${inter != null ? `, intermediate ${inter} kg` : ""}).`,
          hint: `Use a valid load and re-propose.`,
        };
      }
    }
  }

  // 2. consolidation_load_increase — primary lift can't increase load once target_hit_at_week is set
  if (
    opts.block?.target_hit_at_week != null &&
    opts.block.primary_lift != null &&
    opts.prevWeek != null
  ) {
    const focusDay = focusDayForBlock(opts.block, opts.week);
    if (focusDay) {
      const proposed = opts.prescription[focusDay]?.find((e) => e.key === opts.block!.primary_lift);
      const prev = (opts.prevWeek.session_prescriptions as SessionPrescriptions | null)?.[focusDay]?.find(
        (e) => e.key === opts.block!.primary_lift,
      );
      if (proposed?.baseKg != null && prev?.baseKg != null && proposed.baseKg > prev.baseKg) {
        return {
          code: "consolidation_load_increase",
          message: `${opts.block.primary_lift}: block is in consolidation (target hit week ${opts.block.target_hit_at_week}); load cannot increase from ${prev.baseKg} → ${proposed.baseKg} kg.`,
          hint: `Hold the load. Progress reps or sets instead. To raise loads, close this block and start a new one.`,
        };
      }
    }
  }

  // 3. non-focus primary load check — applies during a focus block, weeks 1-4.
  // (Volume-too-high check removed 2026-06-06; load discipline via the 0.92×
  // maintenance clamp is sufficient, the per-set drop detrained patterns.)
  if (opts.block?.primary_lift != null && opts.week.research_phase !== "deload") {
    for (const [weekdayStr, exercises] of Object.entries(opts.prescription)) {
      const weekday = weekdayStr as WeekdayLong;
      if (!exercises) continue;
      for (const ex of exercises) {
        const liftKey = inferPrimaryLiftFromKey(ex.key);
        if (liftKey == null) continue;
        if (liftKey === opts.block.primary_lift) continue;

        const baseline = opts.maintenanceBaselines[liftKey];
        if (baseline != null && ex.baseKg != null) {
          const ceiling = baseline * FOCUS_CLAMP_MULTIPLIER;
          if (ex.baseKg > ceiling) {
            return {
              code: "non_focus_primary_overcooked",
              message: `${ex.name} (${weekday}): ${ex.baseKg} kg exceeds the focus-block maintenance ceiling of ${ceiling.toFixed(1)} kg (0.92 × current working ${baseline.toFixed(1)} kg).`,
              hint: `Drop the load to ≤ ${ceiling.toFixed(1)} kg. The ${opts.block.primary_lift} focus block requires reduced secondaries.`,
            };
          }
        }
      }
    }
  }

  // 5. pattern_conflict — axial hinge on non-focus day during deadlift focus block
  if (opts.block != null) {
    const patternErr = validatePatternConflicts(opts.prescription, opts.block, opts.week);
    if (patternErr) return patternErr;
  }

  return null;
}
