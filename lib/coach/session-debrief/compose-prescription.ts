// lib/coach/session-debrief/compose-prescription.ts
//
// Rule-based weight prescription for the next session of the same type.
// No AI — the narrative-prompt paraphrases these rules in coach voice, but
// the values themselves are deterministic so the math stays auditable.
//
// Rules per lift (uses the tag computed by compose-lifts):
//   PR        → propose +increment.step  ("you earned the bump")
//   stall     → hold weight, target prescribed RIR
//   regression → propose -increment.step
//   null      → no change (first-time exercise, no comparison data)
//
// Volume note (from compose-volume status):
//   over_mrv          → notes.push("Drop a set on <muscle> next session")
//   approaching_mrv   → notes.push("Cap volume on <muscle> next session")
//   below_mev (>1 muscle) → notes.push("Volume is light on <muscles>; check session adherence")

import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";
import type { TrainingBlock, PrimaryLift } from "@/lib/data/types";
import {
  evaluateBlockPhase,
  prescribePrimaryFromPhase,
} from "@/lib/coach/prescription/block-phase-rule";

/** Exercise-name patterns identifying a primary-lift instance.
 *  Mirrors target-hit-evaluator.ts so the block-phase rule fires on the
 *  same set of exercises end-to-end. */
const PRIMARY_LIFT_NAME_PATTERNS: Record<PrimaryLift, string[]> = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

function liftFromExerciseName(name: string): PrimaryLift | null {
  const lower = name.toLowerCase();
  for (const [lift, patterns] of Object.entries(PRIMARY_LIFT_NAME_PATTERNS) as Array<[PrimaryLift, string[]]>) {
    if (patterns.some((p) => p.toLowerCase() === lower)) return lift;
  }
  return null;
}

type ComposePrescriptionInput = {
  sessionType: string;
  lifts: WorkoutDebriefPayload["lifts"];
  volume: WorkoutDebriefPayload["volume"];
  todayExercises: Array<{ name: string }>;
  block: TrainingBlock | null;
  todayIso: string;
};

