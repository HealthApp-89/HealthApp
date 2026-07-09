// lib/morning/state.ts
//
// Pure state-machine functions for the morning intake bot. Both the server
// (api/chat/morning/intake) and the client (MorningTrigger) call into these.
// Zero IO, zero clocks (clock injected) — fully deterministic, easy to test.
//
// State machine (one-tap card, spec 2026-07-10):
//   card outstanding (awaiting_feel) → one-shot all_good or batch submit
//   → awaiting_whoop → recommendation auto-fire flips to delivered.

import type { CheckinRow, IntakeState } from "@/lib/data/types";

/**
 * Decide what the morning bot should do on app-open.
 *
 * - `'fresh'` — no row for today; start from question 1 (or "still sick?" if
 *   yesterday was sick — resolved separately).
 * - `'resume_feel'` — today's row exists in awaiting_feel /
 *   awaiting_sickness_notes; reopen the panel to whatever the latest assistant
 *   message dictates.
 * - `'resume_whoop'` — Phase 1 done; plan parked waiting on WHOOP.
 * - `'still_sick_check'` — yesterday `sick=true`, no row yet today; first
 *   question is "still feeling sick?".
 * - `'skip'` — already delivered for today; bot stays closed.
 */
export type IntakeAction =
  | { action: "open"; mode: "fresh" | "resume_feel" | "resume_whoop" | "still_sick_check" }
  | { action: "skip" };

export function decideIntakeAction(
  yesterdayRow: Pick<CheckinRow, "sick"> | null,
  todayRow: Pick<CheckinRow, "intake_state"> | null,
): IntakeAction {
  if (!todayRow) {
    if (yesterdayRow?.sick) return { action: "open", mode: "still_sick_check" };
    return { action: "open", mode: "fresh" };
  }
  switch (todayRow.intake_state) {
    case "delivered":
    case "assembling_brief":
    case "brief_delivered":
      return { action: "skip" };
    case "brief_failed":
      return { action: "open", mode: "resume_whoop" };
    case "awaiting_whoop":
      return { action: "open", mode: "resume_whoop" };
    case "pending":
    case "awaiting_feel":
    case "awaiting_sickness_notes":
      return { action: "open", mode: "resume_feel" };
    default: {
      // Exhaustiveness guard. If a new IntakeState is added, the type system
      // flags this branch at compile time and we throw at runtime to surface
      // the mismatch instead of silently falling back.
      const _exhaustive: never = todayRow.intake_state;
      throw new Error(`unhandled intake_state: ${String(_exhaustive)}`);
    }
  }
}
