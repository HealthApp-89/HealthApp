// lib/coach/glossary.ts
//
// Canonical glossary for coach surfaces. Single source of truth for the
// terms used by the AI prompts (advice-prompt.ts TEACHER_TONE_RULES,
// narrative-prompt.ts TEACHING block) and the UI tooltips (JargonPill
// → TermSheet, GlossarySheet).
//
// Two dictionaries:
//   - CORE_TERMS       7 athlete-facing concepts that also appear in
//                      the AI prompts' always-define-on-first-use rule.
//   - RATIONALE_LABELS Periodization rationale tags emitted by
//                      compose-prescription.ts. UI-tooltip-only;
//                      never referenced in AI prompts.

export type CoreTermKey =
  | "mev"
  | "mav"
  | "mrv"
  | "deload"
  | "rir"
  | "e1rm"
  | "sleep_efficiency";

export type RationaleTagKey =
  | "mev_to_mav_clearance"
  | "mav_to_mav_step"
  | "mav_to_mrv_advance"
  | "mrv_volume_drive"
  | "deload_load_volume_cut"
  | "plateau_rep_shift"
  | "plateau_deload_reset"
  | "rep_completion_miss"
  | "rir_missed_twice"
  | "rir_missed"
  | "form_hold"
  | "cutting_hold"
  | "recovery_hold"
  | "block_start_baseline";

export type TermKey = CoreTermKey | RationaleTagKey;

export type GlossaryEntry = {
  label: string;
  short: string;
  plain: string;
};

export const CORE_TERMS: Record<CoreTermKey, GlossaryEntry> = {
  mev: {
    label: "MEV",
    short: "minimum weekly sets that drive growth",
    plain: "The smallest weekly set count that still produces muscle growth. Below this, you maintain but don't progress.",
  },
  mav: {
    label: "MAV",
    short: "the productive volume range",
    plain: "Maximum Adaptive Volume — the range of weekly sets that drives the most growth without overtraining. Most of your training time lives here.",
  },
  mrv: {
    label: "MRV",
    short: "your weekly recovery ceiling",
    plain: "Maximum Recoverable Volume — the most weekly sets you can do and still recover. Pushing past this stalls progress.",
  },
  deload: {
    label: "Deload",
    short: "a lighter week to absorb training",
    plain: "A planned light week — loads drop 10-15% and sets drop ~half. Lets your body cement the adaptations from the prior weeks.",
  },
  rir: {
    label: "RIR",
    short: "reps you could still do at the same weight",
    plain: "Reps In Reserve — how far from failure a set is. RIR 2 means you stopped with two more reps available.",
  },
  e1rm: {
    label: "e1RM",
    short: "estimated one-rep max from your top set",
    plain: "Estimated 1-rep max calculated from a set you actually did. Tracks strength over time without testing a true 1RM.",
  },
  sleep_efficiency: {
    label: "Sleep efficiency",
    short: "time actually asleep ÷ time in bed",
    plain: "What fraction of your bed time you spent asleep. Below ~85% suggests interrupted sleep even when total hours look fine.",
  },
};

