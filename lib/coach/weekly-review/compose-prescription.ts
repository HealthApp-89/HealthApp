// lib/coach/weekly-review/compose-prescription.ts
//
// §5 of the weekly review. Deterministic per-lift load progression with
// all rule overrides, priority order, and physical-loading guardrails.
//
// Full rule semantics defined in:
//   docs/superpowers/specs/2026-05-15-weekly-review-document-design.md
//   → "Per-lift progression rules"
//
// Rule priority (first match wins for the load delta; pr_rebase composes):
//   1. block_start        — first week of block; use intake starting loads
//   2. cutting_hold       — body-weight loss > 0.7%/wk
//   3. recovery_hold      — sleep avg < 6 h OR HRV flag
//   4. plateau_deload_reset — e1RM flat 3 wks AND rep-shift already tried
//   5. plateau_rep_shift  — e1RM flat 3 wks AND no rep-shift yet
//   6. rep_completion_miss — reps_completed_pct < 90%
//   7. rir_missed_twice   — rir_miss_consecutive >= 2 (hold + reconfirm chip)
//   8. rir_missed         — rir_target_met === false (single miss)
//   9. form_hold          — any form note this week
//   (composable) pr_rebase — new e1RM all-time high; never overrides load rule
//
// Otherwise: phase-mapped default step (per-lift table — Squat/Bench 2.5/1.5,
// Deadlift 2/1, OHP 1.5/hold). MRV current → +1 set, hold load. Deload next →
// load × 0.875 and sets × 0.55.
//
// All paths funnel through mkPlan() which:
//   - clamps raw target delta to ±4%
//   - rounds via roundToValidWeight()
//   - if post-rounding |Δ| > 4% → force-hold + `_increment_capped` suffix
//   - if resolved === lastKg but rule asked for a non-zero step → `_increment_floor`
//     suffix (skipped for legitimate-hold rules)

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  WeeklyReviewPayload,
  WeeklyPhase,
  PrescriptionRationaleTag,
} from "@/lib/data/types";
import { SESSION_PLANS, WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import {
  roundToValidWeight,
  type IncrementConfig,
} from "@/lib/coach/weight-rounding";

type PrescriptionOutput = WeeklyReviewPayload["prescription"];
type LiftRecap = WeeklyReviewPayload["recap"]["per_lift"][number];
type LiftPlan = PrescriptionOutput["per_lift"][number];

type Inputs = {
  // supabase + userId reserved for future history reads (e.g. plateau_rep_shift
  // tracking from prior weekly_reviews rows). Unused in current rule set —
  // hasRecentRepShift defaults to false; orchestrator can augment recap if
  // history-aware behavior is needed.
  supabase: SupabaseClient;
  userId: string;
  nextWeekStart: string;
  weeklyPhaseCurrent: WeeklyPhase;
  weeklyPhaseNext: WeeklyPhase;
  rirTargetCurrent: number | null;
  rirTargetNext: number | null;
  perLiftRecap: LiftRecap[];
  bodyWeightLossPctPerWk: number | null; // negative for loss
  sleepAvg7d: number | null;
  hrvFlag: boolean;
  isFirstWeekOfBlock: boolean;
  intakeStartingLoads: Record<string, number> | null;
  weeklyFocus: string | null;
};

/** Per-lift default phase-step table. Targets are PERCENT, resolved
 *  through `roundToValidWeight()` against the exercise's increment config. */
const LIFT_STEP_TABLE: Record<string, { mevToMav: number; mavToMrv: number }> = {
  "Squat (Barbell)":              { mevToMav: 0.025, mavToMrv: 0.015 },
  "Decline Bench Press (Barbell)": { mevToMav: 0.025, mavToMrv: 0.015 },
  "Deadlift (Barbell)":           { mevToMav: 0.020, mavToMrv: 0.010 },
  "Overhead Press (Barbell)":     { mevToMav: 0.015, mavToMrv: 0 }, // hold; rep progression
};

const HARD_CAP_PCT = 0.04;

/** Rules where the prescribed action is legitimately "hold load" — the
 *  `_increment_floor` suffix would be noise on these. */
const LEGITIMATE_HOLD_TAGS: ReadonlySet<PrescriptionRationaleTag> = new Set<PrescriptionRationaleTag>([
  "cutting_hold",
  "recovery_hold",
  "form_hold",
  "rir_missed_twice",
  "mrv_volume_drive",
  "plateau_rep_shift",
]);

export async function composePrescription(args: Inputs): Promise<PrescriptionOutput> {
  const perLift: LiftPlan[] = args.perLiftRecap.map((lift) => resolveOneLift(lift, args));

  // Baseline weekly schedule. The orchestrator may swap to a recent custom
  // schedule from `training_weeks`; here we emit the canonical WEEKLY_SESSIONS.
  // Note: WEEKLY_SESSIONS is keyed by long-form day names (Monday, …); the
  // payload type is `Record<string, string>` so this is loose by design.
  const sessionPlan: Record<string, string> = { ...WEEKLY_SESSIONS };

  return {
    next_week_start: args.nextWeekStart,
    phase: args.weeklyPhaseNext,
    rir_target: args.rirTargetNext,
    session_plan: sessionPlan,
    weekly_focus: args.weeklyFocus,
    per_lift: perLift,
  };
}

// ── per-lift resolution ────────────────────────────────────────────────────

function resolveOneLift(recap: LiftRecap, args: Inputs): LiftPlan {
  const lift = recap.lift;
  const lastWeight = recap.top_set.weight_kg;
  const lastReps = recap.top_set.reps;
  const sets = recap.top_set.sets;
  const incr = getIncrementConfig(lift);

  // Compose pr_rebase flag — always evaluated, never overrides load rule.
  const prRebase = isNewPR(recap);

  // Priority 1: first week of block — use intake starting loads if present.
  if (args.isFirstWeekOfBlock) {
    const startKg = args.intakeStartingLoads?.[lift] ?? lastWeight;
    return mkPlan({
      lift,
      sets,
      reps: lastReps,
      targetKg: startKg,
      lastKg: lastWeight,
      prRebase,
      rationale: "block_start_baseline",
      incrCfg: incr,
    });
  }

  // Priority 2: cutting_hold — body-weight loss > 0.7%/wk (bodyWeightLossPctPerWk
  // is negative for loss, so a loss steeper than -0.7% is < -0.007).
  if (
    args.bodyWeightLossPctPerWk != null &&
    args.bodyWeightLossPctPerWk < -0.007
  ) {
    return mkPlan({
      lift, sets, reps: lastReps,
      targetKg: lastWeight, lastKg: lastWeight,
      prRebase, rationale: "cutting_hold", incrCfg: incr,
    });
  }

  // Priority 3: recovery_hold — sleep avg < 6h OR HRV flag.
  if ((args.sleepAvg7d != null && args.sleepAvg7d < 6) || args.hrvFlag) {
    return mkPlan({
      lift, sets, reps: lastReps,
      targetKg: lastWeight, lastKg: lastWeight,
      prRebase, rationale: "recovery_hold", incrCfg: incr,
    });
  }

  // Priorities 4 / 5: plateau handling. Spec prefers deload_reset when a
  // rep-shift has already been attempted; otherwise rep-shift first.
  if (isPlateau(recap)) {
    const repShiftAlready = hasRecentRepShift(recap);
    if (repShiftAlready) {
      const target = lastWeight * 0.95; // -5% (within ±4% cap, will clamp to -4%)
      return mkPlan({
        lift, sets, reps: lastReps,
        targetKg: target, lastKg: lastWeight,
        prRebase, rationale: "plateau_deload_reset", incrCfg: incr,
      });
    }
    const newReps = swapRepRange(lastReps);
    return mkPlan({
      lift, sets, reps: newReps,
      targetKg: lastWeight, lastKg: lastWeight,
      prRebase, rationale: "plateau_rep_shift", incrCfg: incr,
    });
  }

  // Priority 6: rep_completion_miss — <90% of programmed reps cleared.
  if (recap.reps_completed_pct != null && recap.reps_completed_pct < 0.9) {
    const target = lastWeight * (1 - 0.025);
    return mkPlan({
      lift, sets, reps: lastReps,
      targetKg: target, lastKg: lastWeight,
      prRebase, rationale: "rep_completion_miss", incrCfg: incr,
    });
  }

  // Priority 7: rir_missed_twice — two consecutive misses → hold + reconfirm.
  if (recap.rir_miss_consecutive >= 2) {
    return mkPlan({
      lift, sets, reps: lastReps,
      targetKg: lastWeight, lastKg: lastWeight,
      prRebase, rationale: "rir_missed_twice", incrCfg: incr,
    });
  }

  // Priority 8: rir_missed — single miss. `rir_target_met` from MVP recap is
  // often `null` (orchestrator finalizes); we explicitly require `=== false`
  // so a `null` value will NOT fire this rule — conservative default.
  if (recap.rir_target_met === false) {
    const target = lastWeight * (1 - 0.025);
    return mkPlan({
      lift, sets, reps: lastReps,
      targetKg: target, lastKg: lastWeight,
      prRebase, rationale: "rir_missed", incrCfg: incr,
    });
  }

  // Priority 9: form_hold — any form note this week.
  if (recap.form_notes.length > 0) {
    return mkPlan({
      lift, sets, reps: lastReps,
      targetKg: lastWeight, lastKg: lastWeight,
      prRebase, rationale: "form_hold", incrCfg: incr,
    });
  }

  // No override fired → phase-mapped default cadence.

  // MRV current week → volume drive, not load (hold + 1 set). Spec row 3
  // of phase-mapping table: "Auto-trigger; phase advance not optional".
  if (args.weeklyPhaseCurrent === "mrv") {
    const bumpedSets = sets + 1;
    return mkPlan({
      lift, sets: bumpedSets, reps: lastReps,
      targetKg: lastWeight, lastKg: lastWeight,
      prRebase, rationale: "mrv_volume_drive", incrCfg: incr,
    });
  }

  // Deload next week → load × 0.875 (midpoint -10..-15%) AND sets × 0.55
  // (midpoint of 55%-60% retained = ~-40..-50% sets). Both knobs.
  if (args.weeklyPhaseNext === "deload") {
    const deloadTarget = lastWeight * (1 - 0.125);
    const deloadSets = Math.max(1, Math.round(sets * 0.55));
    return mkPlan({
      lift, sets: deloadSets, reps: lastReps,
      targetKg: deloadTarget, lastKg: lastWeight,
      prRebase, rationale: "deload_load_volume_cut", incrCfg: incr,
    });
  }

  // Default phase-mapped step from the per-lift table.
  const step = phaseStepFor(lift, args.weeklyPhaseCurrent, args.weeklyPhaseNext);
  const tag: PrescriptionRationaleTag = pickPhaseTag(args.weeklyPhaseCurrent, args.weeklyPhaseNext);
  const target = lastWeight * (1 + step);

  return mkPlan({
    lift, sets, reps: lastReps,
    targetKg: target, lastKg: lastWeight,
    prRebase, rationale: tag, incrCfg: incr,
  });
}

// ── plan construction with rounding + guardrails ───────────────────────────

type MkPlanArgs = {
  lift: string;
  sets: number;
  reps: number;
  targetKg: number;
  lastKg: number;
  prRebase: boolean;
  rationale: PrescriptionRationaleTag;
  incrCfg: IncrementConfig;
};

function mkPlan(args: MkPlanArgs): LiftPlan {
  const { lift, sets, reps, targetKg, lastKg, prRebase, rationale, incrCfg } = args;

  // ±4% cap on the raw target before rounding (spec hard guardrail #1).
  const rawDeltaPct = lastKg > 0 ? (targetKg - lastKg) / lastKg : 0;
  const cappedDeltaPct = Math.max(-HARD_CAP_PCT, Math.min(HARD_CAP_PCT, rawDeltaPct));
  const cappedTarget = lastKg * (1 + cappedDeltaPct);

  const resolved = roundToValidWeight(cappedTarget, incrCfg);
  const actualDeltaPct = lastKg > 0 ? (resolved - lastKg) / lastKg : 0;

  let finalKg = resolved;
  let finalTag: PrescriptionRationaleTag = rationale;

  // Post-rounding cap check: rounding up can push past the 4% cap when the
  // smallest increment is coarse relative to lastKg (e.g. OHP at 30 kg with
  // step=5 → smallest jump is +16.7%). Force-hold and surface via suffix.
  if (Math.abs(actualDeltaPct) > HARD_CAP_PCT) {
    finalKg = lastKg;
    finalTag = `${rationale}_increment_capped` as PrescriptionRationaleTag;
  } else if (
    resolved === lastKg &&
    Math.abs(rawDeltaPct) > 0.001 &&
    !LEGITIMATE_HOLD_TAGS.has(rationale)
  ) {
    // The rule asked for a non-trivial step, but rounding to a loadable value
    // landed back on lastKg. Surface so the narrative composer can explain.
    finalTag = `${rationale}_increment_floor` as PrescriptionRationaleTag;
  }

  return {
    lift,
    sets,
    reps,
    weight_kg: finalKg,
    delta_pct_from_last_week: lastKg > 0 ? (finalKg - lastKg) / lastKg : null,
    pr_rebase_applied: prRebase,
    rationale_tag: finalTag,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Look up the exercise's `increment` config by scanning all session plans
 *  for a matching `name`. Fallback chain:
 *    1. matching `name` in any SESSION_PLANS session with `increment` defined
 *    2. dumbbell archetype (name contains "(Dumbbell)") → { step: 2 }
 *    3. barbell default → { step: 2.5 }
 *
 *  Per spec ("Missing increment config"): default {step:2.5} for barbells,
 *  {step:2} for dumbbells. Plan stage adds explicit SESSION_PLANS coverage
 *  for any uncovered big-four lift; we don't warn here (out of scope). */
function getIncrementConfig(lift: string): IncrementConfig {
  for (const session of Object.values(SESSION_PLANS)) {
    const found = session.find((e) => e.name === lift);
    if (found?.increment) return found.increment;
  }
  if (lift.toLowerCase().includes("(dumbbell)")) return { step: 2 };
  return { step: 2.5 };
}

/** Per-lift phase-step from LIFT_STEP_TABLE. Unknown lifts default to 1.5%
 *  (conservative — matches OHP's MEV→MAV target). */
function phaseStepFor(lift: string, current: WeeklyPhase, next: WeeklyPhase): number {
  const t = LIFT_STEP_TABLE[lift];
  if (!t) return 0.015;
  if (current === "mev" && next === "mav") return t.mevToMav;
  if (current === "mav" && next === "mav") return t.mevToMav * 0.6; // mid-MAV step
  if (current === "mav" && next === "mrv") return t.mavToMrv;
  // mrv current + deload-next handled in resolveOneLift before falling here.
  return 0;
}

function pickPhaseTag(current: WeeklyPhase, next: WeeklyPhase): PrescriptionRationaleTag {
  if (current === "mev" && next === "mav") return "mev_to_mav_clearance";
  if (current === "mav" && next === "mav") return "mav_to_mav_step";
  if (current === "mav" && next === "mrv") return "mav_to_mrv_advance";
  if (current === "mrv" && next === "deload") return "deload_load_volume_cut";
  return "mev_to_mav_clearance";
}

/** New PR iff current e1RM strictly exceeds the prior weeks' max. Composes
 *  with the load rule but never overrides it (spec line 376/389). */
function isNewPR(recap: LiftRecap): boolean {
  if (recap.e1rm_kg == null || recap.e1rm_history_3wk.length === 0) return false;
  // History includes the current week as the last entry; prior max is everything
  // up to but not including it.
  const prior = recap.e1rm_history_3wk.slice(0, -1);
  if (prior.length === 0) return false;
  const priorMax = Math.max(...prior);
  return recap.e1rm_kg > priorMax;
}

/** Plateau: 3 consecutive weeks of e1RM, Δ ≤ 1.5% across the window. */
function isPlateau(recap: LiftRecap): boolean {
  if (recap.e1rm_history_3wk.length < 3) return false;
  const xs = recap.e1rm_history_3wk;
  const max = Math.max(...xs);
  const min = Math.min(...xs);
  return max > 0 && (max - min) / max <= 0.015;
}

/** Conservative default: assume no prior rep-shift attempt. Surfacing rep-shift
 *  history requires the orchestrator to read prior `weekly_reviews` rows and
 *  augment the recap; this composer stays decoupled from that I/O. Effect:
 *  on first plateau detection we'll always try `plateau_rep_shift` first,
 *  which matches spec preference (rep-shift before deload-reset). */
function hasRecentRepShift(_recap: LiftRecap): boolean {
  return false;
}

/** Swap rep range to break a plateau: heavy (≤5) → moderate (8); moderate
 *  (6-8) → heavy (5); anything higher → heavy (5). */
function swapRepRange(reps: number): number {
  if (reps <= 5) return 8;
  if (reps <= 8) return 5;
  return 5;
}
