// lib/coach/weekly-review/read-prescription.ts
//
// Single seam for the weekly review to obtain next-week's deterministic
// prescription. Two-tier read:
//   1. Read training_weeks.session_prescriptions for next_week_start (the
//      Sunday cron at 03:30 UTC writes this 30 min before the weekly-review
//      cron at 04:00 UTC).
//   2. Fall through to prescribeWeek inline when the row is missing — keeps
//      the review robust if the cron failed or the user came up between blocks.
//
// Returns the canonical SessionPrescriptions shape. The payload-mapper
// downstream converts that into the per_lift array the WeeklyReviewPayload
// expects.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
} from "@/lib/data/types";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";

export type ReadPrescriptionResult = {
  prescription: SessionPrescriptions;
  /** "row" when read from training_weeks.session_prescriptions, "inline"
   *  when prescribeWeek was called as the fallback. Surfaced in the audit
   *  script + visible in observability. */
  source: "row" | "inline";
};

export async function readNextWeekPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  nextWeekStart: string;
  todayIso: string;
}): Promise<ReadPrescriptionResult> {
  const { supabase, userId, nextWeekStart, todayIso } = opts;

  const { data: row } = await supabase
    .from("training_weeks")
    .select("session_prescriptions")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();

  const stored = (row?.session_prescriptions as SessionPrescriptions | null) ?? null;
  if (stored && Object.keys(stored).length > 0) {
    return { prescription: stored, source: "row" };
  }

  // Fall-through: compute inline. Mirrors what upsert-week-prescription.ts
  // does — but read-only, no DB write, because the weekly-review composer
  // does not own the training_weeks row write path.
  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const block = (blocks as TrainingBlock | null) ?? null;

  // Need a working TrainingWeek row to drive prescribeWeek. Prefer the
  // existing nextWeekStart row when present (only session_prescriptions
  // empty, the rest may be set); otherwise seed from the prior week.
  let workingRow: TrainingWeek;
  const { data: existingRow } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();

  if (existingRow) {
    workingRow = existingRow as TrainingWeek;
  } else {
    const { data: priorRows } = await supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", userId)
      .lt("week_start", nextWeekStart)
      .order("week_start", { ascending: false })
      .limit(1);
    const prior = (priorRows?.[0] as TrainingWeek | undefined) ?? null;
    workingRow = {
      ...(prior ?? ({} as TrainingWeek)),
      id: "",
      user_id: userId,
      block_id: block?.id ?? null,
      week_start: nextWeekStart,
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

  return { prescription, source: "inline" };
}