export const RATIONALE_LABELS: Record<RationaleTagKey, GlossaryEntry> = {
  mev_to_mav_clearance: {
    label: "MEV → MAV",
    short: "cleared the introductory week",
    plain: "You hit your prescribed sets and reps in last week's MEV phase cleanly, so the program steps up to the more productive MAV range this week.",
  },
  mav_to_mav_step: {
    label: "MAV step",
    short: "small load bump inside the MAV range",
    plain: "Mid-MAV progression — a smaller load bump (~1.5%) inside the same volume tier. Lets you push without leaving the productive range.",
  },
  mav_to_mrv_advance: {
    label: "MAV → MRV",
    short: "stepping into peak weekly volume",
    plain: "Moving into the highest volume tier — MRV. Sets stay high; load creeps up; recovery cost is at its weekly ceiling.",
  },
  mrv_volume_drive: {
    label: "MRV · volume drive",
    short: "hold load, add a set",
    plain: "At MRV the program holds load and adds a working set. Pushing both weight and sets risks overtraining; volume is the lever here.",
  },
  deload_load_volume_cut: {
    label: "Deload · load + volume cut",
    short: "lighter weights, fewer sets",
    plain: "Deload week prescription — loads drop 10-15% AND sets drop ~half. Both knobs ease the systemic fatigue.",
  },
  plateau_rep_shift: {
    label: "Plateau · rep shift",
    short: "swap rep range to break a plateau",
    plain: "Three weeks of flat e1RM — before cutting weight, swap the rep range (5s ↔ 8s) to give the lift a fresh stimulus.",
  },
  plateau_deload_reset: {
    label: "Plateau · deload reset",
    short: "pull back to deload weight, restart phase",
    plain: "Rep-shift didn't break the plateau — pull this lift back to deload weight (-5%) and restart its phase cycle from MEV.",
  },
  rep_completion_miss: {
    label: "Reps missed",
    short: "you hit < 90% of prescribed reps",
    plain: "Your working sets fell short of the prescribed reps last week. Coach drops the load 2.5% to give you a chance to complete cleanly.",
  },
  rir_missed_twice: {
    label: "RIR missed × 2",
    short: "two weeks of overshoot — hold",
    plain: "Two consecutive weeks where you missed the RIR target by ≥2. Coach holds load and surfaces a question — fatigue, form, or programming?",
  },
  rir_missed: {
    label: "RIR missed",
    short: "one bad week — small step back",
    plain: "Last week's RIR target was missed by ≥2 reps. Coach drops the load 2.5% this week and watches for a clean repeat.",
  },
  form_hold: {
    label: "Form hold",
    short: "form note last week — hold load",
    plain: "You logged a form note for this lift last week. Coach holds load until form is clean.",
  },
  cutting_hold: {
    label: "Cutting hold",
    short: "losing > 0.7% BW/wk — defend, don't grow",
    plain: "You're dropping weight aggressively. In a deficit this size, the program holds strength rather than pushing — you defend gains, not grow them.",
  },
  recovery_hold: {
    label: "Recovery hold",
    short: "sleep or HRV flag — hold this week",
    plain: "Sleep < 6h or HRV is below baseline. Coach holds load until recovery normalizes.",
  },
  block_start_baseline: {
    label: "Block start",
    short: "first week of a new block",
    plain: "First week of this block — load comes from the block-setup baseline, not from last week's lift.",
  },
};

export const GLOSSARY: Record<TermKey, GlossaryEntry> = {
  ...CORE_TERMS,
  ...RATIONALE_LABELS,
};

/** Emit the always-define-jargon rule using CORE_TERMS only. Used by both
 *  advice-prompt.ts (TEACHER_TONE_RULES) and narrative-prompt.ts (TEACHING). */
export function jargonRuleForPrompt(): string {
  const lines = Object.values(CORE_TERMS).map(
    (entry) => `  - ${entry.label} → "${entry.short}"`,
  );
  return [
    "On first mention in this reply, define jargon in 5-10 words of plain English:",
    ...lines,
    "  If a term appears again later in the same reply, don't re-define.",
  ].join("\n");
}

/** Looks up a term entry; returns null if the key isn't in the dictionary.
 *  Used by JargonPill for the missing-entry fallback. */
export function getGlossaryEntry(key: string): GlossaryEntry | null {
  return (GLOSSARY as Record<string, GlossaryEntry>)[key] ?? null;
}

/** Strip the `_increment_floor` / `_increment_capped` suffixes that
 *  compose-prescription.ts may append to a rationale_tag. These suffixes
 *  document a physical-loading constraint but are not part of the glossary
 *  key — callers should strip before looking up entries. */
export function stripPrescriptionSuffix(tag: string): string {
  return tag.replace(/_increment_(floor|capped)$/, "");
}
