// lib/coach/prescription/upsert-week-prescription.ts
//
// Single seam that converts prescribeWeek's deterministic output into a
// committed training_weeks row. Called by:
//   - the Sunday cron (/api/coach/sunday-prescriptions/sync), once per
//     active-block user, for next_week_start
//   - the get_week_prescription chat tool, on demand for {current|next}
//   - executeCommitWeekPlan, as the last write step (so the row stored is
//     the engine's verdict, not Carter's narration)
//
// Single seam = single set of invariants:
//   * session_prescriptions is ALWAYS the freshly-computed prescribeWeek
//     output. Never accepts a Carter-supplied payload.
//   * Other training_weeks columns (session_plan, rir_target, etc.) are
//     preserved when the row already exists, or seeded from the prior week
//     when creating a new row.
//   * Idempotent on (user_id, week_start) via upsert.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
  WeekdayLong,
} from "@/lib/data/types";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";

export type UpsertWeekPrescriptionResult = {
  week_start: string;
  block_id: string | null;
  session_prescriptions: SessionPrescriptions;
  /** True when a fresh training_weeks row was inserted; false when an
   *  existing row was updated. The caller can use this to decide whether
   *  to emit a "first prescription written" event downstream. */
  inserted: boolean;
};

export async function upsertWeekPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  /** Monday (UTC) of the week being prescribed. */
  weekStart: string;
  /** Today's ISO date in the user's TZ — drives block-phase week-of-block
   *  math. Passed in rather than computed so the function stays pure-ish
   *  and easily testable. */
  todayIso: string;
}): Promise<UpsertWeekPrescriptionResult> {
  const { supabase, userId, weekStart, todayIso } = opts;

  // Active block (may be null — non-block weeks still get a prescription so
  // the logger has somewhere to read from; just no phase-aware progression).
  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const block = (blocks as TrainingBlock | null) ?? null;

  // Existing row for this week (if any) — preserve session_plan, focus,
  // rir_target etc. so the cron doesn't clobber Carter's label decisions.
  const { data: existingRows } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  const existing = (existingRows as TrainingWeek | null) ?? null;

  // When no existing row, seed session_plan from the most recent committed
  // week — that gives the cron a reasonable starting point so prescribeWeek
  // has weekday labels to walk. Carter can later overwrite via the regular
  // propose_week_plan flow.
  let workingRow: TrainingWeek;
  if (existing) {
    workingRow = existing;
  } else {
    const { data: priorRows } = await supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", userId)
      .lt("week_start", weekStart)
      .order("week_start", { ascending: false })
      .limit(1);
    const prior = (priorRows?.[0] as TrainingWeek | undefined) ?? null;
    // Synthetic working row — prescribeWeek only reads session_plan +
    // rir_target. block_id/id/etc. are filled in by the upsert below.
    workingRow = {
      ...(prior ?? ({} as TrainingWeek)),
      id: "",
      user_id: userId,
      block_id: block?.id ?? null,
      week_start: weekStart,
      session_plan: prior?.session_plan ?? {},
      original_session_plan: null,
      exercise_overrides: null,
      session_prescriptions: null,
      weekly_focus: prior?.weekly_focus ?? null,
      intensity_modifier: prior?.intensity_modifier ?? {},
      rir_target: prior?.rir_target ?? null,
      research_phase: prior?.research_phase ?? null,
      proposed_by: "coach",
      chat_message_id: null,
      endurance_session_plan: prior?.endurance_session_plan ?? null,
      committed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const prescription = await prescribeWeek({
    supabase,
    userId,
    block,
    week: workingRow,
    todayIso,
  });

  // Upsert: keep existing columns when row exists, only overwrite
  // session_prescriptions (and refresh updated_at). When creating, fill in
  // session_plan from the synthetic working row.
  const upsertPayload: Record<string, unknown> = {
    user_id: userId,
    week_start: weekStart,
    session_prescriptions: prescription,
    updated_at: new Date().toISOString(),
  };
  if (!existing) {
    upsertPayload.block_id = block?.id ?? null;
    upsertPayload.session_plan = workingRow.session_plan;
    upsertPayload.weekly_focus = workingRow.weekly_focus;
    upsertPayload.intensity_modifier = workingRow.intensity_modifier ?? {};
    upsertPayload.rir_target = workingRow.rir_target;
    upsertPayload.research_phase = workingRow.research_phase;
    upsertPayload.proposed_by = "coach";
    upsertPayload.endurance_session_plan = workingRow.endurance_session_plan;
    upsertPayload.committed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("training_weeks")
    .upsert(upsertPayload, { onConflict: "user_id,week_start" });
  if (error) throw error;

  return {
    week_start: weekStart,
    block_id: block?.id ?? null,
    session_prescriptions: prescription,
    inserted: !existing,
  };
}

/** Helper: weekday names for callers that need to walk a SessionPrescriptions
 *  result in display order (Monday-first). */
export const WEEKDAY_LONG_ORDER: ReadonlyArray<WeekdayLong> = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
