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

import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";
import type { TrainingBlock, PrimaryLift } from "@/lib/data/types";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import type { NextSessionPrescription } from "@/lib/coach/session-debrief/next-session-prescription";

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
  /** The engine's prescription for the next session of this type. The debrief
   *  reports these numbers verbatim — it never computes a load itself. */
  nextSession: NextSessionPrescription | null;
  /** From training_weeks.volume_signals — muscles whose set bump the engine
   *  withheld because prior bumps were not performed. Defaults to none. */
  volumeSignals?: Array<{ muscle: string; weekly_sets: number; mev: number; weekly_exposures: number }>;
};

export function composePrescription(
  input: ComposePrescriptionInput,
): WorkoutDebriefPayload["prescription"] {
  const { sessionType, lifts, volume, volumeSignals = [], nextSession } = input;
  const weight_changes: WorkoutDebriefPayload["prescription"]["weight_changes"] = [];

  // Every load comes from the engine's stored prescription. The debrief used
  // to re-derive these with `lift.tag === "PR"` standing in for the engine's
  // cleanliness check; those disagree whenever a PR is set while grinding, so
  // the card could display a weight the plan did not contain.
  const prescribedByName = new Map(
    (nextSession?.exercises ?? []).map((e) => [e.name.trim().toLowerCase(), e]),
  );

  const blockPhase =
    input.block != null
      ? evaluateBlockPhase({
          block: input.block,
          currentWorkingKg: null,
          recentProgressionRatePerWeek: null,
          todayIso: input.todayIso,
        })
      : null;

  for (const lift of lifts) {
    const prescribed = prescribedByName.get(lift.name.trim().toLowerCase());
    if (!prescribed) continue;               // not in next session — nothing to report
    if (prescribed.baseKg == null) continue; // bodyweight — never emit 0

    const liftKey = liftFromExerciseName(lift.name);
    const isBlockFocusLift =
      input.block != null && input.block.primary_lift != null && liftKey === input.block.primary_lift;
    const todayKg = lift.top_set_today.kg;

    let rationale: string;
    if (isBlockFocusLift && input.block != null && blockPhase != null) {
      switch (blockPhase) {
        case "consolidation":
          rationale = `Block target ${input.block.target_value} kg was hit at week ${input.block.target_hit_at_week}. Consolidation phase: hold ${prescribed.baseKg} kg, progress reps to ${prescribed.baseReps}. We do NOT push load further this block.`;
          break;
        case "off_pace": {
          const wLeft = weeksLeft(input.block, input.todayIso);
          const requiredRate = ((input.block.target_value ?? 0) - (todayKg ?? 0)) / Math.max(1, wLeft);
          rationale = `Block target ${input.block.target_value} kg is out of reach in remaining accumulation weeks (would require +${requiredRate.toFixed(1)} kg/wk vs normal progression). HOLD ${prescribed.baseKg} kg and accept — we renegotiate the target next block, not in mid-block.`;
          break;
        }
        case "deload_week":
          rationale = `Deload week — drop to ${prescribed.baseKg} kg (~0.80×) with halved sets.`;
          break;
        default:
          rationale =
            todayKg != null && prescribed.baseKg > todayKg
              ? `On pace for the block target. Take the step next session: ${prescribed.baseKg} kg.`
              : `Hold ${prescribed.baseKg} kg — last session didn't meet the prescribed RIR cleanly.`;
      }
    } else if (todayKg == null) {
      rationale = `Prescribed at ${prescribed.baseKg} kg × ${prescribed.baseReps} next session.`;
    } else if (prescribed.baseKg > todayKg) {
      rationale = `Stepping to ${prescribed.baseKg} kg next session — you owned ${todayKg} kg today.`;
    } else if (prescribed.baseKg < todayKg) {
      rationale = `Dropping to ${prescribed.baseKg} kg next session — the engine autoregulated after today's effort.`;
    } else {
      rationale = `Holding ${prescribed.baseKg} kg — hit the prescribed reps at target RIR before it steps.`;
    }

    weight_changes.push({ exercise: lift.name, new_kg: prescribed.baseKg, rationale });
  }

  const notes: string[] = [];
  if (nextSession == null) {
    notes.push(`Next ${sessionType} session isn't planned yet — no load changes to report.`);
  }
  const over = volume.filter((v) => v.status === "over_mrv");
  const near = volume.filter((v) => v.status === "approaching_mrv");
  const low = volume.filter((v) => v.status === "below_mev");

  if (over.length > 0) {
    notes.push(`Drop a set on ${over.map((v) => v.muscle).join(", ")} next session — over MRV.`);
  } else if (near.length > 0) {
    notes.push(`Cap volume on ${near.map((v) => v.muscle).join(", ")} next session — approaching MRV.`);
  }
  // A muscle carrying a withheld-bump signal must NOT be told to add sets —
  // that lever was already prescribed and not performed (migration 0054).
  // The remedy is another weekly exposure.
  const signalByMuscle = new Map(volumeSignals.map((s) => [s.muscle, s]));
  for (const v of low) {
    const sig = signalByMuscle.get(v.muscle);
    if (!sig) continue;
    notes.push(
      `${v.muscle} below MEV at ${sig.weekly_exposures} session${sig.weekly_exposures === 1 ? "" : "s"}/week — a second exposure is the fix, not more sets.`,
    );
  }
  const unsignalled = low.filter((v) => !signalByMuscle.has(v.muscle));
  if (unsignalled.length >= 2) {
    notes.push(`Volume is light on ${unsignalled.map((v) => v.muscle).join(", ")} this week — check session adherence.`);
  }

  return {
    next_session_date: nextSession?.date ?? null,
    weight_changes,
    notes,
    volume_signals: volumeSignals,
    plan_changes: [],
  };
}

function weeksLeft(block: TrainingBlock, todayIso: string): number {
  const today = new Date(todayIso + "T00:00:00Z").getTime();
  const end = new Date(block.end_date + "T00:00:00Z").getTime();
  return Math.max(1, Math.round((end - today) / (7 * 24 * 60 * 60 * 1000)));
}
