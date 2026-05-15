// lib/coach/weekly-review/compose-reconfirm.ts
//
// §3 of the weekly review. Detects discrepancies and emits chip prompts.
// Pure: takes the recap output (which already aggregated last week) and
// returns the reconfirm list. Each rule below has a stable `id` used as
// a key in reconfirm_responses jsonb on weekly_reviews.

import type { WeeklyReviewPayload } from "@/lib/data/types";

type ReconfirmOutput = WeeklyReviewPayload["reconfirm"];
type Recap = WeeklyReviewPayload["recap"];

export function composeReconfirm(args: {
  recap: Recap;
  /** From compose-targets (or intake fallback) — orchestrator passes. */
  proteinTargetG: number | null;
}): ReconfirmOutput {
  const out: ReconfirmOutput = [];

  // Rule 1: e1RM flat for 2 weeks on any big-four lift.
  for (const lift of args.recap.per_lift) {
    const hist = lift.e1rm_history_3wk;
    if (hist.length >= 2) {
      const last = hist[hist.length - 1];
      const prev = hist[hist.length - 2];
      if (prev > 0 && Math.abs(last - prev) / prev <= 0.015) {
        out.push({
          id: `e1rm_flat_${lift.lift.replace(/\W+/g, "_")}`,
          severity: "warn",
          rule_tag: "e1rm_flat_2wk",
          question: `${shortLift(lift.lift)} e1RM flat 2 weeks running. Form, fatigue, or programming?`,
          chips: [
            { value: "form", label: "Form" },
            { value: "fatigue", label: "Fatigue" },
            { value: "program", label: "Deload it" },
            { value: "discuss", label: "Explain in chat" },
          ],
        });
      }
    }
  }

  // Rule 2: protein gap > 10% of target.
  if (
    args.proteinTargetG != null &&
    args.recap.nutrition.protein_avg_g != null &&
    args.recap.nutrition.protein_avg_g < args.proteinTargetG * 0.9
  ) {
    const shortfall = Math.round(
      args.proteinTargetG - args.recap.nutrition.protein_avg_g,
    );
    out.push({
      id: "protein_gap",
      severity: "info",
      rule_tag: "protein_gap_>10pct",
      question: `Protein avg ${Math.round(args.recap.nutrition.protein_avg_g)}g vs ${args.proteinTargetG}g target — ${shortfall}g/day short. What got in the way?`,
      chips: [
        { value: "appetite", label: "Appetite low" },
        { value: "schedule", label: "Schedule" },
        { value: "preference", label: "Foods don't fit" },
        { value: "discuss", label: "Discuss" },
      ],
    });
  }

  // Rule 3: skipped sessions.
  if (args.recap.sessions_skipped.length > 0) {
    const days = args.recap.sessions_skipped.map((s) => s.day).join(", ");
    out.push({
      id: "sessions_skipped",
      severity:
        args.recap.sessions_skipped.length >= 2 ? "warn" : "info",
      rule_tag: "sessions_skipped",
      question: `Skipped ${days} this week — one-off, or a pattern?`,
      chips: [
        { value: "one_off", label: "One-off" },
        { value: "drop", label: "Drop the slot" },
        { value: "reschedule", label: "Move to another day" },
      ],
    });
  }

  // Rule 4: per-lift rep completion <90% for any big-four lift.
  for (const lift of args.recap.per_lift) {
    if (lift.reps_completed_pct != null && lift.reps_completed_pct < 0.9) {
      out.push({
        id: `rep_completion_${lift.lift.replace(/\W+/g, "_")}`,
        severity: "warn",
        rule_tag: "rep_completion_<90pct",
        question: `${shortLift(lift.lift)} hit ${Math.round(lift.reps_completed_pct * 100)}% of prescribed reps. Loading too heavy, fatigued, or form?`,
        chips: [
          { value: "load", label: "Too heavy" },
          { value: "fatigue", label: "Fatigued" },
          { value: "form", label: "Form" },
          { value: "discuss", label: "Discuss" },
        ],
      });
    }
  }

  return out;
}

function shortLift(name: string): string {
  return name.replace(/\s*\([^)]+\)/, "");
}
