// lib/training-weeks/apply-activity-layout.ts
//
// Shared persistence for the activity-aware layout: clear overrides on changed
// days, recompute session_prescriptions via prescribeWeek (which applies the
// tiered lighten), and upsert. Used by the apply-activity-layout route AND the
// commit_activity_adjustment chat tool. ALWAYS recomputes prescriptions — the
// lighten-only case (plan unchanged, planned_activities changed) must persist.

import type { SupabaseClient } from "@supabase/supabase-js";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { plansEqual } from "@/lib/training-weeks/apply-swap";
import { readSessionForDay, SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import type {
  ExerciseOverrides,
  SessionPlan,
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
  Weekday,
} from "@/lib/data/types";

const WEEKDAYS: ReadonlyArray<Weekday> = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TRAINING_WEEK_SELECT =
  "id, user_id, block_id, week_start, session_plan, original_session_plan, exercise_overrides, session_prescriptions, endurance_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";

export type ApplyActivityLayoutResult =
  | { ok: true; week: TrainingWeek; changedDays: Array<{ day: Weekday; before: string | null; after: string | null }> }
  | { ok: false; error: string; code: string };

export async function applyActivityLayout(opts: {
  supabase: SupabaseClient;
  userId: string;
  weekStart: string;
  proposedPlan: SessionPlan;
}): Promise<ApplyActivityLayoutResult> {
  const { supabase, userId, weekStart, proposedPlan } = opts;

  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select(TRAINING_WEEK_SELECT)
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message, code: "load_failed" };
  if (!row) return { ok: false, error: `no training_weeks row for ${weekStart}`, code: "no_week" };

  const current = row.session_plan as SessionPlan;
  const original = row.original_session_plan as SessionPlan | null;

  const changedShort: Weekday[] = [];
  const changedFull: string[] = [];
  for (const shortKey of WEEKDAYS) {
    const before = readSessionForDay(current as Record<string, string>, shortKey);
    const after = readSessionForDay(proposedPlan as Record<string, string>, shortKey);
    if (before !== after) {
      changedShort.push(shortKey);
      changedFull.push(SHORT_TO_FULL[shortKey]);
    }
  }

  // Clear exercise_overrides for any day whose session type changed.
  const currentOverrides = (row.exercise_overrides as ExerciseOverrides | null) ?? null;
  let nextOverrides: ExerciseOverrides | null = currentOverrides;
  if (currentOverrides && changedFull.length > 0) {
    const drop = changedFull.filter((k) => currentOverrides[k]);
    if (drop.length > 0) {
      const cleaned: ExerciseOverrides = { ...currentOverrides };
      for (const k of drop) delete cleaned[k];
      nextOverrides = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
  }

  const { data: blockRow } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const block = (blockRow as TrainingBlock | null) ?? null;

  const currentPrescriptions = (row.session_prescriptions as SessionPrescriptions | null) ?? null;
  let nextPrescriptions: SessionPrescriptions | null = currentPrescriptions;
  const workingRow: TrainingWeek = {
    ...(row as TrainingWeek),
    session_plan: proposedPlan,
    exercise_overrides: nextOverrides,
    session_prescriptions: currentPrescriptions,
  };
  try {
    const tz = await getUserTimezone(userId);
    const todayIso = todayInUserTz(new Date(), tz);
    nextPrescriptions = await prescribeWeek({ supabase, userId, block, week: workingRow, todayIso });
  } catch {
    // On recompute failure, clear changed days' stale entries (matches route).
    if (currentPrescriptions && changedFull.length > 0) {
      const cleared: SessionPrescriptions = { ...currentPrescriptions };
      for (const k of changedFull) delete cleared[k as keyof SessionPrescriptions];
      nextPrescriptions = Object.keys(cleared).length > 0 ? cleared : null;
    }
  }

  const isIdentityRestore = original !== null && plansEqual(proposedPlan, original);
  const update: Record<string, unknown> = {
    session_plan: proposedPlan,
    exercise_overrides: nextOverrides,
    session_prescriptions: nextPrescriptions,
    updated_at: new Date().toISOString(),
  };
  if (isIdentityRestore) update.original_session_plan = null;
  else if (original === null && changedFull.length > 0) update.original_session_plan = current;

  const { data: updated, error: updateErr } = await supabase
    .from("training_weeks")
    .update(update)
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .select(TRAINING_WEEK_SELECT)
    .single();
  if (updateErr || !updated) {
    return { ok: false, error: updateErr?.message ?? "no row returned", code: "update_failed" };
  }

  const changedDays = changedShort.map((shortKey) => ({
    day: shortKey,
    before: readSessionForDay(current as Record<string, string>, shortKey) ?? null,
    after: readSessionForDay(proposedPlan as Record<string, string>, shortKey) ?? null,
  }));
  return { ok: true, week: updated as TrainingWeek, changedDays };
}
