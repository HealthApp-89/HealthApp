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

type ComposePrescriptionInput = {
  sessionType: string;
  lifts: WorkoutDebriefPayload["lifts"];
  volume: WorkoutDebriefPayload["volume"];
  todayExercises: Array<{ name: string }>;
};

export function composePrescription(
  input: ComposePrescriptionInput,
): WorkoutDebriefPayload["prescription"] {
  const { sessionType, lifts, volume } = input;
  const planEntries = SESSION_PLANS[sessionType] ?? [];

  const weight_changes: WorkoutDebriefPayload["prescription"]["weight_changes"] = [];

  for (const lift of lifts) {
    if (lift.tag == null) continue;

    const planEntry = planEntries.find((p) => p.name.toLowerCase() === lift.name.toLowerCase());
    const step = planEntry?.increment?.step ?? 2.5; // default 2.5kg if no plan entry
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