export function composePrescription(
  input: ComposePrescriptionInput,
): WorkoutDebriefPayload["prescription"] {
  const { sessionType, lifts, volume } = input;
  const planEntries = SESSION_PLANS[sessionType] ?? [];

  const weight_changes: WorkoutDebriefPayload["prescription"]["weight_changes"] = [];

  for (const lift of lifts) {
    const planEntry = planEntries.find((p) => p.name.toLowerCase() === lift.name.toLowerCase());
    const step = planEntry?.increment?.step ?? 2.5; // default 2.5kg if no plan entry

    // ── Block-phase rule short-circuit for the block's primary (focus) lift ──
    // The framework is authoritative for the focus lift — it overrides the
    // naive PR/stall/regression → +step / hold / -step logic because the
    // framework decides progression based on the block target + remaining
    // weeks, not just last-session delta.
    const liftKey = liftFromExerciseName(lift.name);
    const isBlockFocusLift =
      input.block != null &&
      input.block.primary_lift != null &&
      liftKey === input.block.primary_lift;

    if (isBlockFocusLift && input.block != null) {
      const phase = evaluateBlockPhase({
        block: input.block,
        currentWorkingKg: lift.top_set_today.kg ?? null,
        // We don't compute a precise recent rate here — pass null so the
        // function still classifies off_pace based on remaining weeks vs
        // target via its required-rate check (the rate-comparison branch
        // is bypassed when rate is null, but the deload-week + consolidation
        // discriminators still fire correctly).
        recentProgressionRatePerWeek: null,
        todayIso: input.todayIso,
      });
      const baseExercise = planEntry ?? { name: lift.name, increment: { step } };
      const prescribed = prescribePrimaryFromPhase({
        baseExercise: baseExercise as Parameters<typeof prescribePrimaryFromPhase>[0]["baseExercise"],
        phase,
        currentWorkingKg: lift.top_set_today.kg ?? 0,
        lastWeekHitRirTargetCleanly: lift.tag === "PR", // PR tag = clean overshoot
        rirTarget: 2, // placeholder; doesn't influence kg in this rule
        baselineSets: planEntry?.sets ?? 3,
        baselineReps: planEntry?.baseReps ?? 6,
      });

      let rationale: string;
      switch (phase) {
        case "consolidation":
          rationale = `Block target ${input.block.target_value} kg was hit at week ${input.block.target_hit_at_week}. Consolidation phase: hold ${prescribed.baseKg} kg, progress reps to ${prescribed.baseReps}. We do NOT push load further this block.`;
          break;
        case "off_pace": {
          const wLeft = weeksLeft(input.block, input.todayIso);
          const requiredRate = ((input.block.target_value ?? 0) - (lift.top_set_today.kg ?? 0)) / Math.max(1, wLeft);
          rationale = `Block target ${input.block.target_value} kg is out of reach in remaining accumulation weeks (would require +${requiredRate.toFixed(1)} kg/wk vs normal +${step} kg). HOLD ${prescribed.baseKg} kg and accept — we renegotiate the target next block, not in mid-block.`;
          break;
        }
        case "deload_week":
          rationale = `Deload week — drop to ${prescribed.baseKg} kg (~0.80×) with halved sets.`;
          break;
        case "pre_target":
          if ((prescribed.baseKg ?? 0) > (lift.top_set_today.kg ?? 0)) {
            rationale = `On pace for the block target. Take the +${step} kg next session: ${prescribed.baseKg} kg.`;
          } else {
            rationale = `Hold ${prescribed.baseKg} kg — last session didn't meet the prescribed RIR cleanly.`;
          }
          break;
      }

      weight_changes.push({
        exercise: lift.name,
        new_kg: prescribed.baseKg ?? lift.top_set_today.kg ?? 0,
        rationale,
      });
      continue; // skip the naive logic for this lift
    }

    if (lift.tag == null) continue;

    const todayKg = lift.top_set_today.kg;
    if (todayKg == null) continue;

    if (lift.tag === "PR") {
      weight_changes.push({
        exercise: lift.name,
        new_kg: Math.round((todayKg + step) * 4) / 4, // round to 0.25kg
        rationale: `PR (+${lift.delta_e1rm?.toFixed(1) ?? "?"}kg e1RM) — take the +${step}kg next session.`,
      });
    } else if (lift.tag === "regression") {
      weight_changes.push({
        exercise: lift.name,
        new_kg: Math.max(0, Math.round((todayKg - step) * 4) / 4),
        rationale: `Regressed vs last session — drop ${step}kg and rebuild.`,
      });
    } else if (lift.tag === "stall") {
      weight_changes.push({
        exercise: lift.name,
        new_kg: todayKg,
        rationale: `Stalled at this load — hold ${todayKg}kg, target prescribed RIR cleanly before bumping.`,
      });
    }
  }

  const notes: string[] = [];
  const over = volume.filter((v) => v.status === "over_mrv");
  const near = volume.filter((v) => v.status === "approaching_mrv");
  const low = volume.filter((v) => v.status === "below_mev");

  if (over.length > 0) {
    notes.push(`Drop a set on ${over.map((v) => v.muscle).join(", ")} next session — over MRV.`);
  } else if (near.length > 0) {
    notes.push(`Cap volume on ${near.map((v) => v.muscle).join(", ")} next session — approaching MRV.`);
  }
  if (low.length >= 2) {
    notes.push(`Volume is light on ${low.map((v) => v.muscle).join(", ")} this week — check session adherence.`);
  }

  return {
    next_session_date: null, // populated by orchestrator from training_weeks
    weight_changes,
    notes,
  };
}

function weeksLeft(block: TrainingBlock, todayIso: string): number {
  const today = new Date(todayIso + "T00:00:00Z").getTime();
  const end = new Date(block.end_date + "T00:00:00Z").getTime();
  return Math.max(1, Math.round((end - today) / (7 * 24 * 60 * 60 * 1000)));
}
