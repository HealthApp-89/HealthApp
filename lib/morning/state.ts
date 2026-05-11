// lib/morning/state.ts
//
// Pure state-machine functions for the morning intake bot. Both the server
// (api/chat/morning/intake) and the client (MorningTrigger) call into these.
// Zero IO, zero clocks (clock injected) — fully deterministic, easy to test.

import type { CheckinRow, IntakeState } from "@/lib/data/types";
import type { SlotKey } from "./script";

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

/**
 * Given a partial today row, return the next un-answered slot or 'tail' if
 * all chip slots are filled (LLM tail step) or 'done' if the LLM tail has
 * also been completed (caller then transitions to recommendation).
 *
 * Rules:
 * - readiness, energy_label, mood are required in order.
 * - soreness_gate is required next; if 'no', skip soreness_areas + severity.
 * - soreness_areas is required if soreness_gate=yes; severity follows.
 * - fatigue, bloating last.
 * - 'tail' returned when all chip slots above are populated and
 *   feel_notes is null. Tail is the free-text "anything else?" turn.
 * - 'done' returned when feel_notes is non-null (tail completed).
 *
 * The "soreness_gate" slot is virtual — there is no DB column for it. We
 * derive its answered-ness from the first non-null of {soreness_areas[0],
 * soreness_severity, soreness}. If the user said 'no', we record that by
 * setting soreness_areas=[] (empty array) so subsequent calls skip the
 * conditional slots.
 */
export type SlotProgress =
  | { kind: "slot"; key: SlotKey }
  | { kind: "tail" }
  | { kind: "done" };

export function nextSlot(
  row: Pick<
    CheckinRow,
    | "readiness"
    | "energy_label"
    | "mood"
    | "soreness_areas"
    | "soreness_severity"
    | "fatigue"
    | "bloating"
    | "feel_notes"
  >,
): SlotProgress {
  if (row.readiness == null)    return { kind: "slot", key: "readiness" };
  if (row.energy_label == null) return { kind: "slot", key: "energy_label" };
  if (row.mood == null)         return { kind: "slot", key: "mood" };

  // Gate: soreness_areas null → not asked yet. Empty array → user said 'no'.
  if (row.soreness_areas == null) return { kind: "slot", key: "soreness_gate" };

  if (row.soreness_areas.length > 0) {
    if (row.soreness_severity == null) return { kind: "slot", key: "soreness_severity" };
  }

  if (row.fatigue == null)  return { kind: "slot", key: "fatigue" };
  if (row.bloating == null) return { kind: "slot", key: "bloating" };

  if (row.feel_notes == null) return { kind: "tail" };
  return { kind: "done" };
}

/**
 * Given the current state and what the user just answered, return the next
 * intake_state value. Called by the route after persisting the slot value.
 * Never goes backwards.
 */
export function nextIntakeState(
  current: IntakeState,
  rowAfterUpdate: Pick<
    CheckinRow,
    | "sick"
    | "readiness"
    | "energy_label"
    | "mood"
    | "soreness_areas"
    | "soreness_severity"
    | "fatigue"
    | "bloating"
    | "feel_notes"
  >,
): IntakeState {
  if (rowAfterUpdate.sick) return "delivered"; // sick path short-circuits
  if (current === "delivered" || current === "awaiting_whoop") return current;
  const next = nextSlot(rowAfterUpdate);
  if (next.kind === "done") return "awaiting_whoop"; // tail completed; recommendation route flips to delivered
  return "awaiting_feel";
}

